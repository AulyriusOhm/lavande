use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("authentification requise")]
    Unauthorized,
    #[error("ressource introuvable")]
    NotFound,
    #[error("{message}")]
    Conflict { code: &'static str, message: String },
    #[error("version de schéma serveur trop récente pour le client")]
    SchemaTooNew,
    #[error("version de schéma client trop ancienne")]
    ClientTooOld,
    #[error("trop de requêtes")]
    RateLimited,
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl From<sqlx::Error> for ApiError {
    fn from(err: sqlx::Error) -> Self {
        ApiError::Internal(err.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message): (StatusCode, &'static str, String) = match self {
            ApiError::BadRequest(message) => (StatusCode::BAD_REQUEST, "bad_request", message),
            ApiError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "authentification requise".to_string(),
            ),
            ApiError::NotFound => (
                StatusCode::NOT_FOUND,
                "not_found",
                "ressource introuvable".to_string(),
            ),
            ApiError::Conflict { code, message } => (StatusCode::CONFLICT, code, message),
            ApiError::SchemaTooNew => (
                StatusCode::UPGRADE_REQUIRED,
                "schema_too_new",
                "le serveur utilise une version de schéma plus récente, mettez l'application à jour"
                    .to_string(),
            ),
            ApiError::ClientTooOld => (
                StatusCode::UPGRADE_REQUIRED,
                "client_too_old",
                "cette version de l'application n'est plus prise en charge, mettez-la à jour"
                    .to_string(),
            ),
            ApiError::RateLimited => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "trop de requêtes, réessayez dans quelques instants".to_string(),
            ),
            ApiError::Internal(err) => {
                tracing::error!(error = ?err, "erreur interne");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "erreur interne du serveur".to_string(),
                )
            }
        };

        (
            status,
            Json(json!({
                "code": code,
                "message": message,
            })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn status_and_body(error: ApiError) -> (StatusCode, serde_json::Value) {
        let response = error.into_response();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("corps de réponse lisible");
        (status, serde_json::from_slice(&bytes).expect("corps JSON"))
    }

    #[tokio::test]
    async fn maps_each_variant_to_its_status_and_code() {
        let cases = vec![
            (
                ApiError::BadRequest("champ manquant".to_string()),
                StatusCode::BAD_REQUEST,
                "bad_request",
            ),
            (
                ApiError::Unauthorized,
                StatusCode::UNAUTHORIZED,
                "unauthorized",
            ),
            (ApiError::NotFound, StatusCode::NOT_FOUND, "not_found"),
            (
                ApiError::Conflict {
                    code: "device_revoked",
                    message: "appareil révoqué".to_string(),
                },
                StatusCode::CONFLICT,
                "device_revoked",
            ),
            (
                ApiError::SchemaTooNew,
                StatusCode::UPGRADE_REQUIRED,
                "schema_too_new",
            ),
            (
                ApiError::ClientTooOld,
                StatusCode::UPGRADE_REQUIRED,
                "client_too_old",
            ),
            (
                ApiError::RateLimited,
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
            ),
            (
                ApiError::Internal(anyhow::anyhow!("connexion refusée")),
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
            ),
        ];

        for (error, expected_status, expected_code) in cases {
            let (status, body) = status_and_body(error).await;
            assert_eq!(status, expected_status);
            assert_eq!(body["code"], expected_code);
            assert!(body["message"].is_string());
        }
    }

    #[tokio::test]
    async fn internal_errors_never_leak_details() {
        let (status, body) =
            status_and_body(ApiError::Internal(anyhow::anyhow!("mot de passe refusé"))).await;

        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["message"], "erreur interne du serveur");
        assert!(!body.to_string().contains("mot de passe"));
    }

    #[tokio::test]
    async fn database_errors_become_internal_errors() {
        let (status, body) = status_and_body(ApiError::from(sqlx::Error::RowNotFound)).await;

        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["code"], "internal");
    }
}
