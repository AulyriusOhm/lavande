use crate::{
    auth::{self, AuthedUser, ClientIp},
    error::ApiError,
    state::AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Duration, Utc};
use rand::{rngs::OsRng, Rng};
use serde::Deserialize;
use serde_json::json;
use sqlx::FromRow;
use uuid::Uuid;

const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ234567";
const CODE_LEN: usize = 6;
const CODE_CANDIDATES: usize = 5;
const MAX_NAME_LEN: usize = 64;
const MAX_PLATFORM_LEN: usize = 32;
const MAX_ENVELOPE_LEN: usize = 4096;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    device_id: Uuid,
    name: String,
    platform: String,
    public_key: String,
    schema_version: i32,
    poll_secret: String,
}

#[derive(Deserialize)]
pub struct ClaimRequest {
    code: String,
}

#[derive(Deserialize)]
pub struct CompleteRequest {
    code: String,
    envelope: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollRequest {
    poll_secret: String,
}

#[derive(FromRow)]
struct ClaimRow {
    device_id: Uuid,
    name: String,
    platform: String,
    target_pub_key: Vec<u8>,
    schema_version: i32,
    expires_at: DateTime<Utc>,
    claimed_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
}

#[derive(FromRow)]
struct CompleteRow {
    device_id: Uuid,
    name: String,
    platform: String,
    target_pub_key: Vec<u8>,
    schema_version: i32,
    user_id: Option<Uuid>,
    expires_at: DateTime<Utc>,
    claimed_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
}

#[derive(FromRow)]
struct PollRow {
    device_id: Uuid,
    poll_secret_hash: Vec<u8>,
    user_id: Option<Uuid>,
    wrapped_key: Option<String>,
    token_issued_at: Option<DateTime<Utc>>,
    expires_at: DateTime<Utc>,
    completed_at: Option<DateTime<Utc>>,
}

pub async fn start(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Json(body): Json<StartRequest>,
) -> Result<Response, ApiError> {
    auth::check_pairing_rate_limit(&ip)?;

    let name = required_text(&body.name, "name", MAX_NAME_LEN)?;
    let platform = required_text(&body.platform, "platform", MAX_PLATFORM_LEN)?;
    let target_pub_key = auth::decode_key(&body.public_key, 32, "publicKey")?;
    let poll_secret = auth::decode_key_min(&body.poll_secret, 16, "pollSecret")?;

    if body.schema_version < state.config.min_client_schema {
        return Ok(super::devices::client_too_old());
    }

    let expires_at = Utc::now() + Duration::seconds(state.config.pairing_ttl_secs);
    let poll_secret_hash = auth::hash_token(&auth::encode_key(&poll_secret));

    for _ in 0..CODE_CANDIDATES {
        let code = generate_code();
        let inserted = sqlx::query(
            "insert into pairing_sessions
               (code_hash, device_id, name, platform, target_pub_key, schema_version,
                poll_secret_hash, expires_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8)
             on conflict (code_hash) do nothing",
        )
        .bind(auth::hash_token(&code))
        .bind(body.device_id)
        .bind(&name)
        .bind(&platform)
        .bind(&target_pub_key)
        .bind(body.schema_version)
        .bind(&poll_secret_hash)
        .bind(expires_at)
        .execute(&state.pool)
        .await?;

        if inserted.rows_affected() == 1 {
            return Ok((
                StatusCode::CREATED,
                Json(json!({ "code": code, "expiresAt": expires_at })),
            )
                .into_response());
        }
    }

    Err(ApiError::Internal(anyhow::anyhow!(
        "impossible de générer un code d'appairage unique"
    )))
}

pub async fn claim(
    State(state): State<AppState>,
    user: AuthedUser,
    Json(body): Json<ClaimRequest>,
) -> Result<Response, ApiError> {
    let Ok(code_hash) = code_hash(&body.code) else {
        return Ok(pairing_unknown());
    };

    let row: Option<ClaimRow> = sqlx::query_as(
        "select device_id, name, platform, target_pub_key, schema_version, expires_at,
                claimed_at, completed_at
         from pairing_sessions
         where code_hash = $1",
    )
    .bind(&code_hash)
    .fetch_optional(&state.pool)
    .await?;

    let Some(row) = row else {
        return Ok(pairing_unknown());
    };
    if row.expires_at <= Utc::now() {
        return Ok(pairing_expired());
    }
    if row.completed_at.is_some() {
        return Ok(completed_conflict());
    }
    if row.claimed_at.is_some() {
        return Ok(claimed_conflict());
    }

    let claimed = sqlx::query(
        "update pairing_sessions
         set claimed_at = now(), user_id = $1
         where code_hash = $2 and claimed_at is null and completed_at is null",
    )
    .bind(user.user_id)
    .bind(&code_hash)
    .execute(&state.pool)
    .await?;

    if claimed.rows_affected() == 0 {
        return Ok(claimed_conflict());
    }

    Ok(Json(json!({
        "deviceId": row.device_id,
        "deviceName": row.name,
        "platform": row.platform,
        "publicKey": auth::encode_key(&row.target_pub_key),
        "schemaVersion": row.schema_version,
        "fingerprint": auth::fingerprint(&row.target_pub_key),
    }))
    .into_response())
}

pub async fn complete(
    State(state): State<AppState>,
    user: AuthedUser,
    Json(body): Json<CompleteRequest>,
) -> Result<Response, ApiError> {
    let envelope = body.envelope.trim().to_string();
    if envelope.is_empty() || envelope.len() > MAX_ENVELOPE_LEN {
        return Err(ApiError::BadRequest(format!(
            "envelope invalide : 1 à {MAX_ENVELOPE_LEN} octets attendus"
        )));
    }

    let Ok(code_hash) = code_hash(&body.code) else {
        return Ok(pairing_unknown());
    };

    let row: Option<CompleteRow> = sqlx::query_as(
        "select device_id, name, platform, target_pub_key, schema_version, user_id,
                expires_at, claimed_at, completed_at
         from pairing_sessions
         where code_hash = $1",
    )
    .bind(&code_hash)
    .fetch_optional(&state.pool)
    .await?;

    let Some(row) = row else {
        return Ok(pairing_unknown());
    };
    if row.expires_at <= Utc::now() {
        return Ok(pairing_expired());
    }
    if row.completed_at.is_some() {
        return Ok(completed_conflict());
    }
    if row.user_id != Some(user.user_id) {
        return Ok(pairing_unknown());
    }
    if row.claimed_at.is_none() {
        return Ok(not_claimed());
    }

    let mut tx = state.pool.begin().await?;

    let existing: Option<(Uuid, Vec<u8>)> =
        sqlx::query_as("select user_id, pub_key from devices where id = $1")
            .bind(row.device_id)
            .fetch_optional(&mut *tx)
            .await?;

    match existing {
        Some((owner, pub_key)) if owner == user.user_id && pub_key == row.target_pub_key => {}
        Some(_) => return Err(device_id_taken()),
        None => {
            let conflicting: Option<Uuid> = sqlx::query_scalar(
                "select id from devices
                 where user_id = $1 and pub_key = $2 and revoked_at is null
                 limit 1",
            )
            .bind(user.user_id)
            .bind(&row.target_pub_key)
            .fetch_optional(&mut *tx)
            .await?;

            if conflicting.is_some() {
                return Err(device_id_taken());
            }

            sqlx::query(
                "insert into devices (id, user_id, name, platform, pub_key, schema_version)
                 values ($1, $2, $3, $4, $5, $6)",
            )
            .bind(row.device_id)
            .bind(user.user_id)
            .bind(&row.name)
            .bind(&row.platform)
            .bind(&row.target_pub_key)
            .bind(row.schema_version)
            .execute(&mut *tx)
            .await?;
        }
    }

    let completed = sqlx::query(
        "update pairing_sessions
         set wrapped_key = $1, completed_at = now()
         where code_hash = $2 and completed_at is null",
    )
    .bind(&envelope)
    .bind(&code_hash)
    .execute(&mut *tx)
    .await?;

    if completed.rows_affected() == 0 {
        return Ok(completed_conflict());
    }

    tx.commit().await?;

    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn poll(
    State(state): State<AppState>,
    Path(code): Path<String>,
    Json(body): Json<PollRequest>,
) -> Result<Response, ApiError> {
    let Ok(secret) = auth::decode_key_min(&body.poll_secret, 16, "pollSecret") else {
        return Ok(invalid_poll_secret());
    };
    let secret_hash = auth::hash_token(&auth::encode_key(&secret));

    let Ok(code_hash) = code_hash(&code) else {
        return Ok(pairing_unknown());
    };

    let row: Option<PollRow> = sqlx::query_as(
        "select device_id, poll_secret_hash, user_id, wrapped_key, token_issued_at,
                expires_at, completed_at
         from pairing_sessions
         where code_hash = $1",
    )
    .bind(&code_hash)
    .fetch_optional(&state.pool)
    .await?;

    let Some(row) = row else {
        return Ok(pairing_unknown());
    };
    if row.expires_at <= Utc::now() {
        return Ok(pairing_expired());
    }
    if !auth::constant_time_eq(&row.poll_secret_hash, &secret_hash) {
        return Ok(invalid_poll_secret());
    }
    if row.token_issued_at.is_some() {
        return Ok(consumed_conflict());
    }
    if row.completed_at.is_none() {
        return Ok(Json(json!({ "status": "pending" })).into_response());
    }

    let (Some(user_id), Some(envelope)) = (row.user_id, row.wrapped_key) else {
        return Ok(pairing_unknown());
    };

    let token = auth::new_token();
    let expires_at = Utc::now() + Duration::seconds(state.config.session_ttl_secs);

    let mut tx = state.pool.begin().await?;

    let issued = sqlx::query(
        "update pairing_sessions
         set token_issued_at = now()
         where code_hash = $1 and token_issued_at is null",
    )
    .bind(&code_hash)
    .execute(&mut *tx)
    .await?;

    if issued.rows_affected() == 0 {
        return Ok(consumed_conflict());
    }

    sqlx::query(
        "insert into sessions (token_hash, user_id, device_id, expires_at)
         values ($1, $2, $3, $4)",
    )
    .bind(auth::hash_token(&token))
    .bind(user_id)
    .bind(row.device_id)
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;

    let account_salt: Vec<u8> = sqlx::query_scalar("select account_salt from users where id = $1")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;

    Ok(Json(json!({
        "status": "completed",
        "token": token,
        "userId": user_id,
        "accountSalt": auth::encode_key(&account_salt),
        "envelope": envelope,
    }))
    .into_response())
}

fn generate_code() -> String {
    let mut rng = OsRng;
    (0..CODE_LEN)
        .map(|_| CODE_ALPHABET[rng.gen_range(0..CODE_ALPHABET.len())] as char)
        .collect()
}

fn code_hash(raw: &str) -> Result<Vec<u8>, ApiError> {
    let code = raw.trim().to_ascii_uppercase();
    if code.chars().count() != CODE_LEN
        || !code
            .chars()
            .all(|c| c.is_ascii() && CODE_ALPHABET.contains(&(c as u8)))
    {
        return Err(ApiError::BadRequest(format!(
            "code invalide : {CODE_LEN} caractères attendus"
        )));
    }

    Ok(auth::hash_token(&code))
}

fn required_text(raw: &str, field: &str, max: usize) -> Result<String, ApiError> {
    let value = raw.trim().to_string();
    if value.is_empty() || value.chars().count() > max {
        return Err(ApiError::BadRequest(format!(
            "{field} invalide : 1 à {max} caractères attendus"
        )));
    }

    Ok(value)
}

fn device_id_taken() -> ApiError {
    ApiError::Conflict {
        code: "device_id_taken",
        message: "cet identifiant d'appareil est déjà utilisé".to_string(),
    }
}

fn error_response(status: StatusCode, code: &'static str, message: &'static str) -> Response {
    (
        status,
        Json(json!({
            "code": code,
            "message": message,
        })),
    )
        .into_response()
}

fn pairing_unknown() -> Response {
    error_response(
        StatusCode::NOT_FOUND,
        "pairing_unknown",
        "code d'appairage inconnu",
    )
}

fn pairing_expired() -> Response {
    error_response(
        StatusCode::NOT_FOUND,
        "pairing_expired",
        "code d'appairage expiré",
    )
}

fn invalid_poll_secret() -> Response {
    error_response(
        StatusCode::UNAUTHORIZED,
        "invalid_poll_secret",
        "pollSecret invalide",
    )
}

fn claimed_conflict() -> Response {
    error_response(
        StatusCode::CONFLICT,
        "pairing_already_claimed",
        "ce code d'appairage a déjà été réclamé",
    )
}

fn not_claimed() -> Response {
    error_response(
        StatusCode::CONFLICT,
        "pairing_not_claimed",
        "ce code d'appairage n'a pas encore été réclamé",
    )
}

fn completed_conflict() -> Response {
    error_response(
        StatusCode::CONFLICT,
        "pairing_already_completed",
        "cet appairage est déjà terminé",
    )
}

fn consumed_conflict() -> Response {
    error_response(
        StatusCode::CONFLICT,
        "pairing_consumed",
        "le résultat de cet appairage a déjà été retiré",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

    #[test]
    fn generated_codes_use_the_safe_alphabet() {
        for _ in 0..64 {
            let code = generate_code();
            assert_eq!(code.len(), CODE_LEN);
            assert!(code
                .chars()
                .all(|c| c.is_ascii() && CODE_ALPHABET.contains(&(c as u8))));
            assert!(!code.contains(['I', 'O', '0', '1']));
        }
    }

    #[test]
    fn code_hash_normalizes_case_and_rejects_malformed_codes() {
        assert_eq!(
            code_hash(" ab2cd3 ").expect("code valide"),
            code_hash("AB2CD3").expect("code valide")
        );

        for case in ["", "ABC", "ABCDEFG", "ABCDE0", "ABCDEI", "AB-CD3"] {
            assert!(code_hash(case).is_err(), "accepté à tort : {case}");
        }
    }

    #[test]
    fn base64url_round_trip_matches_the_shared_engine() {
        let bytes = [7u8; 32];
        assert_eq!(
            auth::decode_key(&auth::encode_key(&bytes), 32, "publicKey").ok(),
            Some(bytes.to_vec())
        );
        assert_eq!(URL_SAFE_NO_PAD.encode(bytes), auth::encode_key(&bytes));
    }
}
