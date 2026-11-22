//! `/api/accounts/{id}/zimbra`: socle SOAP Zimbra d'un compte mail.
//!
//! Le mot de passe lu dans le coffre ne sert que dans le corps de
//! l'`AuthRequest` : ni la requête HTTP ni la réponse ne portent d'identifiant
//! ou de jeton. Un compte OAuth2 n'a rien à présenter à Zimbra.
//!
//! Les filtres et le message d'absence vivent sur le serveur : le démon les lit,
//! applique une modification et renvoie la liste entière, pour qu'une règle
//! qu'il ne comprend pas revienne telle quelle.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use lavande_mail::config::AuthConfig;
use lavande_mail::soap::{
    account_endpoint, zimbra_date, AccountInfo, FilterRule, ServerFilterRule, SoapClient, Vacation,
};
use serde::Deserialize;

use crate::error::ApiError;
use crate::state::AppState;

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
