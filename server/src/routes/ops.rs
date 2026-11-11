use crate::{
    auth::{self, AuthedUser},
    error::ApiError,
    state::AppState,
};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;

const MAX_OPS: usize = 200;
const MAX_OP_ID_LEN: usize = 128;
const MAX_ENTITY_REF_LEN: usize = 64;
const MAX_CIPHERTEXT_LEN: usize = 65_536;
const MAX_PULL_LIMIT: i64 = 500;

#[derive(Deserialize)]
pub struct PushRequest {
    ops: Vec<OpInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpInput {
    op_id: String,
    kind: String,
    entity_ref: String,
    hlc: String,
    schema_version: i32,
    nonce: String,
    ciphertext: String,
}

struct ValidOp {
    op_id: String,
    kind: String,
    entity_ref: String,
    hlc: String,
    schema_version: i32,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

#[derive(Deserialize)]
pub struct ListQuery {
    since: Option<i64>,
    limit: Option<i64>,
}

#[derive(FromRow)]
struct OpRow {
    seq: i64,
    op_id: String,
    device_id: Uuid,
    kind: String,
    entity_ref: String,
    hlc: String,
    schema_version: i32,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

pub async fn push(
    State(state): State<AppState>,
    user: AuthedUser,
    Json(body): Json<PushRequest>,
) -> Result<Response, ApiError> {
    let Some(device_id) = user.device_id else {
        return Ok(device_required());
    };

    if body.ops.len() > MAX_OPS {
        return Err(ApiError::BadRequest(format!(
            "ops invalide : {MAX_OPS} opérations maximum par lot"
        )));
    }

    let mut valid = Vec::with_capacity(body.ops.len());
    for op in body.ops {
        valid.push(validate(op)?);
    }

    for op in &valid {
        if op.schema_version > state.config.server_max_schema {
            return Err(ApiError::SchemaTooNew);
        }
    }

    let mut tx = state.pool.begin().await?;

    for op in &valid {
        sqlx::query(
            "insert into ops (user_id, op_id, device_id, entity_ref, kind, hlc,
                              schema_version, nonce, ciphertext)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             on conflict (user_id, op_id) do nothing",
        )
        .bind(user.user_id)
        .bind(&op.op_id)
        .bind(device_id)
        .bind(&op.entity_ref)
        .bind(&op.kind)
        .bind(&op.hlc)
        .bind(op.schema_version)
        .bind(&op.nonce)
        .bind(&op.ciphertext)
        .execute(&mut *tx)
        .await?;
    }

    let next_seq: i64 =
        sqlx::query_scalar("select coalesce(max(seq), 0) from ops where user_id = $1")
            .bind(user.user_id)
            .fetch_one(&mut *tx)
            .await?;

    tx.commit().await?;

    let acked: Vec<&str> = valid.iter().map(|op| op.op_id.as_str()).collect();

    Ok(Json(json!({ "acked": acked, "nextSeq": next_seq })).into_response())
}

pub async fn list(
    State(state): State<AppState>,
    user: AuthedUser,
    Query(params): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let since = params.since.unwrap_or(0);
    if since < 0 {
        return Err(ApiError::BadRequest(
            "since invalide : entier positif ou nul attendu".to_string(),
        ));
    }

    let limit = params.limit.unwrap_or(MAX_PULL_LIMIT);
    if !(1..=MAX_PULL_LIMIT).contains(&limit) {
        return Err(ApiError::BadRequest(format!(
            "limit invalide : entre 1 et {MAX_PULL_LIMIT}"
        )));
    }

    let rows: Vec<OpRow> = sqlx::query_as(
        "select seq, op_id, device_id, kind, entity_ref, hlc, schema_version, nonce, ciphertext
         from ops
         where user_id = $1 and seq > $2
         order by seq asc
         limit $3",
    )
    .bind(user.user_id)
    .bind(since)
    .bind(limit + 1)
    .fetch_all(&state.pool)
    .await?;

    let has_more = rows.len() as i64 > limit;
    let rows: Vec<OpRow> = rows.into_iter().take(limit as usize).collect();
    let next_seq = rows.last().map(|row| row.seq).unwrap_or(since);

    let ops: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            json!({
                "seq": row.seq,
                "opId": row.op_id,
                "deviceId": row.device_id,
                "kind": row.kind,
                "entityRef": row.entity_ref,
                "hlc": row.hlc,
                "schemaVersion": row.schema_version,
                "nonce": auth::encode_key(&row.nonce),
                "ciphertext": auth::encode_key(&row.ciphertext),
            })
        })
        .collect();

    Ok(Json(json!({
        "ops": ops,
        "nextSeq": next_seq,
        "hasMore": has_more,
    })))
}

pub async fn status(
    State(state): State<AppState>,
    user: AuthedUser,
) -> Result<Json<Value>, ApiError> {
    let head_seq: i64 =
        sqlx::query_scalar("select coalesce(max(seq), 0) from ops where user_id = $1")
            .bind(user.user_id)
            .fetch_one(&state.pool)
            .await?;

    Ok(Json(json!({
        "serverSchemaVersion": state.config.server_max_schema,
        "minClientSchema": state.config.min_client_schema,
        "headSeq": head_seq,
    })))
}

fn validate(op: OpInput) -> Result<ValidOp, ApiError> {
    let op_id = op.op_id.trim().to_string();
    if op_id.is_empty() || op_id.chars().count() > MAX_OP_ID_LEN {
        return Err(ApiError::BadRequest(format!(
            "opId invalide : 1 à {MAX_OP_ID_LEN} caractères attendus"
        )));
    }

    if op.kind != "task" && op.kind != "suggestion" && op.kind != "event" {
        return Err(ApiError::BadRequest(
            "kind invalide : task, suggestion ou event attendu".to_string(),
        ));
    }

    let entity_ref = op.entity_ref.trim().to_string();
    if entity_ref.is_empty() || entity_ref.chars().count() > MAX_ENTITY_REF_LEN {
        return Err(ApiError::BadRequest(format!(
            "entityRef invalide : 1 à {MAX_ENTITY_REF_LEN} caractères attendus"
        )));
    }
    if !entity_ref
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(ApiError::BadRequest(
            "entityRef invalide : base64url attendu".to_string(),
        ));
    }

    let hlc = op.hlc.trim().to_string();
    if !valid_hlc(&hlc) {
        return Err(ApiError::BadRequest(
            "hlc invalide : format attendu 15 chiffres-5 chiffres-1 à 8 alphanumériques"
                .to_string(),
        ));
    }

    if op.schema_version < 1 {
        return Err(ApiError::BadRequest(
            "schemaVersion invalide : entier supérieur ou égal à 1 attendu".to_string(),
        ));
    }

    let nonce = auth::decode_key(&op.nonce, 24, "nonce")?;

    let ciphertext = URL_SAFE_NO_PAD
        .decode(op.ciphertext.trim())
        .map_err(|_| ApiError::BadRequest("ciphertext invalide : base64url attendu".to_string()))?;
    if ciphertext.is_empty() || ciphertext.len() > MAX_CIPHERTEXT_LEN {
        return Err(ApiError::BadRequest(format!(
            "ciphertext invalide : 1 à {MAX_CIPHERTEXT_LEN} octets attendus"
        )));
    }

    Ok(ValidOp {
        op_id,
        kind: op.kind,
        entity_ref,
        hlc,
        schema_version: op.schema_version,
        nonce,
        ciphertext,
    })
}

fn valid_hlc(hlc: &str) -> bool {
    let mut parts = hlc.split('-');
    let (Some(ms), Some(counter), Some(node), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };

    ms.len() == 15
        && ms.bytes().all(|byte| byte.is_ascii_digit())
        && counter.len() == 5
        && counter.bytes().all(|byte| byte.is_ascii_digit())
        && (1..=8).contains(&node.len())
        && node.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn device_required() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "code": "device_required",
            "message": "cette session n'est associée à aucun appareil",
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hlc_validation_follows_the_documented_shape() {
        assert!(valid_hlc("000001234567890-00003-ab12cd"));
        assert!(valid_hlc("000000000000001-00000-a"));
        assert!(valid_hlc("999999999999999-99999-ABCD1234"));

        for case in [
            "",
            "000001234567890-00003",
            "000001234567890-00003-ab12cd-1",
            "0000019a4f2b12-00003-ab12cd",
            "000001234567890-0003-ab12cd",
            "000001234567890-00003-",
            "000001234567890-00003-ab12cde99",
            "000001234567890-0003a-ab12cd",
            "abcdefghijklmno-00003-ab12cd",
        ] {
            assert!(!valid_hlc(case), "accepté à tort : {case}");
        }
    }

    #[test]
    fn kind_and_ciphertext_are_validated_before_any_write() {
        let base = || OpInput {
            op_id: "appareil:1".to_string(),
            kind: "task".to_string(),
            entity_ref: "krWPrW0BTkQ6_F74dgExhu".to_string(),
            hlc: "000001234567890-00003-ab12cd".to_string(),
            schema_version: 1,
            nonce: auth::encode_key(&[1u8; 24]),
            ciphertext: auth::encode_key(&[2u8; 48]),
        };

        assert!(validate(base()).is_ok());

        let mut event_kind = base();
        event_kind.kind = "event".to_string();
        assert!(validate(event_kind).is_ok());

        let mut wrong_kind = base();
        wrong_kind.kind = "delete".to_string();
        assert!(validate(wrong_kind).is_err());

        let mut empty_ciphertext = base();
        empty_ciphertext.ciphertext = String::new();
        assert!(validate(empty_ciphertext).is_err());

        let mut short_nonce = base();
        short_nonce.nonce = auth::encode_key(&[1u8; 16]);
        assert!(validate(short_nonce).is_err());
    }
}
