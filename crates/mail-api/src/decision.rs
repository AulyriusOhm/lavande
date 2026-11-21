//! Modèle de décision (Système 1) : configuration, appels HTTP SystemOne / Jev
//! (NeuralWatt, Baseten, Jev, vLLM auto-hébergé), triage unitaire et cache SQLite.
//!
//! La clé API vit uniquement dans le trousseau sécurisé du démon (`ai:decision`),
//! jamais dans `decision.json` et jamais renvoyée au front.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::time::{Duration, Instant};

use chrono::Utc;
use lavande_mail::model::Message;
use lavande_mail::store::MailDecision;
use lavande_mail::tls::TlsOptions;
use lavande_mail::totp;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::private_file;
use crate::state::AppState;

pub const CONFIG_FILE: &str = "decision.json";
pub const SECRET_ID: &str = "ai:decision";
pub const TRIAGE_SCHEMA_VERSION: i64 = 1;

pub const NEURALWATT_ENDPOINT: &str = "https://api.neuralwatt.com/v1/systemone";
pub const BASETEN_ENDPOINT: &str = "https://inference.baseten.co/v1/systemone";
pub const JEV_ENDPOINT: &str = "https://api.typesafe.ai/v1/decide";

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_STATE_BODY_CHARS: usize = 1600;
const MAX_CUSTOM_CATEGORIES: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DecisionProvider {
    #[default]
    Neuralwatt,
    Baseten,
    Jev,
    Custom,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DecisionProtocol {
    #[default]
    Systemone,
    Jev,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DecisionAuthHeader {
    #[default]
    Bearer,
    ApiKey,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum NotifFilterMode {
    #[default]
    All,
    Smart,
    UrgentOnly,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DecisionThresholds {
    #[serde(default = "default_llm_escalate")]
    pub llm_escalate: f64,
    #[serde(default = "default_category_threshold")]
    pub category: f64,
    #[serde(default = "default_security_threshold")]
    pub security: f64,
    #[serde(default = "default_folder_threshold")]
    pub folder: f64,
}

fn default_llm_escalate() -> f64 {
    0.55
}
fn default_category_threshold() -> f64 {
    0.70
}
fn default_security_threshold() -> f64 {
    0.80
}
fn default_folder_threshold() -> f64 {
    0.85
}

impl Default for DecisionThresholds {
    fn default() -> Self {
        Self {
            llm_escalate: default_llm_escalate(),
            category: default_category_threshold(),
            security: default_security_threshold(),
            folder: default_folder_threshold(),
        }
    }
}

impl DecisionThresholds {
    pub fn clamped(self) -> Self {
        Self {
            llm_escalate: self.llm_escalate.clamp(0.1, 0.99),
            category: self.category.clamp(0.1, 0.99),
            security: self.security.clamp(0.3, 0.99),
            folder: self.folder.clamp(0.3, 0.99),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomCategory {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(default = "default_category_color")]
    pub color: String,
    #[serde(default)]
    pub exclude_from_priority: bool,
    #[serde(default = "default_true")]
    pub allow_notifications: bool,
    #[serde(default)]
    pub cleanup_eligible: bool,
}

fn default_category_color() -> String {
    "accent".to_string()
}

fn default_true() -> bool {
    true
}

fn default_inbox_filter() -> String {
    "all".to_string()
}

fn default_endpoint() -> String {
    NEURALWATT_ENDPOINT.to_string()
}

fn default_model() -> String {
    "mammoth-1".to_string()
}

/// Configuration persistée dans `decision.json` (sans clé API).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DecisionConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub provider: DecisionProvider,
    #[serde(default)]
    pub protocol: DecisionProtocol,
    #[serde(default = "default_endpoint")]
    pub endpoint: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default)]
    pub auth_header: DecisionAuthHeader,
    #[serde(default)]
    pub thresholds: DecisionThresholds,
    #[serde(default)]
    pub custom_categories: Vec<CustomCategory>,
    #[serde(default = "default_inbox_filter")]
    pub default_inbox_filter: String,
    #[serde(default)]
    pub notif_mode: NotifFilterMode,
    #[serde(default = "default_true")]
    pub pre_send_guard: bool,
    #[serde(default = "default_true")]
    pub totp_popup: bool,
}

impl Default for DecisionConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: DecisionProvider::Neuralwatt,
            protocol: DecisionProtocol::Systemone,
            endpoint: default_endpoint(),
            model: default_model(),
            auth_header: DecisionAuthHeader::Bearer,
            thresholds: DecisionThresholds::default(),
            custom_categories: Vec::new(),
            default_inbox_filter: default_inbox_filter(),
            notif_mode: NotifFilterMode::All,
            pre_send_guard: true,
            totp_popup: true,
        }
    }
}

impl DecisionConfig {
    pub fn normalized(mut self) -> Self {
        self.endpoint = self.endpoint.trim().to_string();
        self.model = self.model.trim().to_string();
        self.thresholds = self.thresholds.clamped();
        self.custom_categories.truncate(MAX_CUSTOM_CATEGORIES);
        self.custom_categories.retain(|c| {
            !c.id.trim().is_empty() && !c.name.trim().is_empty() && !c.description.trim().is_empty()
        });
        if self.default_inbox_filter.trim().is_empty() {
            self.default_inbox_filter = default_inbox_filter();
        }
        self
    }

    pub fn is_ready(&self, has_api_key: bool) -> bool {
        self.enabled
            && !self.endpoint.trim().is_empty()
            && !self.model.trim().is_empty()
            && (self.auth_header == DecisionAuthHeader::None || has_api_key)
    }
}

/// Vue publique renvoyée au front : jamais la clé API, seulement un booléen.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PublicDecisionConfig {
    #[serde(flatten)]
    pub config: DecisionConfig,
    pub has_api_key: bool,
    pub ready: bool,
}

/// Mise à jour de la config depuis les réglages : la clé API (si fournie) part
/// dans le trousseau sécurisé.
#[derive(Clone, Debug, Deserialize)]
pub struct UpdateDecisionConfig {
    #[serde(flatten)]
    pub config: DecisionConfig,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub clear_api_key: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DecisionQuestion {
    Choice {
        instructions: String,
        criteria: BTreeMap<String, String>,
    },
    Noul {
        instructions: String,
    },
    Score {
        instructions: String,
        criteria: Vec<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DecisionAnswer {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub noul: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub probabilities: HashMap<String, f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DecisionEnergy {
    #[serde(default)]
    pub energy_joules: f64,
    #[serde(default)]
    pub energy_kwh: f64,
    #[serde(default)]
    pub avg_power_watts: f64,
    #[serde(default)]
    pub duration_seconds: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DecisionOutput {
    pub model: String,
    pub answers: HashMap<String, DecisionAnswer>,
    pub usage: DecisionUsage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub energy: Option<DecisionEnergy>,
    pub latency_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Default)]
pub struct ProbeRequest {
    #[serde(default)]
    pub provider: Option<DecisionProvider>,
    #[serde(default)]
    pub protocol: Option<DecisionProtocol>,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub auth_header: Option<DecisionAuthHeader>,
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProbeResponse {
    pub ok: bool,
    pub model: String,
    pub latency_ms: u64,
    pub answer: f64,
    pub usage: DecisionUsage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub energy: Option<DecisionEnergy>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TriageOutcome {
    pub decision: MailDecision,
    pub cached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<DecisionUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub energy: Option<DecisionEnergy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
}

pub fn load_config(path: &Path) -> Result<DecisionConfig, ApiError> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<DecisionConfig>(&bytes)
            .map(DecisionConfig::normalized)
            .map_err(|error| {
                ApiError::internal(
                    "config",
                    format!("{} est illisible : {error}", path.display()),
                )
            }),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(DecisionConfig::default()),
        Err(error) => Err(ApiError::internal(
            "config",
            format!("lecture de {} : {error}", path.display()),
        )),
    }
}

pub fn save_config(path: &Path, config: &DecisionConfig) -> Result<(), ApiError> {
    let bytes = serde_json::to_vec_pretty(config).map_err(|error| {
        ApiError::internal(
            "config",
            format!("sérialisation de la config décision : {error}"),
        )
    })?;
    private_file::write_private(path, &bytes)
}

fn build_http_client(tls: &TlsOptions, timeout: Duration) -> Result<Client, ApiError> {
    let mut builder = Client::builder().timeout(timeout);
    if !tls.extra_roots_pem.is_empty() {
        for pem in &tls.extra_roots_pem {
            if let Ok(cert) = reqwest::Certificate::from_pem(pem) {
                builder = builder.add_root_certificate(cert);
            }
        }
    }
    builder
        .build()
        .map_err(|error| ApiError::internal("decision", format!("client HTTP : {error}")))
}

fn auth_header_value(
    kind: DecisionAuthHeader,
    api_key: Option<&str>,
) -> Result<Option<String>, ApiError> {
    match kind {
        DecisionAuthHeader::None => Ok(None),
        DecisionAuthHeader::Bearer => {
            let key = api_key
                .map(str::trim)
                .filter(|k| !k.is_empty())
                .ok_or_else(|| {
                    ApiError::conflict("decision", "Clé API du modèle de décision manquante")
                })?;
            Ok(Some(format!("Bearer {key}")))
        }
        DecisionAuthHeader::ApiKey => {
            let key = api_key
                .map(str::trim)
                .filter(|k| !k.is_empty())
                .ok_or_else(|| {
                    ApiError::conflict("decision", "Clé API du modèle de décision manquante")
                })?;
            Ok(Some(format!("Api-Key {key}")))
        }
    }
}

/// Exécute un appel vers le modèle de décision (SystemOne ou Jev).
pub async fn decide_with_config(
    tls: &TlsOptions,
    config: &DecisionConfig,
    api_key: Option<&str>,
    state_payload: Value,
    questions: BTreeMap<String, DecisionQuestion>,
    timeout: Duration,
) -> Result<DecisionOutput, ApiError> {
    let endpoint = config.endpoint.trim();
    let model = config.model.trim();
    if endpoint.is_empty() || model.is_empty() {
        return Err(ApiError::bad_request(
            "decision",
            "Endpoint et modèle de décision requis",
        ));
    }
    let auth = auth_header_value(config.auth_header, api_key)?;
    let client = build_http_client(tls, timeout)?;

    let body = json!({
        "model": model,
        "state": state_payload,
        "questions": questions,
    });

    let started = Instant::now();
    let mut req = client
        .post(endpoint)
        .header("content-type", "application/json")
        .header("accept", "application/json");
    if let Some(header_val) = auth {
        req = req.header("authorization", header_val);
    }

    let response = req
        .body(
            serde_json::to_vec(&body).map_err(|error| {
                ApiError::internal("decision", format!("sérialisation : {error}"))
            })?,
        )
        .send()
        .await
        .map_err(|error| {
            ApiError::transport(
                "decision",
                format!("modèle de décision injoignable : {error}"),
            )
        })?;

    let latency_ms = started.elapsed().as_millis() as u64;
    let status = response.status();
    let raw_bytes = response.bytes().await.map_err(|error| {
        ApiError::transport("decision", format!("lecture réponse décision : {error}"))
    })?;

    if !status.is_success() {
        let snippet = String::from_utf8_lossy(&raw_bytes);
        let detail = snippet.trim().chars().take(200).collect::<String>();
        return Err(ApiError::gateway(
            "decision",
            if detail.is_empty() {
                format!("Le modèle de décision a répondu {}", status.as_u16())
            } else {
                format!(
                    "Le modèle de décision a répondu {} · {detail}",
                    status.as_u16()
                )
            },
        ));
    }

    parse_decision_response(&raw_bytes, model, latency_ms)
}

/// Parse indifféremment une réponse NeuralWatt (`/v1/systemone`), Baseten/vLLM
/// (`/v1/systemone`) ou Jev (`/v1/decide`).
pub fn parse_decision_response(
    raw_bytes: &[u8],
    fallback_model: &str,
    latency_ms: u64,
) -> Result<DecisionOutput, ApiError> {
    let payload: Value = serde_json::from_slice(raw_bytes).map_err(|error| {
        ApiError::gateway("decision", format!("réponse JSON invalide : {error}"))
    })?;

    let model = payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback_model)
        .to_string();

    let answers_obj = payload
        .get("answers")
        .or_else(|| payload.get("decisions"))
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ApiError::gateway(
                "decision",
                "réponse inattendue du modèle de décision : champ « answers » absent",
            )
        })?;

    let mut answers = HashMap::with_capacity(answers_obj.len());
    for (key, value) in answers_obj {
        if let Some(parsed) = parse_answer(value) {
            answers.insert(key.clone(), parsed);
        }
    }

    let usage = parse_usage(payload.get("usage"));
    let energy = payload
        .get("energy")
        .and_then(|v| serde_json::from_value::<DecisionEnergy>(v.clone()).ok());

    Ok(DecisionOutput {
        model,
        answers,
        usage,
        energy,
        latency_ms,
    })
}

fn parse_answer(value: &Value) -> Option<DecisionAnswer> {
    if let Some(prob) = value.as_f64() {
        return Some(DecisionAnswer {
            kind: "noul".to_string(),
            choice: None,
            noul: Some(prob.clamp(0.0, 1.0)),
            score: None,
            probabilities: HashMap::new(),
            confidence: None,
        });
    }
    let obj = value.as_object()?;
    let kind = obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            if obj.contains_key("choice") {
                "choice"
            } else if obj.contains_key("score") {
                "score"
            } else {
                "noul"
            }
        })
        .to_string();

    let choice = obj
        .get("choice")
        .or_else(|| obj.get("value"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let noul = obj
        .get("noul")
        .or_else(|| obj.get("probability"))
        .and_then(Value::as_f64)
        .map(|v| v.clamp(0.0, 1.0));
    let score = obj.get("score").and_then(Value::as_f64);
    let confidence = obj
        .get("confidence")
        .and_then(Value::as_f64)
        .map(|v| v.clamp(0.0, 1.0));
    let mut probabilities = HashMap::new();
    if let Some(map) = obj.get("probabilities").and_then(Value::as_object) {
        for (k, v) in map {
            if let Some(p) = v.as_f64() {
                probabilities.insert(k.clone(), p.clamp(0.0, 1.0));
            }
        }
    }
    Some(DecisionAnswer {
        kind,
        choice,
        noul,
        score,
        probabilities,
        confidence,
    })
}

fn parse_usage(raw: Option<&Value>) -> DecisionUsage {
    let Some(obj) = raw.and_then(Value::as_object) else {
        return DecisionUsage::default();
    };
    let prompt_tokens = obj
        .get("prompt_tokens")
        .or_else(|| obj.get("input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let completion_tokens = obj
        .get("completion_tokens")
        .or_else(|| obj.get("output_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    DecisionUsage {
        prompt_tokens,
        completion_tokens,
    }
}

/// Test rapide depuis les réglages : un aller-retour `noul` minimal.
pub async fn probe(state: &AppState, req: ProbeRequest) -> Result<ProbeResponse, ApiError> {
    let mut config = state.decision_config()?;
    if let Some(provider) = req.provider {
        config.provider = provider;
    }
    if let Some(protocol) = req.protocol {
        config.protocol = protocol;
    }
    if let Some(endpoint) = req.endpoint.filter(|s| !s.trim().is_empty()) {
        config.endpoint = endpoint.trim().to_string();
    }
    if let Some(model) = req.model.filter(|s| !s.trim().is_empty()) {
        config.model = model.trim().to_string();
    }
    if let Some(auth_header) = req.auth_header {
        config.auth_header = auth_header;
    }
    let stored_key = state.decision_api_key().await?;
    let api_key = req
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(stored_key.as_deref());

    let mut questions = BTreeMap::new();
    questions.insert(
        "urgent".to_string(),
        DecisionQuestion::Noul {
            instructions: "Is this an urgent production outage?".to_string(),
        },
    );

    let output = decide_with_config(
        state.tls(),
        &config,
        api_key,
        Value::String(
            "Checkout has been failing for every customer for the last hour.".to_string(),
        ),
        questions,
        PROBE_TIMEOUT,
    )
    .await?;

    let answer = output
        .answers
        .get("urgent")
        .and_then(|a| a.noul)
        .unwrap_or(0.0);

    Ok(ProbeResponse {
        ok: true,
        model: output.model,
        latency_ms: output.latency_ms,
        answer,
        usage: output.usage,
        energy: output.energy,
    })
}

/// Empreinte déterministe du mail + catégories custom + équipe : tant qu'elle ne
/// change pas, le cache SQLite évite tout nouvel appel réseau.
pub fn content_hash(message: &Message, config: &DecisionConfig, team_members: &[String]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(message.from.email.as_bytes());
    hasher.update(b"|");
    if let Some(name) = &message.from.name {
        hasher.update(name.as_bytes());
    }
    hasher.update(b"|");
    hasher.update(message.subject.as_bytes());
    hasher.update(b"|");
    hasher.update(message.preview.as_bytes());
    hasher.update(b"|cats:");
    for cat in &config.custom_categories {
        hasher.update(cat.id.as_bytes());
        hasher.update(b":");
        hasher.update(cat.description.as_bytes());
        hasher.update(b";");
    }
    hasher.update(b"|team:");
    for member in team_members {
        hasher.update(member.as_bytes());
        hasher.update(b",");
    }
    let digest = hasher.finalize();
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

pub fn build_triage_questions(
    config: &DecisionConfig,
    team_members: &[String],
) -> BTreeMap<String, DecisionQuestion> {
    let mut criteria = BTreeMap::new();
    criteria.insert(
        "important".to_string(),
        "Message humain ou professionnel important nécessitant attention ou suivi".to_string(),
    );
    criteria.insert(
        "info".to_string(),
        "Information humaine ou utile à lire sans urgence immédiate".to_string(),
    );
    criteria.insert(
        "auth_totp".to_string(),
        "Code de vérification, OTP, TOTP, 2FA, lien magique de connexion ou confirmation de compte"
            .to_string(),
    );
    criteria.insert(
        "notification".to_string(),
        "Notification automatique de service, suivi de commande, reçu ou alerte système"
            .to_string(),
    );
    criteria.insert(
        "promo".to_string(),
        "Publicité, offre commerciale, marketing ou newsletter promotionnelle".to_string(),
    );
    criteria.insert(
        "spam".to_string(),
        "Courrier indésirable, démarchage agressif ou message non sollicité".to_string(),
    );
    for cat in &config.custom_categories {
        let key = format!("custom:{}", cat.id.trim());
        criteria.insert(
            key,
            format!("{} — {}", cat.name.trim(), cat.description.trim()),
        );
    }

    let mut questions = BTreeMap::new();
    questions.insert(
        "category".to_string(),
        DecisionQuestion::Choice {
            instructions: "Classe cet email dans la catégorie principale la plus pertinente."
                .to_string(),
            criteria,
        },
    );
    questions.insert(
        "urgency".to_string(),
        DecisionQuestion::Score {
            instructions: "Évalue le niveau d'urgence de cet email pour le destinataire."
                .to_string(),
            criteria: vec![
                "Faible".to_string(),
                "Normale".to_string(),
                "Haute".to_string(),
                "Critique".to_string(),
            ],
        },
    );
    questions.insert(
        "needs_reply".to_string(),
        DecisionQuestion::Noul {
            instructions: "L'expéditeur attend-il une réponse personnelle du destinataire ?"
                .to_string(),
        },
    );
    questions.insert(
        "has_task".to_string(),
        DecisionQuestion::Noul {
            instructions:
                "Ce mail demande-t-il une action concrète ou une tâche à effectuer par le destinataire ?"
                    .to_string(),
        },
    );
    questions.insert(
        "has_event".to_string(),
        DecisionQuestion::Noul {
            instructions:
                "Ce mail propose-t-il, confirme-t-il ou modifie-t-il un rendez-vous ou événement daté ?"
                    .to_string(),
        },
    );

    let mut security_criteria = BTreeMap::new();
    security_criteria.insert(
        "safe".to_string(),
        "Email légitime sans signe d'attaque ni manipulation".to_string(),
    );
    security_criteria.insert(
        "phishing".to_string(),
        "Tentative d'hameçonnage, usurpation d'identité, faux lien bancaire ou de connexion"
            .to_string(),
    );
    security_criteria.insert(
        "prompt_injection".to_string(),
        "Tentative d'injecter des instructions cachées visant à manipuler un assistant IA"
            .to_string(),
    );
    questions.insert(
        "security".to_string(),
        DecisionQuestion::Choice {
            instructions: "Évalue le risque de sécurité de cet email.".to_string(),
            criteria: security_criteria,
        },
    );

    questions.insert(
        "cleanup_candidate".to_string(),
        DecisionQuestion::Noul {
            instructions:
                "Ce mail est-il éphémère ou jetable (publicité, code temporaire, notification automatique, confirmation d'inscription) ?"
                    .to_string(),
        },
    );

    if !team_members.is_empty() {
        let mut team_criteria = BTreeMap::new();
        team_criteria.insert(
            "moi".to_string(),
            "Concerne directement le destinataire principal".to_string(),
        );
        team_criteria.insert(
            "aucun".to_string(),
            "Aucune attribution d'équipe évidente".to_string(),
        );
        for member in team_members.iter().take(12) {
            let trimmed = member.trim();
            if !trimmed.is_empty() {
                team_criteria.insert(trimmed.to_string(), format!("À traiter par {trimmed}"));
            }
        }
        questions.insert(
            "assignee".to_string(),
            DecisionQuestion::Choice {
                instructions: "À qui attribuer ce message au sein de l'équipe ?".to_string(),
                criteria: team_criteria,
            },
        );
    }

    questions
}

fn mail_state_payload(message: &Message) -> Value {
    let body = message
        .body_text
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(message.preview.as_str());
    let excerpt: String = body.chars().take(MAX_STATE_BODY_CHARS).collect();
    let sender = match message.from.name.as_deref().map(str::trim) {
        Some(name) if !name.is_empty() => format!("{name} <{}>", message.from.email),
        _ => message.from.email.clone(),
    };
    json!({
        "from": sender,
        "subject": message.subject,
        "date": message.date.map(|d| d.to_rfc3339()).unwrap_or_default(),
        "has_attachment": !message.attachments.is_empty(),
        "answered": message.flags.answered,
        "excerpt": excerpt,
    })
}

/// Trie un message avec le modèle de décision (ou renvoie le cache SQLite à jour).
pub async fn triage_message(
    state: &AppState,
    message: &Message,
    team_members: &[String],
    force: bool,
) -> Result<TriageOutcome, ApiError> {
    triage_message_with_timeout(state, message, team_members, force, DEFAULT_TIMEOUT).await
}

/// Variante de `triage_message` avec délai d'attente explicite (ex. veille IMAP IDLE).
pub async fn triage_message_with_timeout(
    state: &AppState,
    message: &Message,
    team_members: &[String],
    force: bool,
    timeout: Duration,
) -> Result<TriageOutcome, ApiError> {
    let config = state.decision_config()?;
    let api_key = state.decision_api_key().await?;
    if !config.is_ready(api_key.is_some()) {
        return Err(ApiError::conflict(
            "decision",
            "Modèle de décision non configuré ou désactivé",
        ));
    }

    let hash = content_hash(message, &config, team_members);
    if !force {
        if let Some(existing) =
            state
                .store()
                .get_decision(&message.account_id, &message.folder_path, message.uid)?
        {
            if existing.content_hash == hash && existing.schema_version == TRIAGE_SCHEMA_VERSION {
                return Ok(TriageOutcome {
                    decision: existing,
                    cached: true,
                    usage: None,
                    energy: None,
                    latency_ms: None,
                });
            }
        }
    }

    let questions = build_triage_questions(&config, team_members);
    let output = decide_with_config(
        state.tls(),
        &config,
        api_key.as_deref(),
        mail_state_payload(message),
        questions,
        timeout,
    )
    .await?;

    let category_ans = output.answers.get("category");
    let category = category_ans
        .and_then(|a| a.choice.clone())
        .unwrap_or_else(|| "info".to_string());
    let category_probs = category_ans
        .map(|a| a.probabilities.clone())
        .unwrap_or_default();
    let category_conf = category_probs
        .get(&category)
        .copied()
        .or_else(|| category_ans.and_then(|a| a.confidence))
        .unwrap_or(0.5);

    let urgency = output
        .answers
        .get("urgency")
        .and_then(|a| a.score)
        .unwrap_or(1.0);
    let needs_reply = output
        .answers
        .get("needs_reply")
        .and_then(|a| a.noul)
        .unwrap_or(0.0);
    let has_task = output
        .answers
        .get("has_task")
        .and_then(|a| a.noul)
        .unwrap_or(0.0);
    let has_event = output
        .answers
        .get("has_event")
        .and_then(|a| a.noul)
        .unwrap_or(0.0);

    let security_ans = output.answers.get("security");
    let security = security_ans
        .and_then(|a| a.choice.clone())
        .unwrap_or_else(|| "safe".to_string());
    let security_conf = security_ans
        .and_then(|a| a.probabilities.get(&security).copied())
        .or_else(|| security_ans.and_then(|a| a.confidence))
        .unwrap_or(0.5);

    let cleanup_score = output
        .answers
        .get("cleanup_candidate")
        .and_then(|a| a.noul)
        .unwrap_or(0.0);

    let (assignee, assignee_conf) = match output.answers.get("assignee") {
        Some(ans) => {
            let pick = ans.choice.clone().filter(|v| v != "aucun");
            let conf = pick
                .as_deref()
                .and_then(|p| ans.probabilities.get(p).copied())
                .or(ans.confidence);
            (pick, conf)
        }
        None => (None, None),
    };

    // Extraction TOTP déterministe si le modèle classe le mail en `auth_totp`.
    let totp_prob = category_probs.get("auth_totp").copied().unwrap_or(0.0);
    let is_totp = category == "auth_totp" || totp_prob >= config.thresholds.category;
    let totp_found = if is_totp {
        let body = message
            .body_text
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(message.preview.as_str());
        totp::extract_totp(
            message.from.name.as_deref(),
            &message.from.email,
            &message.subject,
            body,
        )
    } else {
        None
    };

    let decision = MailDecision {
        account_id: message.account_id.clone(),
        folder_path: message.folder_path.clone(),
        uid: message.uid,
        message_id: message.message_id.clone(),
        content_hash: hash,
        schema_version: TRIAGE_SCHEMA_VERSION,
        model: output.model,
        category,
        category_conf,
        category_probs,
        urgency,
        needs_reply,
        has_task,
        has_event,
        security,
        security_conf,
        cleanup_score,
        assignee,
        assignee_conf,
        totp_code: totp_found.as_ref().map(|t| t.code.clone()),
        totp_service: totp_found.as_ref().map(|t| t.service.clone()),
        suggested_folder: None,
        suggested_folder_conf: None,
        decided_at: Utc::now().timestamp(),
        source: "local".to_string(),
    };

    state.store().upsert_decision(&decision)?;

    Ok(TriageOutcome {
        decision,
        cached: false,
        usage: Some(output.usage),
        energy: output.energy,
        latency_ms: Some(output.latency_ms),
    })
}

/// Détermine si un mail trié doit déclencher une notification système selon le
/// mode de filtrage configuré.
pub fn should_notify(config: &DecisionConfig, decision: &MailDecision) -> bool {
    match config.notif_mode {
        NotifFilterMode::All => true,
        NotifFilterMode::UrgentOnly => {
            decision.totp_code.is_some()
                || decision.category == "auth_totp"
                || decision.urgency >= 2.0
        }
        NotifFilterMode::Smart => {
            if decision.totp_code.is_some() || decision.category == "auth_totp" {
                return true;
            }
            if matches!(
                decision.category.as_str(),
                "promo" | "spam" | "notification"
            ) {
                return decision.urgency >= 2.2;
            }
            if let Some(custom_id) = decision.category.strip_prefix("custom:") {
                if let Some(cat) = config.custom_categories.iter().find(|c| c.id == custom_id) {
                    return cat.allow_notifications;
                }
            }
            decision.category == "important"
                || decision.needs_reply >= config.thresholds.category
                || decision.urgency >= 1.5
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_neuralwatt_systemone_response_with_energy() {
        let raw = br#"{
            "model": "mammoth-1",
            "answers": {
                "is_urgent": { "type": "noul", "noul": 0.94 },
                "category": {
                    "type": "choice",
                    "choice": "important",
                    "probabilities": { "important": 0.93, "promo": 0.05, "spam": 0.02 },
                    "confidence": 0.88
                }
            },
            "usage": { "input_tokens": 142, "output_tokens": 18 },
            "energy": {
                "energy_joules": 48.25,
                "energy_kwh": 0.0000134,
                "avg_power_watts": 3600.0,
                "duration_seconds": 0.075
            }
        }"#;

        let parsed = parse_decision_response(raw, "fallback", 81).expect("parse");
        assert_eq!(parsed.model, "mammoth-1");
        assert_eq!(parsed.latency_ms, 81);
        assert_eq!(parsed.usage.prompt_tokens, 142);
        assert_eq!(parsed.usage.completion_tokens, 18);
        assert_eq!(parsed.answers["is_urgent"].noul, Some(0.94));
        assert_eq!(
            parsed.answers["category"].choice.as_deref(),
            Some("important")
        );
        let energy = parsed.energy.expect("energy");
        assert!((energy.energy_joules - 48.25).abs() < 1e-6);
    }

    #[test]
    fn parses_baseten_prompt_tokens_response() {
        let raw = br#"{
            "model": "decision-models/baseten-mammoth-27b-latest",
            "answers": {
                "urgency": { "type": "score", "score": 2.4, "probabilities": { "Haute": 0.8 } }
            },
            "usage": { "prompt_tokens": 80, "completion_tokens": 0 }
        }"#;
        let parsed = parse_decision_response(raw, "mammoth-1", 120).expect("parse");
        assert_eq!(parsed.usage.prompt_tokens, 80);
        assert_eq!(parsed.usage.completion_tokens, 0);
        assert_eq!(parsed.answers["urgency"].score, Some(2.4));
        assert!(parsed.energy.is_none());
    }

    #[test]
    fn smart_notifications_mute_promos_and_pass_totp() {
        let config = DecisionConfig {
            notif_mode: NotifFilterMode::Smart,
            ..Default::default()
        };

        let promo = MailDecision {
            account_id: "a".into(),
            folder_path: "INBOX".into(),
            uid: 1,
            message_id: None,
            content_hash: "h".into(),
            schema_version: 1,
            model: "mammoth-1".into(),
            category: "promo".into(),
            category_conf: 0.95,
            category_probs: HashMap::new(),
            urgency: 0.2,
            needs_reply: 0.05,
            has_task: 0.0,
            has_event: 0.0,
            security: "safe".into(),
            security_conf: 0.99,
            cleanup_score: 0.92,
            assignee: None,
            assignee_conf: None,
            totp_code: None,
            totp_service: None,
            suggested_folder: None,
            suggested_folder_conf: None,
            decided_at: 0,
            source: "local".into(),
        };
        assert!(!should_notify(&config, &promo));

        let mut totp_mail = promo.clone();
        totp_mail.category = "auth_totp".into();
        totp_mail.totp_code = Some("482917".into());
        assert!(should_notify(&config, &totp_mail));
    }
}
