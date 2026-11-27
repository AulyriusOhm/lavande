use crate::{
    auth::{self, AuthedUser, ClientIp},
    error::ApiError,
    state::AppState,
};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

const MAX_EMAIL_LEN: usize = 254;
const MAX_LOCAL_LEN: usize = 64;
const MAX_ENVELOPE_BYTES: usize = 4096;

#[derive(Deserialize)]
pub struct EnvelopeRequest {
    envelope: String,
}

#[derive(Deserialize)]
pub struct SaltQuery {
    email: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    email: String,
    auth_key: String,
    account_salt: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    email: String,
    auth_key: String,
}

pub async fn salt(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Query(params): Query<SaltQuery>,
) -> Result<Response, ApiError> {
    auth::check_salt_rate_limit(&ip)?;
    let email = normalize_email(&params.email)?;
    let account_salt: Option<Vec<u8>> =
        sqlx::query_scalar("select account_salt from users where email = $1")
            .bind(&email)
            .fetch_optional(&state.pool)
            .await?;

    Ok(match account_salt {
        Some(account_salt) => (
            StatusCode::OK,
            Json(json!({ "accountSalt": auth::encode_key(&account_salt) })),
        )
            .into_response(),
        None => unknown_email(),
    })
}

pub async fn register(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Json(body): Json<RegisterRequest>,
) -> Result<Response, ApiError> {
    auth::check_register_rate_limit(&ip)?;
    let email = normalize_email(&body.email)?;
    let auth_key = auth::decode_key(&body.auth_key, 32, "authKey")?;
    let account_salt = auth::decode_key(&body.account_salt, 16, "accountSalt")?;
    let (auth_verifier, auth_salt) = auth::hash_auth_key(auth_key).await?;
    let user_id = Uuid::new_v4();

    let inserted = sqlx::query(
        "insert into users (id, email, auth_verifier, auth_salt, account_salt)
         values ($1, $2, $3, $4, $5)
         on conflict (email) do nothing",
    )
    .bind(user_id)
    .bind(&email)
    .bind(&auth_verifier)
    .bind(&auth_salt)
    .bind(&account_salt)
    .execute(&state.pool)
    .await?;

    if inserted.rows_affected() == 0 {
        return Err(ApiError::Conflict {
            code: "email_taken",
            message: "un compte existe déjà pour cet email".to_string(),
        });
    }

    let (token, expires_at) = create_session(&state, user_id, None).await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "userId": user_id,
            "token": token,
            "expiresAt": expires_at,
            "accountSalt": auth::encode_key(&account_salt),
        })),
    )
        .into_response())
}

pub async fn login(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Json(body): Json<LoginRequest>,
) -> Result<Response, ApiError> {
    let email = normalize_email(&body.email)?;
    auth::check_login_rate_limit(&email, &ip)?;
    let auth_key = auth::decode_key(&body.auth_key, 32, "authKey")?;

    type UserRow = (Uuid, String, Vec<u8>, Option<Vec<u8>>);
    let account: Option<UserRow> = sqlx::query_as(
        "select id, auth_verifier, account_salt, key_envelope from users where email = $1",
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await?;

    let Some((user_id, auth_verifier, account_salt, key_envelope)) = account else {
        auth::verify_dummy(auth_key).await;
        return Ok(invalid_credentials());
    };

    if !auth::verify_auth_key(auth_key, auth_verifier).await {
        return Ok(invalid_credentials());
    }

    let (token, expires_at) = create_session(&state, user_id, None).await?;

    Ok(Json(json!({
        "userId": user_id,
        "token": token,
        "expiresAt": expires_at,
        "accountSalt": auth::encode_key(&account_salt),
        "keyEnvelope": key_envelope.map(|bytes| auth::encode_key(&bytes)),
    }))
    .into_response())
}

pub async fn set_envelope(
    State(state): State<AppState>,
    user: AuthedUser,
    Json(body): Json<EnvelopeRequest>,
) -> Result<StatusCode, ApiError> {
    let bytes = auth::decode_key_min(&body.envelope, 1, "envelope")?;
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(ApiError::BadRequest(format!(
            "envelope invalide : {MAX_ENVELOPE_BYTES} octets maximum"
        )));
    }

    sqlx::query("update users set key_envelope = $1 where id = $2")
        .bind(&bytes)
        .bind(user.user_id)
        .execute(&state.pool)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn logout(
    State(state): State<AppState>,
    user: AuthedUser,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let token_hash = auth::hash_token(&auth::bearer_token(&headers)?);

    sqlx::query("delete from sessions where token_hash = $1 and user_id = $2")
        .bind(&token_hash)
        .bind(user.user_id)
        .execute(&state.pool)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn me(
    State(state): State<AppState>,
    user: AuthedUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let (email, account_salt): (String, Vec<u8>) =
        sqlx::query_as("select email, account_salt from users where id = $1")
            .bind(user.user_id)
            .fetch_one(&state.pool)
            .await?;

    let devices: i64 = sqlx::query_scalar(
        "select count(*) from devices where user_id = $1 and revoked_at is null",
    )
    .bind(user.user_id)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(json!({
        "userId": user.user_id,
        "email": email,
        "accountSalt": auth::encode_key(&account_salt),
        "devices": devices,
    })))
}

pub async fn create_session(
    state: &AppState,
    user_id: Uuid,
    device_id: Option<Uuid>,
) -> Result<(String, DateTime<Utc>), ApiError> {
    let token = auth::new_token();
    let expires_at = Utc::now() + Duration::seconds(state.config.session_ttl_secs);

    sqlx::query(
        "insert into sessions (token_hash, user_id, device_id, expires_at)
         values ($1, $2, $3, $4)",
    )
    .bind(auth::hash_token(&token))
    .bind(user_id)
    .bind(device_id)
    .bind(expires_at)
    .execute(&state.pool)
    .await?;

    Ok((token, expires_at))
}

fn normalize_email(raw: &str) -> Result<String, ApiError> {
    let email = raw.trim().to_lowercase();

    if email.is_empty() || email.len() > MAX_EMAIL_LEN {
        return Err(invalid_email());
    }

    let mut parts = email.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(invalid_email());
    };

    if local.is_empty()
        || local.len() > MAX_LOCAL_LEN
        || local.starts_with('.')
        || local.ends_with('.')
        || local.contains("..")
        || !local
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".!#$%&'*+/=?^_`{|}~-".contains(c))
    {
        return Err(invalid_email());
    }

    if domain.len() < 3
        || domain.starts_with('.')
        || domain.ends_with('.')
        || domain.contains("..")
        || !domain.contains('.')
        || !domain
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(invalid_email());
    }

    Ok(email)
}

fn invalid_email() -> ApiError {
    ApiError::BadRequest("email invalide".to_string())
}

fn invalid_credentials() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "code": "invalid_credentials",
            "message": "email ou clé d'authentification invalide",
        })),
    )
        .into_response()
}

fn unknown_email() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "code": "unknown_email",
            "message": "aucun compte pour cet email",
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_email_lowercases_and_trims() {
        assert_eq!(
            normalize_email("  Camille@Example.TEST ").expect("email valide"),
            "camille@example.test"
        );
    }

    #[test]
    fn normalize_email_rejects_malformed_values() {
        let cases = [
            "",
            "camille",
            "camille@",
            "@example.test",
            "camille@@example.test",
            "camille@example",
            "camille@.test",
            "camille@example..test",
            "camille.@example.test",
            "cam ille@example.test",
        ];

        for case in cases {
            assert!(normalize_email(case).is_err(), "accepté à tort : {case}");
        }
    }

    #[test]
    fn normalize_email_rejects_too_long_values() {
        let domain = "example.test";
        let local = "a".repeat(MAX_EMAIL_LEN);
        assert!(normalize_email(&format!("{local}@{domain}")).is_err());
    }
}
