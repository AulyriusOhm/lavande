//! Tests d'intégration du modèle de décision (Système 1) côté démon :
//! stockage sécurisé de la clé API, probe NeuralWatt `/v1/systemone`,
//! triage unitaire avec extraction TOTP déterministe, cache SQLite et import
//! de décisions synchronisées entre appareils.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State as AxumState;
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use lavande_mail::model::{Address, Flags, Message, PgpState};
use lavande_mail::tls::TlsOptions;
use lavande_mail_api::app;
use lavande_mail_api::discovery::DiscoveryEndpoints;
use lavande_mail_api::secrets::SecretBackend;
use lavande_mail_api::state::AppState;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

struct MockServer {
    url: String,
    hits: Arc<AtomicUsize>,
}

async fn start_mock_neuralwatt() -> MockServer {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&hits);

    let router = Router::new()
        .route(
            "/v1/systemone",
            post(
                |AxumState(counter): AxumState<Arc<AtomicUsize>>,
                 headers: HeaderMap,
                 Json(body): Json<Value>| async move {
                    let auth = headers
                        .get(header::AUTHORIZATION)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    if auth != "Bearer nw-secret-key" {
                        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" })));
                    }
                    counter.fetch_add(1, Ordering::SeqCst);
                    let questions = body
                        .get("questions")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();

                    if questions.contains_key("urgent") {
                        return (
                            StatusCode::OK,
                            Json(json!({
                                "model": "mammoth-1",
                                "answers": {
                                    "urgent": { "type": "noul", "noul": 0.96 }
                                },
                                "usage": { "input_tokens": 38, "output_tokens": 0 },
                                "energy": {
                                    "energy_joules": 12.5,
                                    "energy_kwh": 0.0000035,
                                    "avg_power_watts": 3200.0,
                                    "duration_seconds": 0.042
                                }
                            })),
                        );
                    }

                    (
                        StatusCode::OK,
                        Json(json!({
                            "model": "mammoth-1",
                            "answers": {
                                "category": {
                                    "type": "choice",
                                    "choice": "auth_totp",
                                    "probabilities": {
                                        "auth_totp": 0.97,
                                        "important": 0.02,
                                        "promo": 0.01
                                    },
                                    "confidence": 0.97
                                },
                                "urgency": { "type": "score", "score": 2.1 },
                                "needs_reply": { "type": "noul", "noul": 0.02 },
                                "has_task": { "type": "noul", "noul": 0.04 },
                                "has_event": { "type": "noul", "noul": 0.0 },
                                "security": {
                                    "type": "choice",
                                    "choice": "safe",
                                    "probabilities": { "safe": 0.99, "phishing": 0.01 },
                                    "confidence": 0.99
                                },
                                "cleanup_candidate": { "type": "noul", "noul": 0.93 }
                            },
                            "usage": { "input_tokens": 145, "output_tokens": 0 },
                            "energy": {
                                "energy_joules": 44.2,
                                "energy_kwh": 0.000012,
                                "avg_power_watts": 3500.0,
                                "duration_seconds": 0.07
                            }
                        })),
                    )
                },
            ),
        )
        .with_state(counter);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    MockServer {
        url: format!("http://{addr}/v1/systemone"),
        hits,
    }
}

async fn setup_daemon() -> (TempDir, Arc<AppState>, Router, String) {
    let dir = TempDir::new().expect("tempdir");
    let state = Arc::new(
        AppState::open_with(
            dir.path(),
            TlsOptions::default(),
            DiscoveryEndpoints::default(),
            SecretBackend::File,
        )
        .await
        .expect("open"),
    );
    let token = state.token().to_string();
    let router = app(Arc::clone(&state));
    (dir, state, router, token)
}

async fn send_json(
    router: &Router,
    token: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header(header::AUTHORIZATION, format!("Bearer {token}"));
    let body = match body {
        Some(val) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(serde_json::to_vec(&val).expect("serialize"))
        }
        None => Body::empty(),
    };
    let response = router
        .clone()
        .oneshot(builder.body(body).expect("request"))
        .await
        .expect("oneshot");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("bytes");
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("json")
    };
    (status, json)
}

#[tokio::test]
async fn config_probe_triage_cache_and_sync_import() {
    let mock = start_mock_neuralwatt().await;
    let (_dir, state, router, token) = setup_daemon().await;

    // 1. Config initiale : désactivée, aucune clé exposée.
    let (status, initial) = send_json(&router, &token, Method::GET, "/api/ai/decision/config", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(initial["ready"], false);
    assert_eq!(initial["has_api_key"], false);
    assert!(initial.get("api_key").is_none());

    // 2. Sauvegarde NeuralWatt + clé dans le coffre sécurisé.
    let (status, saved) = send_json(
        &router,
        &token,
        Method::PUT,
        "/api/ai/decision/config",
        Some(json!({
            "enabled": true,
            "provider": "neuralwatt",
            "protocol": "systemone",
            "endpoint": mock.url,
            "model": "mammoth-1",
            "auth_header": "bearer",
            "api_key": "nw-secret-key"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["ready"], true);
    assert_eq!(saved["has_api_key"], true);
    assert!(saved.get("api_key").is_none());

    // 3. Probe NeuralWatt : valide la clé stockée et renvoie latence + énergie.
    let (status, probed) = send_json(
        &router,
        &token,
        Method::POST,
        "/api/ai/decision/probe",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(probed["ok"], true);
    assert_eq!(probed["model"], "mammoth-1");
    assert_eq!(probed["usage"]["prompt_tokens"], 38);
    assert_eq!(probed["energy"]["energy_joules"], 12.5);
    assert_eq!(mock.hits.load(Ordering::SeqCst), 1);

    // 4. Insère un mail TOTP en SQLite puis le trie : extrait le code + cache.
    state
        .store()
        .upsert_account("perso", "Perso", "roman@lavande.fr")
        .expect("account");
    state
        .store()
        .upsert_message(&Message {
            account_id: "perso".into(),
            folder_path: "INBOX".into(),
            uid: 10,
            uidvalidity: 1,
            thread_id: "t-10".into(),
            message_id: Some("<otp-10@github.com>".into()),
            in_reply_to: None,
            references: vec![],
            from: Address {
                name: Some("GitHub Security".into()),
                email: "noreply@github.com".into(),
            },
            to: vec![],
            cc: vec![],
            subject: "Votre code de vérification GitHub".into(),
            date: None,
            flags: Flags {
                unread: true,
                starred: false,
                answered: false,
            },
            size: 120,
            pgp: PgpState::None,
            preview: "Votre code de vérification est 482917".into(),
            body_text: Some("Bonjour,\nVotre code de vérification est 482917.".into()),
            body_html: None,
            pgp_detail: None,
            attachments: vec![],
        })
        .expect("msg");

    let (status, triaged) = send_json(
        &router,
        &token,
        Method::POST,
        "/api/ai/decisions/triage",
        Some(json!({
            "targets": [{ "account_id": "perso", "folder_path": "INBOX", "uid": 10 }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(triaged["results"][0]["cached"], false);
    assert_eq!(triaged["results"][0]["decision"]["category"], "auth_totp");
    assert_eq!(triaged["results"][0]["decision"]["totp_code"], "482917");
    assert_eq!(triaged["results"][0]["decision"]["totp_service"], "GitHub");
    assert_eq!(mock.hits.load(Ordering::SeqCst), 2);

    // 5. Deuxième appel sans `force` : servi depuis le cache SQLite (0 appel HTTP).
    let (status, cached) = send_json(
        &router,
        &token,
        Method::POST,
        "/api/ai/decisions/triage",
        Some(json!({
            "targets": [{ "account_id": "perso", "folder_path": "INBOX", "uid": 10 }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cached["results"][0]["cached"], true);
    assert_eq!(mock.hits.load(Ordering::SeqCst), 2);

    // 6. Import E2EE depuis un autre appareil (PC -> Mobile) via `message_id`.
    let (status, imported) = send_json(
        &router,
        &token,
        Method::POST,
        "/api/ai/decisions/import",
        Some(json!({
            "decisions": [{
                "account_id": "autre-id-pc",
                "folder_path": "INBOX",
                "uid": 999,
                "message_id": "<otp-10@github.com>",
                "content_hash": "remote-hash",
                "schema_version": 1,
                "model": "mammoth-1",
                "category": "important",
                "category_conf": 0.91,
                "category_probs": { "important": 0.91 },
                "urgency": 2.4,
                "needs_reply": 0.85,
                "has_task": 0.72,
                "has_event": 0.1,
                "security": "safe",
                "security_conf": 0.99,
                "cleanup_score": 0.05,
                "decided_at": 1700000100
            }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(imported["imported"], 1);
    assert_eq!(imported["skipped"], 0);

    let (status, listed) = send_json(&router, &token, Method::GET, "/api/ai/decisions", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed[0]["account_id"], "perso");
    assert_eq!(listed[0]["uid"], 10);
    assert_eq!(listed[0]["source"], "synced");
    assert_eq!(listed[0]["category"], "important");
}
