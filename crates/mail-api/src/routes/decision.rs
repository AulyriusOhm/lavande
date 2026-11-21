//! `/api/ai/decision*` et `/api/ai/decisions*` : configuration sécurisée du
//! modèle de décision (Système 1), test de connexion, appels génériques et
//! cache SQLite des décisions par mail.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use lavande_mail::store::MailDecision;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::decision::{
    self, DecisionOutput, DecisionQuestion, ProbeRequest, ProbeResponse, PublicDecisionConfig,
    TriageOutcome, UpdateDecisionConfig,
};
use crate::dto::ApiJson;
use crate::error::ApiError;
use crate::state::AppState;

const MAX_BATCH_TRIAGE: usize = 50;
const DECIDE_TIMEOUT: Duration = Duration::from_secs(15);

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/ai/decision/config",
            get(get_config).put(put_config),
        )
        .route("/api/ai/decision/probe", post(probe))
        .route("/api/ai/decision/decide", post(decide))
        .route(
            "/api/ai/decisions",
            get(list_decisions).delete(clear_decisions),
        )
        .route("/api/ai/decisions/triage", post(triage_batch))
        .route("/api/ai/decisions/import", post(import_decisions))
}

async fn get_config(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PublicDecisionConfig>, ApiError> {
    let config = state.decision_config()?;
    let has_api_key = state.decision_api_key().await?.is_some();
    let ready = config.is_ready(has_api_key);
    Ok(Json(PublicDecisionConfig {
        config,
        has_api_key,
        ready,
    }))
}

async fn put_config(
    State(state): State<Arc<AppState>>,
    ApiJson(payload): ApiJson<UpdateDecisionConfig>,
) -> Result<Json<PublicDecisionConfig>, ApiError> {
    let config = payload.config.normalized();
    state.save_decision_config(&config)?;
    if payload.clear_api_key {
        state.remove_decision_api_key().await?;
    } else if let Some(key) = payload
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        state.set_decision_api_key(key).await?;
    }
    let has_api_key = state.decision_api_key().await?.is_some();
    let ready = config.is_ready(has_api_key);
    Ok(Json(PublicDecisionConfig {
        config,
        has_api_key,
        ready,
    }))
}

async fn probe(
    State(state): State<Arc<AppState>>,
    ApiJson(payload): ApiJson<ProbeRequest>,
) -> Result<Json<ProbeResponse>, ApiError> {
    decision::probe(&state, payload).await.map(Json)
}

#[derive(Deserialize)]
struct DecideRequest {
    state: Value,
    questions: BTreeMap<String, DecisionQuestion>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

async fn decide(
    State(state): State<Arc<AppState>>,
    ApiJson(payload): ApiJson<DecideRequest>,
) -> Result<Json<DecisionOutput>, ApiError> {
    let config = state.decision_config()?;
    let api_key = state.decision_api_key().await?;
    if !config.is_ready(api_key.is_some()) {
        return Err(ApiError::conflict(
            "decision",
            "Modèle de décision non configuré ou désactivé",
        ));
    }
    let timeout = payload
        .timeout_ms
        .map(|ms| Duration::from_millis(ms.clamp(500, 30_000)))
        .unwrap_or(DECIDE_TIMEOUT);
    decision::decide_with_config(
        state.tls(),
        &config,
        api_key.as_deref(),
        payload.state,
        payload.questions,
        timeout,
    )
    .await
    .map(Json)
}

#[derive(Deserialize)]
struct ListQuery {
    account_id: Option<String>,
    folder_path: Option<String>,
    limit: Option<usize>,
}

async fn list_decisions(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<MailDecision>>, ApiError> {
    let limit = query.limit.unwrap_or(500);
    let items = state.store().list_decisions(
        query.account_id.as_deref(),
        query.folder_path.as_deref(),
        limit,
    )?;
    Ok(Json(items))
}

#[derive(Deserialize)]
struct ClearQuery {
    account_id: Option<String>,
}

#[derive(Serialize)]
struct ClearResponse {
    removed: usize,
}

async fn clear_decisions(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ClearQuery>,
) -> Result<Json<ClearResponse>, ApiError> {
    let removed = state
        .store()
        .clear_decisions(query.account_id.as_deref())?;
    Ok(Json(ClearResponse { removed }))
}

#[derive(Deserialize)]
struct TriageTarget {
    account_id: String,
    folder_path: String,
    uid: u32,
}

#[derive(Deserialize)]
struct TriageBatchRequest {
    targets: Vec<TriageTarget>,
    #[serde(default)]
    team_members: Vec<String>,
    #[serde(default)]
    force: bool,
}

#[derive(Serialize)]
struct TriageBatchResponse {
    results: Vec<TriageOutcome>,
    errors: Vec<String>,
}

async fn triage_batch(
    State(state): State<Arc<AppState>>,
    ApiJson(payload): ApiJson<TriageBatchRequest>,
) -> Result<Json<TriageBatchResponse>, ApiError> {
    let mut results = Vec::new();
    let mut errors = Vec::new();
    for target in payload.targets.into_iter().take(MAX_BATCH_TRIAGE) {
        let Some(message) = state.store().get_message(
            &target.account_id,
            &target.folder_path,
            target.uid,
        )?
        else {
            errors.push(format!(
                "{}:{}:{} introuvable",
                target.account_id, target.folder_path, target.uid
            ));
            continue;
        };
        match decision::triage_message(&state, &message, &payload.team_members, payload.force).await
        {
            Ok(outcome) => results.push(outcome),
            Err(error) => errors.push(format!(
                "{}:{}:{} : {}",
                target.account_id,
                target.folder_path,
                target.uid,
                error.message()
            )),
        }
    }
    Ok(Json(TriageBatchResponse { results, errors }))
}

#[derive(Deserialize)]
struct ImportDecisionsRequest {
    decisions: Vec<MailDecision>,
}

#[derive(Serialize)]
struct ImportDecisionsResponse {
    imported: usize,
    skipped: usize,
}

/// Importe des décisions reçues via synchro E2EE (ex. calculées par le PC et
/// héritées sur mobile sans clé API locale). Associe par `message_id` si
/// l'uid/compte local diffère.
async fn import_decisions(
    State(state): State<Arc<AppState>>,
    ApiJson(payload): ApiJson<ImportDecisionsRequest>,
) -> Result<Json<ImportDecisionsResponse>, ApiError> {
    let mut imported = 0;
    let mut skipped = 0;
    for mut item in payload.decisions {
        let resolved = if state
            .store()
            .get_message(&item.account_id, &item.folder_path, item.uid)?
            .is_some()
        {
            Some((item.account_id.clone(), item.folder_path.clone(), item.uid))
        } else if let Some(mid) = item.message_id.as_deref().filter(|s| !s.trim().is_empty()) {
            state.store().find_message_by_message_id(mid)?
        } else {
            None
        };
        let Some((account_id, folder_path, uid)) = resolved else {
            skipped += 1;
            continue;
        };
        item.account_id = account_id;
        item.folder_path = folder_path;
        item.uid = uid;
        item.source = "synced".to_string();
        state.store().upsert_decision(&item)?;
        imported += 1;
    }
    Ok(Json(ImportDecisionsResponse { imported, skipped }))
}
