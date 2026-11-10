use crate::{
    auth::{self, AuthedUser},
    error::ApiError,
    state::AppState,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;

const MAX_NAME_LEN: usize = 64;
const MAX_PLATFORM_LEN: usize = 32;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDeviceRequest {
    id: Option<Uuid>,
    name: String,
    platform: String,
    pub_key: String,
    schema_version: i32,
}

#[derive(FromRow)]
struct DeviceRow {
    id: Uuid,
    name: String,
    platform: String,
    schema_version: i32,
    last_seen_at: DateTime<Utc>,
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthedUser,
    headers: HeaderMap,
    Json(body): Json<CreateDeviceRequest>,
) -> Result<Response, ApiError> {
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > MAX_NAME_LEN {
        return Err(ApiError::BadRequest(format!(
            "name invalide : 1 à {MAX_NAME_LEN} caractères attendus"
        )));
    }

    let platform = body.platform.trim().to_string();
    if platform.is_empty() || platform.chars().count() > MAX_PLATFORM_LEN {
        return Err(ApiError::BadRequest(format!(
            "platform invalide : 1 à {MAX_PLATFORM_LEN} caractères attendus"
        )));
    }

    let pub_key = auth::decode_key(&body.pub_key, 32, "pubKey")?;

    if body.schema_version < state.config.min_client_schema {
        return Ok(client_too_old());
    }

    let token_hash = auth::hash_token(&auth::bearer_token(&headers)?);
    let mut tx = state.pool.begin().await?;

    let existing: Option<Uuid> = sqlx::query_scalar(
        "select id from devices
         where user_id = $1 and pub_key = $2 and revoked_at is null
         order by last_seen_at desc
         limit 1",
    )
    .bind(user.user_id)
    .bind(&pub_key)
    .fetch_optional(&mut *tx)
    .await?;

    let (device_id, created) = match existing {
        Some(device_id) => {
            sqlx::query("update devices set last_seen_at = now() where id = $1")
                .bind(device_id)
                .execute(&mut *tx)
                .await?;
            (device_id, false)
        }
        None => {
            let device_id = body.id.unwrap_or_else(Uuid::new_v4);
            let taken: Option<Uuid> =
                sqlx::query_scalar("select user_id from devices where id = $1")
                    .bind(device_id)
                    .fetch_optional(&mut *tx)
                    .await?;
            if taken.is_some() {
                return Err(ApiError::Conflict {
                    code: "device_id_taken",
                    message: "cet identifiant d'appareil est déjà utilisé".to_string(),
                });
            }
            sqlx::query(
                "insert into devices (id, user_id, name, platform, pub_key, schema_version)
                 values ($1, $2, $3, $4, $5, $6)",
            )
            .bind(device_id)
            .bind(user.user_id)
            .bind(&name)
            .bind(&platform)
            .bind(&pub_key)
            .bind(body.schema_version)
            .execute(&mut *tx)
            .await?;
            (device_id, true)
        }
    };

    sqlx::query("update sessions set device_id = $1 where token_hash = $2")
        .bind(device_id)
        .bind(&token_hash)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };

    Ok((status, Json(json!({ "deviceId": device_id }))).into_response())
}

pub async fn list(
    State(state): State<AppState>,
    user: AuthedUser,
) -> Result<Json<Vec<Value>>, ApiError> {
    let devices: Vec<DeviceRow> = sqlx::query_as(
        "select id, name, platform, schema_version, last_seen_at
         from devices
         where user_id = $1 and revoked_at is null
         order by last_seen_at desc",
    )
    .bind(user.user_id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(
        devices
            .into_iter()
            .map(|device| {
                json!({
                    "id": device.id,
                    "name": device.name,
                    "platform": device.platform,
                    "schemaVersion": device.schema_version,
                    "lastSeenAt": device.last_seen_at,
                    "current": user.device_id == Some(device.id),
                })
            })
            .collect(),
    ))
}

pub async fn revoke(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(device_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let mut tx = state.pool.begin().await?;

    let revoked: Option<Uuid> = sqlx::query_scalar(
        "update devices set revoked_at = coalesce(revoked_at, now())
         where id = $1 and user_id = $2
         returning id",
    )
    .bind(device_id)
    .bind(user.user_id)
    .fetch_optional(&mut *tx)
    .await?;

    if revoked.is_none() {
        return Err(ApiError::NotFound);
    }

    sqlx::query("delete from sessions where device_id = $1")
        .bind(device_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    Ok(StatusCode::NO_CONTENT)
}

pub(super) fn client_too_old() -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({
            "code": "client_too_old",
            "message": "cette version de l'application n'est plus prise en charge, mettez-la à jour",
        })),
    )
        .into_response()
}
