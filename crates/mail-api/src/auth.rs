//! Authentification du démon : jeton Bearer exigé sur toutes les routes.
//!
//! Exceptions assumées :
//! - `/api/health` : sonde des scripts, ne révèle que la version ;
//! - `/api/oauth/callback` : retour du navigateur, protégé par le `state`
//!   PKCE à usage unique ;
//! - `/api/events` : `EventSource` ne sait pas porter d'en-tête, le jeton
//!   passe alors en `?token=` (boucle locale uniquement).

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use subtle::ConstantTimeEq;

use crate::error::ApiError;
use crate::state::AppState;

pub async fn require_token(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let path = request.uri().path();
    if path == "/api/health" || path == "/api/oauth/callback" {
        return Ok(next.run(request).await);
    }
    let presented = bearer(&request).or_else(|| {
        if path == "/api/events" {
            query_token(&request)
        } else {
            None
        }
    });
    match presented {
        Some(token) if bool::from(token.as_bytes().ct_eq(state.token().as_bytes())) => {
            Ok(next.run(request).await)
        }
        _ => Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "auth",
            "jeton du démon manquant ou invalide (fichier daemon-token du répertoire de données)",
        )),
    }
}

fn bearer(request: &Request) -> Option<String> {
    let value = request.headers().get("authorization")?.to_str().ok()?;
    let token = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))?
        .trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

fn query_token(request: &Request) -> Option<String> {
    request.uri().query()?.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        if name == "token" && !value.is_empty() {
            Some(value.to_string())
        } else {
            None
        }
    })
}
