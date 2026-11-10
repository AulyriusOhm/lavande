use axum::{
    body::Body,
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE},
        Method, Request, StatusCode,
    },
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use http_body_util::BodyExt;
use lavande_sync::{auth, config::Config, db, routes, state::AppState};
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use std::{sync::Arc, time::Duration};
use tower::ServiceExt;
use uuid::Uuid;

const DEFAULT_DATABASE_URL: &str = "postgres://lavande:lavande@127.0.0.1:55432/lavande_sync";

struct Account {
    email: String,
    token: String,
    user_id: String,
    account_salt: String,
}

async fn setup() -> Option<AppState> {
    let database_url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| DEFAULT_DATABASE_URL.to_string());

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(3))
        .connect(&database_url)
        .await
        .ok()?;

    if db::migrate(&pool).await.is_err() {
        return None;
    }

    let config = Config::from_env().ok()?;

    Some(AppState {
        pool,
        config: Arc::new(config),
    })
}

macro_rules! database {
    () => {
        match setup().await {
            Some(state) => state,
            None => {
                eprintln!("PostgreSQL injoignable : test ignoré");
                return;
            }
        }
    };
}

fn random_key(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn unique_email() -> String {
    format!("sync-{}@lavande.test", Uuid::new_v4())
}

fn request(method: Method, uri: &str, body: Option<Value>, token: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);

    if body.is_some() {
        builder = builder.header(CONTENT_TYPE, "application/json");
    }

    if let Some(token) = token {
        builder = builder.header(AUTHORIZATION, format!("Bearer {token}"));
    }

    let body = body
        .map(|value| Body::from(value.to_string()))
        .unwrap_or_else(Body::empty);

    builder.body(body).expect("requête construite")
}

async fn call(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(request).await.expect("réponse HTTP");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("corps lisible")
        .to_bytes();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };

    (status, body)
}

async fn create_account(app: &Router) -> Account {
    let email = unique_email();
    let account_salt = random_key(16);
    let (status, body) = call(
        app,
        request(
            Method::POST,
            "/api/v1/auth/register",
            Some(json!({
                "email": &email,
                "authKey": random_key(32),
                "accountSalt": &account_salt,
            })),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "inscription échouée : {body}");

    Account {
        email,
        token: body["token"]
            .as_str()
            .expect("token de session")
            .to_string(),
        user_id: body["userId"].as_str().expect("userId").to_string(),
        account_salt,
    }
}

async fn create_device(app: &Router, token: &str, name: &str, platform: &str) -> String {
    let (status, body) = call(
        app,
        request(
            Method::POST,
            "/api/v1/devices",
            Some(json!({
                "name": name,
                "platform": platform,
                "pubKey": random_key(32),
                "schemaVersion": 1,
            })),
            Some(token),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "appareil refusé : {body}");

    body["deviceId"].as_str().expect("deviceId").to_string()
}

struct Pairing {
    code: String,
    device_id: String,
    public_key: String,
    poll_secret: String,
}

async fn start_pairing(app: &Router, name: &str) -> Pairing {
    let device_id = Uuid::new_v4().to_string();
    let public_key = random_key(32);
    let poll_secret = random_key(24);

    let (status, body) = call(
        app,
        request(
            Method::POST,
            "/api/v1/pairing/start",
            Some(json!({
                "deviceId": &device_id,
                "name": name,
                "platform": "mobile",
                "publicKey": &public_key,
                "schemaVersion": 1,
                "pollSecret": &poll_secret,
            })),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "appairage refusé : {body}");

    Pairing {
        code: body["code"].as_str().expect("code").to_string(),
        device_id,
        public_key,
        poll_secret,
    }
}

async fn claim(app: &Router, token: &str, code: &str) -> (StatusCode, Value) {
    call(
        app,
        request(
            Method::POST,
            "/api/v1/pairing/claim",
            Some(json!({ "code": code })),
            Some(token),
        ),
    )
    .await
}

async fn complete(app: &Router, token: &str, code: &str, envelope: &str) -> (StatusCode, Value) {
    call(
        app,
        request(
            Method::POST,
            "/api/v1/pairing/complete",
            Some(json!({ "code": code, "envelope": envelope })),
            Some(token),
        ),
    )
    .await
}

async fn poll(app: &Router, code: &str, poll_secret: &str) -> (StatusCode, Value) {
    call(
        app,
        request(
            Method::POST,
            &format!("/api/v1/pairing/{code}/poll"),
            Some(json!({ "pollSecret": poll_secret })),
            None,
        ),
    )
    .await
}

fn op(op_id: &str, schema_version: i32) -> Value {
    json!({
        "opId": op_id,
        "kind": "task",
        "entityRef": random_key(22),
        "hlc": "000001234567890-00003-ab12cd",
        "schemaVersion": schema_version,
        "nonce": random_key(24),
        "ciphertext": random_key(48),
    })
}

async fn push(app: &Router, token: &str, ops: Value) -> (StatusCode, Value) {
    call(
        app,
        request(
            Method::POST,
            "/api/v1/ops",
            Some(json!({ "ops": ops })),
            Some(token),
        ),
    )
    .await
}

async fn pull(app: &Router, token: &str, query: &str) -> (StatusCode, Value) {
    call(
        app,
        request(Method::GET, &format!("/api/v1/ops?{query}"), None, Some(token)),
    )
    .await
}

async fn cleanup(state: &AppState, email: &str, codes: &[String]) {
    for code in codes {
        let _ = sqlx::query("delete from pairing_sessions where code_hash = $1")
            .bind(auth::hash_token(&code.to_ascii_uppercase()))
            .execute(&state.pool)
            .await;
    }

    let _ = sqlx::query("delete from users where email = $1")
        .bind(email)
        .execute(&state.pool)
        .await;
}

#[tokio::test]
async fn pairing_end_to_end_gives_the_new_device_a_session() {
    let state = database!();
    let app = routes::router(state.clone());

    let account = create_account(&app).await;
    let pairing = start_pairing(&app, "Pixel").await;

    assert_eq!(pairing.code.len(), 6);
    assert!(pairing
        .code
        .chars()
        .all(|c| "ABCDEFGHJKLMNPQRSTUVWXYZ234567".contains(c)));

    let (status, body) = claim(&app, &account.token, &pairing.code).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["deviceId"], pairing.device_id);
    assert_eq!(body["deviceName"], "Pixel");
    assert_eq!(body["platform"], "mobile");
    assert_eq!(body["schemaVersion"], 1);
    assert_eq!(body["publicKey"], pairing.public_key);
    let expected =
        auth::fingerprint(&URL_SAFE_NO_PAD.decode(&pairing.public_key).expect("clé base64url"));
    assert_eq!(body["fingerprint"], expected);

    let envelope = random_key(96);
    let (status, body) = complete(&app, &account.token, &pairing.code, &envelope).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    let (status, body) = poll(&app, &pairing.code, &pairing.poll_secret).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "completed");
    assert_eq!(body["userId"], account.user_id);
    assert_eq!(body["accountSalt"], account.account_salt);
    assert_eq!(body["envelope"], envelope);
    let token = body["token"].as_str().expect("jeton").to_string();

    let (status, body) = call(
        &app,
        request(Method::GET, "/api/v1/devices", None, Some(&token)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let devices = body.as_array().expect("liste d'appareils");
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0]["id"], pairing.device_id);
    assert_eq!(devices[0]["name"], "Pixel");
    assert_eq!(devices[0]["platform"], "mobile");
    assert_eq!(devices[0]["current"], true);

    cleanup(&state, &account.email, &[pairing.code]).await;
}

#[tokio::test]
async fn polling_a_pairing_twice_is_refused() {
    let state = database!();
    let app = routes::router(state.clone());

    let account = create_account(&app).await;
    let pairing = start_pairing(&app, "Pixel").await;

    let (status, body) = claim(&app, &account.token, &pairing.code).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = complete(&app, &account.token, &pairing.code, &random_key(96)).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    let (status, body) = poll(&app, &pairing.code, &pairing.poll_secret).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "completed");

    let (status, body) = poll(&app, &pairing.code, &pairing.poll_secret).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "pairing_consumed");

    cleanup(&state, &account.email, &[pairing.code]).await;
}

#[tokio::test]
async fn polling_with_a_wrong_poll_secret_is_refused() {
    let state = database!();
    let app = routes::router(state.clone());

    let account = create_account(&app).await;
    let pairing = start_pairing(&app, "Pixel").await;

    let (status, body) = claim(&app, &account.token, &pairing.code).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = complete(&app, &account.token, &pairing.code, &random_key(96)).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    let (status, body) = poll(&app, &pairing.code, &random_key(24)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["code"], "invalid_poll_secret");

    let (status, body) = poll(&app, &pairing.code, &pairing.poll_secret).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "completed");

    cleanup(&state, &account.email, &[pairing.code]).await;
}

#[tokio::test]
async fn an_unknown_pairing_code_is_a_404() {
    let state = database!();
    let app = routes::router(state.clone());

    let account = create_account(&app).await;

    let (status, body) = claim(&app, &account.token, "ZZZZZZ").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["code"], "pairing_unknown");

    let (status, body) = poll(&app, "ZZZZZZ", &random_key(24)).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["code"], "pairing_unknown");

    cleanup(&state, &account.email, &[]).await;
}

#[tokio::test]
async fn push_is_idempotent_and_the_pull_cursor_advances() {
    let state = database!();
    let app = routes::router(state.clone());

    let account = create_account(&app).await;
    let device_id = create_device(&app, &account.token, "MacBook", "desktop").await;

    let first = op("macbook:1", 1);
    let second = op("macbook:2", 1);
    let (status, body) = push(
        &app,
        &account.token,
        json!([first, second, op("macbook:1", 1)]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let acked = body["acked"].as_array().expect("acked");
    assert_eq!(acked.len(), 3);
    assert_eq!(acked[0], "macbook:1");
    assert_eq!(acked[1], "macbook:2");
    assert_eq!(acked[2], "macbook:1");
    let next_seq = body["nextSeq"].as_i64().expect("nextSeq");
    assert!(next_seq > 0);

    let (status, body) = pull(&app, &account.token, "since=0").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let ops = body["ops"].as_array().expect("ops");
    assert_eq!(ops.len(), 2, "une seule ligne par opId malgré le doublon");
    assert_eq!(ops[0]["opId"], "macbook:1");
    assert_eq!(ops[1]["opId"], "macbook:2");
    assert_eq!(ops[0]["deviceId"], device_id);
    assert_eq!(ops[0]["kind"], "task");
    assert_eq!(ops[0]["schemaVersion"], 1);
    assert!(ops[0]["seq"].as_i64().expect("seq") < ops[1]["seq"].as_i64().expect("seq"));
    assert_eq!(body["nextSeq"], next_seq);
    assert_eq!(body["hasMore"], false);

    let (status, body) = push(&app, &account.token, json!([op("macbook:3", 1)])).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let latest_seq = body["nextSeq"].as_i64().expect("nextSeq");
    assert!(latest_seq > next_seq);

    let (status, body) = pull(&app, &account.token, "since=0").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let ops = body["ops"].as_array().expect("ops");
    assert_eq!(ops.len(), 3);
    assert_eq!(ops[2]["opId"], "macbook:3");
    assert_eq!(body["nextSeq"], latest_seq);
    assert_eq!(body["hasMore"], false);

    let (status, body) = pull(&app, &account.token, &format!("since={latest_seq}")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ops"].as_array().expect("ops").len(), 0);
    assert_eq!(body["nextSeq"], latest_seq);
    assert_eq!(body["hasMore"], false);

    let (status, body) = pull(&app, &account.token, "since=0&limit=1").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ops"].as_array().expect("ops").len(), 1);
    assert_eq!(body["hasMore"], true);

    let (status, body) = call(
        &app,
        request(Method::GET, "/api/v1/status", None, Some(&account.token)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["serverSchemaVersion"], 1);
    assert_eq!(body["minClientSchema"], 1);
    assert_eq!(body["headSeq"], latest_seq);

    cleanup(&state, &account.email, &[]).await;
}

#[tokio::test]
async fn pushing_an_op_with_a_future_schema_is_a_426() {
    let state = database!();
    let app = routes::router(state.clone());

    let account = create_account(&app).await;
    create_device(&app, &account.token, "MacBook", "desktop").await;

    let (status, body) = push(&app, &account.token, json!([op("macbook:99", 99)])).await;
    assert_eq!(status, StatusCode::UPGRADE_REQUIRED, "{body}");
    assert_eq!(body["code"], "schema_too_new");

    let (status, body) = pull(&app, &account.token, "since=0").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ops"].as_array().expect("ops").len(), 0);

    cleanup(&state, &account.email, &[]).await;
}

#[tokio::test]
async fn pushing_more_than_two_hundred_ops_is_refused() {
    let state = database!();
    let app = routes::router(state.clone());

    let account = create_account(&app).await;
    create_device(&app, &account.token, "MacBook", "desktop").await;

    let ops: Vec<Value> = (0..201)
        .map(|index| op(&format!("macbook:{index}"), 1))
        .collect();

    let (status, body) = push(&app, &account.token, json!(ops)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["code"], "bad_request");

    cleanup(&state, &account.email, &[]).await;
}

#[tokio::test]
async fn pushing_ops_requires_a_device_session() {
    let state = database!();
    let app = routes::router(state.clone());

    let account = create_account(&app).await;

    let (status, body) = push(&app, &account.token, json!([op("macbook:1", 1)])).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["code"], "device_required");

    cleanup(&state, &account.email, &[]).await;
}

#[tokio::test]
async fn ops_of_another_user_are_invisible() {
    let state = database!();
    let app = routes::router(state.clone());

    let alice = create_account(&app).await;
    let bob = create_account(&app).await;
    create_device(&app, &bob.token, "Pixel", "mobile").await;

    let (status, body) = push(&app, &bob.token, json!([op("pixel:1", 1)])).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["acked"].as_array().expect("acked").len(), 1);

    let (status, body) = pull(&app, &alice.token, "since=0").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ops"].as_array().expect("ops").len(), 0);
    assert_eq!(body["nextSeq"], 0);

    let (status, body) = pull(&app, &bob.token, "since=0").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ops"].as_array().expect("ops").len(), 1);

    cleanup(&state, &alice.email, &[]).await;
    cleanup(&state, &bob.email, &[]).await;
}
