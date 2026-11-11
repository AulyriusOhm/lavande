use crate::{error::ApiError, state::AppState};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::{header::AUTHORIZATION, request::Parts, HeaderMap},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use uuid::Uuid;

const LOGIN_WINDOW: Duration = Duration::from_secs(60);
const LOGIN_MAX_ATTEMPTS: usize = 10;
const PAIRING_WINDOW: Duration = Duration::from_secs(60);
const PAIRING_MAX_CREATIONS: usize = 10;
const RATE_LIMIT_TRACKED_KEYS: usize = 10_000;
const SALT_LEN: usize = 16;

static DUMMY_VERIFIER: OnceLock<String> = OnceLock::new();
static LOGIN_ATTEMPTS: OnceLock<Mutex<HashMap<String, Vec<Instant>>>> = OnceLock::new();
static PAIRING_CREATIONS: OnceLock<Mutex<HashMap<String, Vec<Instant>>>> = OnceLock::new();

#[derive(Debug, Clone, Copy)]
pub struct AuthedUser {
    pub user_id: Uuid,
    pub device_id: Option<Uuid>,
}

pub struct ClientIp(pub String);

pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub fn encode_key(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn decode_key(value: &str, len: usize, field: &str) -> Result<Vec<u8>, ApiError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value.trim())
        .map_err(|_| invalid_base64(field))?;

    if bytes.len() != len {
        return Err(ApiError::BadRequest(format!(
            "{field} invalide : {len} octets attendus"
        )));
    }

    Ok(bytes)
}

pub fn decode_key_min(value: &str, min_len: usize, field: &str) -> Result<Vec<u8>, ApiError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value.trim())
        .map_err(|_| invalid_base64(field))?;

    if bytes.len() < min_len {
        return Err(ApiError::BadRequest(format!(
            "{field} invalide : {min_len} octets minimum attendus"
        )));
    }

    Ok(bytes)
}

pub fn fingerprint(bytes: &[u8]) -> String {
    encode_key(&Sha256::digest(bytes)).chars().take(8).collect()
}

fn invalid_base64(field: &str) -> ApiError {
    ApiError::BadRequest(format!("{field} invalide : base64url attendu"))
}

pub fn hash_auth_key(auth_key: &[u8]) -> Result<(String, Vec<u8>), ApiError> {
    let mut salt_bytes = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt_bytes);
    let salt = SaltString::encode_b64(&salt_bytes)
        .map_err(|err| ApiError::Internal(anyhow::anyhow!("sel Argon2id invalide : {err}")))?;
    let hash = Argon2::default()
        .hash_password(auth_key, &salt)
        .map_err(|err| {
            ApiError::Internal(anyhow::anyhow!("hachage Argon2id impossible : {err}"))
        })?;

    Ok((hash.to_string(), salt_bytes.to_vec()))
}

pub fn verify_auth_key(auth_key: &[u8], auth_verifier: &str) -> bool {
    match PasswordHash::new(auth_verifier) {
        Ok(parsed) => Argon2::default().verify_password(auth_key, &parsed).is_ok(),
        Err(_) => false,
    }
}

pub fn verify_dummy(auth_key: &[u8]) {
    let verifier = DUMMY_VERIFIER.get_or_init(|| {
        let mut salt_bytes = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt_bytes);
        match SaltString::encode_b64(&salt_bytes) {
            Ok(salt) => Argon2::default()
                .hash_password(&[0u8; 32], &salt)
                .map(|hash| hash.to_string())
                .unwrap_or_default(),
            Err(_) => String::new(),
        }
    });

    let _ = verify_auth_key(auth_key, verifier);
}

pub fn check_login_rate_limit(email: &str, ip: &str) -> Result<(), ApiError> {
    check_rate_limit(
        &LOGIN_ATTEMPTS,
        format!("{email}|{ip}"),
        LOGIN_MAX_ATTEMPTS,
        LOGIN_WINDOW,
    )
}

pub fn check_pairing_rate_limit(ip: &str) -> Result<(), ApiError> {
    check_rate_limit(
        &PAIRING_CREATIONS,
        ip.to_string(),
        PAIRING_MAX_CREATIONS,
        PAIRING_WINDOW,
    )
}

fn check_rate_limit(
    store: &'static OnceLock<Mutex<HashMap<String, Vec<Instant>>>>,
    key: String,
    max: usize,
    window: Duration,
) -> Result<(), ApiError> {
    let entries = store.get_or_init(|| Mutex::new(HashMap::new()));
    let mut tracked = entries
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();

    if tracked.len() > RATE_LIMIT_TRACKED_KEYS {
        tracked.retain(|_, seen| {
            seen.iter()
                .any(|instant| now.duration_since(*instant) < window)
        });
    }

    let seen = tracked.entry(key).or_default();
    seen.retain(|instant| now.duration_since(*instant) < window);

    if seen.len() >= max {
        return Err(ApiError::RateLimited);
    }

    seen.push(now);
    Ok(())
}

pub fn bearer_token(headers: &HeaderMap) -> Result<String, ApiError> {
    let value = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;

    let token = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or(ApiError::Unauthorized)?;

    Ok(token.to_string())
}

impl FromRequestParts<AppState> for AuthedUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token_hash = hash_token(&bearer_token(&parts.headers)?);

        let found: Option<(Uuid, Option<Uuid>)> = sqlx::query_as(
            "select s.user_id, s.device_id
             from sessions s
             left join devices d on d.id = s.device_id
             where s.token_hash = $1
               and s.expires_at > now()
               and (s.device_id is null or d.revoked_at is null)",
        )
        .bind(&token_hash)
        .fetch_optional(&state.pool)
        .await?;

        let Some((user_id, device_id)) = found else {
            return Err(ApiError::Unauthorized);
        };

        if let Some(device_id) = device_id {
            sqlx::query("update devices set last_seen_at = now() where id = $1")
                .bind(device_id)
                .execute(&state.pool)
                .await?;
        }

        Ok(AuthedUser { user_id, device_id })
    }
}

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let ip = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(addr)| addr.ip().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        Ok(ClientIp(ip))
    }
}
