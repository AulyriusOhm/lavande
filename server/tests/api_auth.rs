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
use lavande_sync::{config::Config, db, routes, state::AppState};
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use std::{sync::Arc, time::Duration};
use tower::ServiceExt;
use uuid::Uuid;

const DEFAULT_DATABASE_URL: &str = "postgres://lavande:lavande@127.0.0.1:55432/lavande_sync";

#[allow(dead_code)]
struct Account {
    email: String,
    auth_key: String,
    account_salt: String,
    token: String,
    user_id: String,
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
    format!("test-{}@lavande.test", Uuid::new_v4())
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

async fn register(app: &Router, email: &str) -> (StatusCode, Value, String) {
    let auth_key = random_key(32);
    let account_salt = random_key(16);
    let (status, body) = call(
        app,
        request(
            Method::POST,
            "/api/v1/auth/register",
            Some(json!({
                "email": email,
                "authKey": auth_key,
                "accountSalt": account_salt,
            })),
            None,
        ),
    )
    .await;

    (status, body, account_salt)
}

async fn create_account(app: &Router) -> Account {
    let email = unique_email();
    let auth_key = random_key(32);
    let account_salt = random_key(16);
    let (status, body) = call(
        app,
        request(
            Method::POST,
            "/api/v1/auth/register",
            Some(json!({
                "email": email,
                "authKey": auth_key,
                "accountSalt": account_salt,
            })),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "inscription échouée : {body}");

    Account {
        email,
        auth_key,
        account_salt,
        token: body["token"]
            .as_str()
            .expect("token de session")
            .to_string(),
        user_id: body["userId"].as_str().expect("userId").to_string(),
    }
}

async fn login(app: &Router, email: &str, auth_key: &str) -> (StatusCode, Value) {
    call(
        app,
        request(
            Method::POST,
            "/api/v1/auth/login",
            Some(json!({ "email": email, "authKey": auth_key })),
            None,
        ),
    )
    .await
}

async fn cleanup(state: &AppState, email: &str) {
    let _ = sqlx::query("delete from users where email = $1")
        .bind(email)
        .execute(&state.pool)
        .await;
}

#[tokio::test]
async fn register_then_login_returns_session_and_public_salt() {
    let state = database!();
    let app = routes::router(state.clone());

    let email = unique_email();
    let auth_key = random_key(32);
    let account_salt = random_key(16);

    let (status, body) = call(
        &app,
        request(
            Method::POST,
            "/api/v1/auth/register",
            Some(json!({
                "email": &email,
                "authKey": &auth_key,
                "accountSalt": &account_salt,
            })),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["accountSalt"], account_salt);
    assert!(body["userId"].is_string());
    assert!(body["expiresAt"].is_string());
    let register_token = body["token"].as_str().expect("token").to_string();

    let (status, body) = call(
        &app,
        request(
            Method::GET,
            &format!("/api/v1/auth/salt?email={email}"),
            None,
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["accountSalt"], account_salt);

    let (status, body) = login(&app, &email, &auth_key).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["accountSalt"], account_salt);
    assert!(body["userId"].is_string());
    assert!(body["expiresAt"].is_string());
    assert!(body["keyEnvelope"].is_null());
    let login_token = body["token"].as_str().expect("token").to_string();
    assert_ne!(login_token, register_token);

    let (status, body) = call(
        &app,
        request(Method::GET, "/api/v1/me", None, Some(&login_token)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["email"], email);
    assert_eq!(body["accountSalt"], account_salt);
    assert_eq!(body["devices"], 0);

    cleanup(&state, &email).await;
}

#[tokio::test]
async fn login_with_wrong_auth_key_and_unknown_email_share_one_error() {
    let state = database!();
    let app = routes::router(state.clone());

    let account = create_account(&app).await;

    let (status, body) = login(&app, &account.email, &random_key(32)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["code"], "invalid_credentials");

    let (status, body) = login(&app, &unique_email(), &random_key(32)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["code"], "invalid_credentials");

    cleanup(&state, &account.email).await;
}

#[tokio::test]
async fn salt_of_unknown_email_is_a_404_unknown_email() {
    let state = database!();
    let app = routes::router(state.clone());

    let email = unique_email();
    let (status, body) = call(
        &app,
        request(
            Method::GET,
            &format!("/api/v1/auth/salt?email={email}"),
            None,
            None,
        ),
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["code"], "unknown_email");
}

#[tokio::test]
async fn registering_twice_returns_email_taken() {
    let state = database!();
    let app = routes::router(state.clone());

    let account = create_account(&app).await;
    let (status, body, _) = register(&app, &account.email).await;

    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "email_taken");

    cleanup(&state, &account.email).await;
}

#[tokio::test]
async fn creating_a_device_links_it_to_the_current_session() {
    let state = database!();
    let app = routes::router(state.clone());

    let account = create_account(&app).await;
    let pub_key = random_key(32);

    let (status, body) = call(
        &app,
        request(
            Method::POST,
            "/api/v1/devices",
            Some(json!({
                "name": "MacBook",
                "platform": "desktop",
                "pubKey": &pub_key,
                "schemaVersion": 1,
            })),
            Some(&account.token),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let device_id = body["deviceId"].as_str().expect("deviceId").to_string();

    let (status, body) = call(
        &app,
        request(Method::GET, "/api/v1/devices", None, Some(&account.token)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let devices = body.as_array().expect("liste d'appareils");
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0]["id"], device_id);
    assert_eq!(devices[0]["name"], "MacBook");
    assert_eq!(devices[0]["platform"], "desktop");
    assert_eq!(devices[0]["schemaVersion"], 1);
    assert_eq!(devices[0]["current"], true);
    assert!(devices[0]["lastSeenAt"].is_string());

    let (status, body) = call(
        &app,
        request(
            Method::POST,
            "/api/v1/devices",
            Some(json!({
                "name": "MacBook",
                "platform": "desktop",
                "pubKey": &pub_key,
                "schemaVersion": 1,
            })),
            Some(&account.token),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["deviceId"], device_id);

    let (status, body) = call(
        &app,
        request(Method::GET, "/api/v1/me", None, Some(&account.token)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["devices"], 1);

    cleanup(&state, &account.email).await;
}

#[tokio::test]
async fn revoking_a_device_invalidates_its_sessions() {
    let state = database!();
    let app = routes::router(state.clone());

    let account = create_account(&app).await;

    let (status, body) = call(
        &app,
        request(
            Method::POST,
            "/api/v1/devices",
            Some(json!({
                "name": "Pixel",
                "platform": "mobile",
                "pubKey": random_key(32),
                "schemaVersion": 1,
            })),
            Some(&account.token),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let device_id = body["deviceId"].as_str().expect("deviceId").to_string();

    let (status, body) = call(
        &app,
        request(
            Method::DELETE,
            &format!("/api/v1/devices/{device_id}"),
            None,
            Some(&account.token),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    let (status, body) = call(
        &app,
        request(Method::GET, "/api/v1/devices", None, Some(&account.token)),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["code"], "unauthorized");

    cleanup(&state, &account.email).await;
}

#[tokio::test]
async fn deleting_an_unknown_device_is_a_404() {
    let state = database!();
    let app = routes::router(state.clone());

    let account = create_account(&app).await;
    let (status, body) = call(
        &app,
        request(
            Method::DELETE,
            &format!("/api/v1/devices/{}", Uuid::new_v4()),
            None,
            Some(&account.token),
        ),
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["code"], "not_found");

    cleanup(&state, &account.email).await;
}

#[tokio::test]
async fn password_envelope_is_stored_and_returned_at_login() {
    let state = database!();
    let app = routes::router(state.clone());

    let account = create_account(&app).await;
    let envelope = URL_SAFE_NO_PAD.encode(br#"{"v":1,"ephPub":"a","nonce":"b","ct":"c"}"#);

    let (status, body) = call(
        &app,
        request(
            Method::POST,
            "/api/v1/auth/envelope",
            Some(json!({ "envelope": envelope })),
            Some(&account.token),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    let (status, body) = call(
        &app,
        request(
            Method::POST,
            "/api/v1/auth/login",
            Some(json!({ "email": account.email, "authKey": account.auth_key })),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["keyEnvelope"], envelope);

    let (status, body) = call(
        &app,
        request(
            Method::POST,
            "/api/v1/auth/envelope",
            Some(json!({ "envelope": "pas-du-base64!" })),
            Some(&account.token),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    cleanup(&state, &account.email).await;
}

#[tokio::test]
async fn logout_invalidates_the_current_session() {
    let state = database!();
    let app = routes::router(state.clone());

    let account = create_account(&app).await;

    let (status, body) = call(
        &app,
        request(
            Method::POST,
            "/api/v1/auth/logout",
            None,
            Some(&account.token),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    let (status, body) = call(
        &app,
        request(Method::GET, "/api/v1/me", None, Some(&account.token)),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["code"], "unauthorized");

    cleanup(&state, &account.email).await;
}

#[tokio::test]
async fn device_with_an_old_schema_version_is_refused() {
    let state = database!();
    let app = routes::router(state.clone());

    let account = create_account(&app).await;
    let (status, body) = call(
        &app,
        request(
            Method::POST,
            "/api/v1/devices",
            Some(json!({
                "name": "Vieux build",
                "platform": "desktop",
                "pubKey": random_key(32),
                "schemaVersion": 0,
            })),
            Some(&account.token),
        ),
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "client_too_old");

    cleanup(&state, &account.email).await;
}

#[tokio::test]
async fn login_is_rate_limited_after_ten_attempts_per_minute() {
    let state = database!();
    let app = routes::router(state.clone());

    let account = create_account(&app).await;

    for attempt in 1..=10 {
        let (status, body) = login(&app, &account.email, &random_key(32)).await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "tentative {attempt} : {body}"
        );
        assert_eq!(body["code"], "invalid_credentials");
    }

    let (status, body) = login(&app, &account.email, &random_key(32)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["code"], "rate_limited");

    cleanup(&state, &account.email).await;
}
