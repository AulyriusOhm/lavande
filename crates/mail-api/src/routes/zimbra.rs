//! `/api/accounts/{id}/zimbra`: socle SOAP Zimbra d'un compte mail.
//!
//! Le mot de passe lu dans le coffre ne sert que dans le corps de
//! l'`AuthRequest` : ni la requête HTTP ni la réponse ne portent d'identifiant
//! ou de jeton. Un compte OAuth2 n'a rien à présenter à Zimbra.
//!
//! Les filtres et le message d'absence vivent sur le serveur : le démon les lit,
//! applique une modification et renvoie la liste entière, pour qu'une règle
//! qu'il ne comprend pas revienne telle quelle.
//!
//! Les étiquettes et l'annuaire d'entreprise viennent du même serveur : le
//! message d'un compte local n'a pas d'identifiant Zimbra, il est retrouvé par
//! son `Message-ID` (voir [`message_id_of`]).

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, patch};
use axum::{Json, Router};
use lavande_mail::config::AuthConfig;
use lavande_mail::soap::{
    account_endpoint, zimbra_date, AccountInfo, FilterRule, GalEntry, ServerFilterRule, SoapClient,
    Tag, Vacation,
};
use serde::Deserialize;

use crate::error::ApiError;
use crate::state::AppState;

/// Plus longue couleur Zimbra acceptée (l'affichage client s'arrête à 9).
const MAX_TAG_COLOR: u8 = 127;

/// Nombre de suggestions GAL demandées quand le front n'en dit pas plus.
const GAL_LIMIT: u32 = 8;
const GAL_MAX: u32 = 50;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/accounts/{id}/zimbra/info", get(info))
        .route(
            "/api/accounts/{id}/zimbra/filters",
            get(filters).post(change_filter),
        )
        .route(
            "/api/accounts/{id}/zimbra/vacation",
            get(vacation).put(save_vacation),
        )
        .route("/api/accounts/{id}/zimbra/tags", get(tags).post(create_tag))
        .route(
            "/api/accounts/{id}/zimbra/tags/{tag_id}",
            patch(change_tag).delete(delete_tag),
        )
        .route(
            "/api/accounts/{id}/zimbra/message-tags",
            get(message_tags).post(tag_message),
        )
        .route("/api/accounts/{id}/zimbra/gal", get(gal))
}

/// Client SOAP du compte : mot de passe au coffre, hôte IMAP pour endpoint.
async fn soap_client(state: &Arc<AppState>, id: &str) -> Result<SoapClient, ApiError> {
    let account = state.account(id).await?;
    let password = match &account.auth {
        AuthConfig::Password { password } => password.clone(),
        AuthConfig::OAuth2 { .. } => {
            return Err(ApiError::bad_request(
                "zimbra",
                "ce compte utilise OAuth ; Zimbra ne demande que son mot de passe",
            ))
        }
    };
    let username = account.username.trim();
    let username = if username.is_empty() {
        account.email.trim()
    } else {
        username
    };
    let endpoint = account_endpoint(&account.imap.host);
    Ok(SoapClient::new(&endpoint, username, &password)?)
}

/// `GetInfo` du serveur Zimbra du compte : nom, identifiant et version.
async fn info(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<AccountInfo>, ApiError> {
    let client = soap_client(&state, &id).await?;
    let info = client.get_info().await?;
    tracing::debug!(account = %id, "SOAP Zimbra : GetInfo");
    Ok(Json(info))
}

/// Les filtres du serveur, avec ceux que le démon ne sait pas réécrire.
async fn filters(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<FilterRule>>, ApiError> {
    let client = soap_client(&state, &id).await?;
    let rules: Vec<FilterRule> = client
        .get_filter_rules()
        .await?
        .into_iter()
        .map(|rule| rule.rule)
        .collect();
    tracing::debug!(account = %id, count = rules.len(), "SOAP Zimbra : GetFilterRules");
    Ok(Json(rules))
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum FilterChange {
    Add,
    Modify,
    Delete,
}

#[derive(Deserialize)]
struct FilterRequest {
    action: FilterChange,
    rule: FilterRule,
}

/// Une modification de filtre : le démon relit la liste du serveur, l'amende,
/// puis renvoie la liste entière que `ModifyFilterRules` attend.
async fn change_filter(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(request): Json<FilterRequest>,
) -> Result<StatusCode, ApiError> {
    let name = request.rule.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::bad_request("zimbra", "le nom du filtre est vide"));
    }
    let client = soap_client(&state, &id).await?;
    let mut rules: Vec<ServerFilterRule> = client.get_filter_rules().await?;
    let known = rules
        .iter()
        .position(|rule| rule.rule.name.eq_ignore_ascii_case(&name));

    match request.action {
        FilterChange::Add => {
            if known.is_some() {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "zimbra",
                    format!("un filtre nommé « {name} » existe déjà"),
                ));
            }
            request
                .rule
                .validate()
                .map_err(|message| ApiError::bad_request("zimbra", message))?;
            let mut rule = request.rule;
            rule.name = name;
            rules.push(ServerFilterRule {
                raw: rule.to_wire(),
                rule,
            });
        }
        FilterChange::Modify => {
            let index = known.ok_or_else(|| unknown_filter(&name))?;
            if rules[index].rule.read_only {
                return Err(ApiError::bad_request(
                    "zimbra",
                    "ce filtre contient des éléments avancés ; modifiez-le dans l'interface Zimbra",
                ));
            }
            request
                .rule
                .validate()
                .map_err(|message| ApiError::bad_request("zimbra", message))?;
            let mut rule = request.rule;
            rule.name = name;
            rules[index] = ServerFilterRule {
                raw: rule.to_wire(),
                rule,
            };
        }
        FilterChange::Delete => {
            let index = known.ok_or_else(|| unknown_filter(&name))?;
            rules.remove(index);
        }
    }

    let count = rules.len();
    client.modify_filter_rules(&rules).await?;
    tracing::debug!(account = %id, count, "SOAP Zimbra : ModifyFilterRules");
    Ok(StatusCode::NO_CONTENT)
}

fn unknown_filter(name: &str) -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "zimbra",
        format!("aucun filtre nommé « {name} » sur ce compte"),
    )
}

/// Le message d'absence du compte, tel que le serveur le garde.
async fn vacation(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vacation>, ApiError> {
    let client = soap_client(&state, &id).await?;
    let vacation = client.get_vacation().await?;
    tracing::debug!(account = %id, enabled = vacation.enabled, "SOAP Zimbra : GetPrefs");
    Ok(Json(vacation))
}

async fn save_vacation(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(vacation): Json<Vacation>,
) -> Result<StatusCode, ApiError> {
    let from = check_date(vacation.from.as_deref(), false)?;
    let until = check_date(vacation.until.as_deref(), true)?;
    if let (Some(from), Some(until)) = (&from, &until) {
        if until < from {
            return Err(ApiError::bad_request(
                "zimbra",
                "la fin de l'absence précède son début",
            ));
        }
    }
    if vacation.enabled && vacation.message.trim().is_empty() {
        return Err(ApiError::bad_request(
            "zimbra",
            "une réponse d'absence active a besoin d'un message",
        ));
    }
    let client = soap_client(&state, &id).await?;
    let vacation = Vacation {
        from,
        until,
        ..vacation
    };
    client.set_vacation(&vacation).await?;
    tracing::debug!(account = %id, enabled = vacation.enabled, "SOAP Zimbra : ModifyPrefs");
    Ok(StatusCode::NO_CONTENT)
}

/// `AAAA-MM-JJ` attendu : la forme Zimbra en découle, à minuit pour un début et
/// à la dernière seconde du jour pour une fin.
fn check_date(date: Option<&str>, end_of_day: bool) -> Result<Option<String>, ApiError> {
    match date.map(str::trim) {
        None | Some("") => Ok(None),
        Some(date) => zimbra_date(date, end_of_day)
            .map(|_| Some(date.to_string()))
            .ok_or_else(|| ApiError::bad_request("zimbra", "date attendue au format AAAA-MM-JJ")),
    }
}

/// Toutes les étiquettes du compte, avec leur couleur et leur compte d'items.
async fn tags(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<Tag>>, ApiError> {
    let client = soap_client(&state, &id).await?;
    let tags = client.get_tags().await?;
    tracing::debug!(account = %id, count = tags.len(), "SOAP Zimbra : GetTag");
    Ok(Json(tags))
}

#[derive(Deserialize)]
struct NewTag {
    name: String,
    #[serde(default)]
    color: u8,
}

async fn create_tag(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(request): Json<NewTag>,
) -> Result<(StatusCode, Json<Tag>), ApiError> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request(
            "zimbra",
            "le nom de l'étiquette est vide",
        ));
    }
    if request.color > MAX_TAG_COLOR {
        return Err(ApiError::bad_request(
            "zimbra",
            format!("couleur Zimbra attendue entre 0 et {MAX_TAG_COLOR}"),
        ));
    }
    let client = soap_client(&state, &id).await?;
    let tag = client.create_tag(name, request.color).await?;
    tracing::debug!(account = %id, name, "SOAP Zimbra : CreateTag");
    Ok((StatusCode::CREATED, Json(tag)))
}

#[derive(Deserialize)]
struct TagChange {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    color: Option<u8>,
}

/// Renomme et/ou recolore une étiquette : un seul `TagAction op="update"`.
async fn change_tag(
    Path((id, tag_id)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
    Json(change): Json<TagChange>,
) -> Result<StatusCode, ApiError> {
    let name = change.name.as_deref().map(str::trim);
    if name.is_some_and(str::is_empty) {
        return Err(ApiError::bad_request(
            "zimbra",
            "le nom de l'étiquette est vide",
        ));
    }
    if name.is_none() && change.color.is_none() {
        return Err(ApiError::bad_request(
            "zimbra",
            "rien à changer : ni nom ni couleur",
        ));
    }
    if change.color.is_some_and(|color| color > MAX_TAG_COLOR) {
        return Err(ApiError::bad_request(
            "zimbra",
            format!("couleur Zimbra attendue entre 0 et {MAX_TAG_COLOR}"),
        ));
    }
    let client = soap_client(&state, &id).await?;
    client.modify_tag(&tag_id, name, change.color).await?;
    tracing::debug!(account = %id, "SOAP Zimbra : TagAction update");
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_tag(
    Path((id, tag_id)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    let client = soap_client(&state, &id).await?;
    client.delete_tag(&tag_id).await?;
    tracing::debug!(account = %id, "SOAP Zimbra : TagAction delete");
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct MessageRef {
    folder: String,
    uid: u32,
}

#[derive(Deserialize)]
struct TagMessage {
    folder: String,
    uid: u32,
    tag_id: String,
    #[serde(default)]
    add: bool,
}

/// Étiquettes du message ouvert, retrouvé sur le serveur par son `Message-ID`.
async fn message_tags(
    Path(id): Path<String>,
    Query(reference): Query<MessageRef>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<Tag>>, ApiError> {
    let message_id = message_id_of(&state, &id, &reference.folder, reference.uid)?;
    let client = soap_client(&state, &id).await?;
    let tags = client.message_tags(&message_id).await?;
    tracing::debug!(account = %id, uid = reference.uid, "SOAP Zimbra : étiquettes du message");
    Ok(Json(tags))
}

/// Pose ou retire une étiquette, et rend les étiquettes du message après coup.
async fn tag_message(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(request): Json<TagMessage>,
) -> Result<Json<Vec<Tag>>, ApiError> {
    let tag_id = request.tag_id.trim();
    if tag_id.is_empty() {
        return Err(ApiError::bad_request(
            "zimbra",
            "l'étiquette visée est vide",
        ));
    }
    let message_id = message_id_of(&state, &id, &request.folder, request.uid)?;
    let client = soap_client(&state, &id).await?;
    let tags = client.tag_message(&message_id, tag_id, request.add).await?;
    tracing::debug!(
        account = %id,
        uid = request.uid,
        add = request.add,
        "SOAP Zimbra : MsgAction"
    );
    Ok(Json(tags))
}

#[derive(Deserialize)]
struct GalQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    limit: Option<u32>,
}

/// Annuaire de l'entreprise : contacts, listes de diffusion et ressources.
async fn gal(
    Path(id): Path<String>,
    Query(query): Query<GalQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<GalEntry>>, ApiError> {
    let term = query.q.trim();
    if term.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let limit = query.limit.unwrap_or(GAL_LIMIT).clamp(1, GAL_MAX);
    let client = soap_client(&state, &id).await?;
    let entries = client.gal(term, limit).await?;
    tracing::debug!(account = %id, count = entries.len(), "SOAP Zimbra : AutoCompleteGal");
    Ok(Json(entries))
}

/// `Message-ID` du message stocké : Zimbra ne connaît que celui-là, et un
/// message qui n'en porte pas ne peut pas être retrouvé sur le serveur.
fn message_id_of(
    state: &AppState,
    account: &str,
    folder: &str,
    uid: u32,
) -> Result<String, ApiError> {
    let stored = state
        .store()
        .get_message(account, folder, uid)?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "zimbra",
                format!("message {uid} introuvable dans « {folder} »"),
            )
        })?;
    let message_id = stored.message_id.unwrap_or_default();
    let message_id = message_id.trim();
    if message_id.is_empty() {
        return Err(ApiError::bad_request(
            "zimbra",
            "ce message n'a pas de Message-ID : Zimbra ne peut pas le retrouver",
        ));
    }
    Ok(message_id.to_string())
}
