//! Tests d'intégration du modèle de décision (Système 1) côté démon :
//! stockage sécurisé de la clé API, probe NeuralWatt `/v1/systemone`,
//! triage unitaire avec extraction TOTP déterministe, cache SQLite et import
//! de décisions synchronisées entre appareils.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

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
    chat_hits: Arc<AtomicUsize>,
}

const MOCK_DESCRIPTION: &str = "Code de vérification GitHub, expire dans 10 minutes.";

/// Comment le fournisseur répond au modèle de chat chargé du résumé.
#[derive(Clone, Copy)]
enum ChatReply {
    Text(&'static str),
    Fails,
}

async fn start_mock_neuralwatt() -> MockServer {
    start_mock(ChatReply::Text(MOCK_DESCRIPTION)).await
}

async fn start_mock_with_broken_chat() -> MockServer {
    start_mock(ChatReply::Fails).await
}

async fn start_mock(chat: ChatReply) -> MockServer {
    let hits = Arc::new(AtomicUsize::new(0));
    let chat_hits = Arc::new(AtomicUsize::new(0));

    let chat_router = match chat {
        ChatReply::Text(content) => Router::new().route(
            "/v1/chat/completions",
            post(
                move |AxumState(counter): AxumState<Arc<AtomicUsize>>,
                      headers: HeaderMap,
                      Json(body): Json<Value>| async move {
                    let auth = headers
                        .get(header::AUTHORIZATION)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    if auth != "Bearer nw-secret-key" {
                        return (
                            StatusCode::UNAUTHORIZED,
                            Json(json!({ "error": "unauthorized" })),
                        );
                    }
                    assert_eq!(body["model"], "nw-flash");
                    assert_eq!(body["messages"][0]["role"], "user");
                    assert!(body["messages"][0]["content"]
                        .as_str()
                        .expect("prompt")
                        .contains("une seule phrase courte en français"));
                    assert_eq!(body["max_tokens"], 400);
                    counter.fetch_add(1, Ordering::SeqCst);
                    (
                        StatusCode::OK,
                        Json(json!({
                            "model": "nw-flash",
                            "choices": [{ "message": { "content": content } }],
                            "usage": { "prompt_tokens": 210, "completion_tokens": 24 }
                        })),
                    )
                },
            ),
        ),
        ChatReply::Fails => Router::new().route(
            "/v1/chat/completions",
            post(
                |AxumState(counter): AxumState<Arc<AtomicUsize>>| async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({ "error": "chat indisponible" })),
                    )
                },
            ),
        ),
    };

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
                        return (
                            StatusCode::UNAUTHORIZED,
                            Json(json!({ "error": "unauthorized" })),
                        );
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
        .with_state(Arc::clone(&hits))
        .merge(chat_router.with_state(Arc::clone(&chat_hits)));

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
        chat_hits,
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
    let (status, initial) = send_json(
        &router,
        &token,
        Method::GET,
        "/api/ai/decision/config",
        None,
    )
    .await;
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
            "description_model": "nw-flash",
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
    assert_eq!(
        triaged["results"][0]["decision"]["description"],
        MOCK_DESCRIPTION
    );
    assert_eq!(mock.hits.load(Ordering::SeqCst), 2);
    assert_eq!(
        mock.chat_hits.load(Ordering::SeqCst),
        1,
        "le résumé vient du modèle de chat, pas des questions"
    );

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
    assert_eq!(
        cached["results"][0]["decision"]["description"], MOCK_DESCRIPTION,
        "le cache SQLite rend la description persistée"
    );
    assert_eq!(mock.hits.load(Ordering::SeqCst), 2);
    assert_eq!(
        mock.chat_hits.load(Ordering::SeqCst),
        1,
        "un cache à jour ne rappelle pas le chat"
    );

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
                "description": "Relevé important à traiter.",
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
    assert_eq!(
        listed[0]["description"], "Relevé important à traiter.",
        "l'import E2EE garde la description reçue"
    );
}

/// Un modèle de chat en panne ne casse pas le triage : la décision structurée
/// passe, la phrase manque.
#[tokio::test]
async fn a_broken_chat_model_leaves_the_triage_descriptionless() {
    let mock = start_mock_with_broken_chat().await;
    let (_dir, state, router, token) = setup_daemon().await;

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
            "description_model": "nw-flash",
            "auth_header": "bearer",
            "api_key": "nw-secret-key"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["ready"], true);
    assert_eq!(saved["description_model"], "nw-flash");

    state
        .store()
        .upsert_account("perso", "Perso", "roman@lavande.fr")
        .expect("account");
    state
        .store()
        .upsert_message(&Message {
            account_id: "perso".into(),
            folder_path: "INBOX".into(),
            uid: 30,
            uidvalidity: 1,
            thread_id: "t-30".into(),
            message_id: Some("<30@github.com>".into()),
            in_reply_to: None,
            references: vec![],
            from: Address {
                name: Some("GitHub Security".into()),
                email: "noreply@github.com".into(),
            },
            to: vec![],
            cc: vec![],
            subject: "Code de vérification 30".into(),
            date: None,
            flags: Flags {
                unread: true,
                starred: false,
                answered: false,
            },
            size: 120,
            pgp: PgpState::None,
            preview: "Votre code de vérification est 482917".into(),
            body_text: Some("Votre code de vérification est 482917.".into()),
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
            "targets": [{ "account_id": "perso", "folder_path": "INBOX", "uid": 30 }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(triaged["results"][0]["decision"]["category"], "auth_totp");
    assert_eq!(triaged["results"][0]["decision"]["totp_code"], "482917");
    assert!(
        triaged["results"][0]["decision"]
            .get("description")
            .is_none(),
        "aucune description quand le chat échoue"
    );
    assert_eq!(
        mock.hits.load(Ordering::SeqCst),
        1,
        "décision structurée servie"
    );
    assert_eq!(
        mock.chat_hits.load(Ordering::SeqCst),
        1,
        "le chat est appelé une fois, en parallèle"
    );

    let (status, listed) = send_json(&router, &token, Method::GET, "/api/ai/decisions", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(listed[0].get("description").is_none());
}

/// Le modèle de résumé est un réglage libre : le défaut ne vaut que pour une
/// config neuve (NeuralWatt → `nw-flash`, les autres → rien), et toute valeur
/// écrite se relit telle quelle, quel que soit le fournisseur.
#[tokio::test]
async fn description_model_defaults_per_provider_and_persists() {
    let (_dir, _state, router, token) = setup_daemon().await;

    let (status, initial) = send_json(
        &router,
        &token,
        Method::GET,
        "/api/ai/decision/config",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(initial["provider"], "neuralwatt");
    assert_eq!(initial["description_model"], "nw-flash");
    assert_eq!(initial["description_source"], "decision");

    let (status, saved) = send_json(
        &router,
        &token,
        Method::PUT,
        "/api/ai/decision/config",
        Some(json!({ "provider": "neuralwatt", "description_model": "  nw-flash  " })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["description_model"], "nw-flash");

    let (_, disabled) = send_json(
        &router,
        &token,
        Method::PUT,
        "/api/ai/decision/config",
        Some(json!({ "provider": "neuralwatt", "description_model": "" })),
    )
    .await;
    assert_eq!(disabled["description_model"], "");

    let (_, reread) = send_json(
        &router,
        &token,
        Method::GET,
        "/api/ai/decision/config",
        None,
    )
    .await;
    assert_eq!(reread["description_model"], "", "désactivé est persisté");

    let (_, baseten) = send_json(
        &router,
        &token,
        Method::PUT,
        "/api/ai/decision/config",
        Some(json!({
            "provider": "baseten",
            "endpoint": "https://inference.baseten.co/v1/systemone"
        })),
    )
    .await;
    assert_eq!(baseten["provider"], "baseten");
    assert_eq!(baseten["description_model"], "");

    let (_, jev) = send_json(
        &router,
        &token,
        Method::PUT,
        "/api/ai/decision/config",
        Some(json!({
            "provider": "jev",
            "endpoint": "https://api.typesafe.ai/v1/decide"
        })),
    )
    .await;
    assert_eq!(jev["description_model"], "");

    let (_, baseten_kept) = send_json(
        &router,
        &token,
        Method::PUT,
        "/api/ai/decision/config",
        Some(json!({ "provider": "baseten", "description_model": " mistral-small " })),
    )
    .await;
    assert_eq!(baseten_kept["description_model"], "mistral-small");

    let (_, custom_neuralwatt) = send_json(
        &router,
        &token,
        Method::PUT,
        "/api/ai/decision/config",
        Some(json!({ "provider": "custom", "description_model": "nw-flash" })),
    )
    .await;
    assert_eq!(
        custom_neuralwatt["description_model"], "nw-flash",
        "un modèle explicite n'est jamais effacé selon le fournisseur"
    );

    let (_, custom_reread) = send_json(
        &router,
        &token,
        Method::GET,
        "/api/ai/decision/config",
        None,
    )
    .await;
    assert_eq!(custom_reread["provider"], "custom");
    assert_eq!(custom_reread["description_model"], "nw-flash");
}

/// Source « llm » : la phrase appartient au LLM du front, le démon n'appelle
/// aucun modèle de chat même quand un modèle de description est configuré.
#[tokio::test]
async fn an_llm_description_source_skips_the_chat_model() {
    let mock = start_mock_neuralwatt().await;
    let (_dir, state, router, token) = setup_daemon().await;

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
            "description_model": "nw-flash",
            "description_source": "LLM",
            "auth_header": "bearer",
            "api_key": "nw-secret-key"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["description_model"], "nw-flash");
    assert_eq!(
        saved["description_source"], "llm",
        "normalisé en minuscules"
    );

    let (_, reread) = send_json(
        &router,
        &token,
        Method::GET,
        "/api/ai/decision/config",
        None,
    )
    .await;
    assert_eq!(
        reread["description_source"], "llm",
        "la source se relit telle quelle"
    );

    state
        .store()
        .upsert_account("perso", "Perso", "roman@lavande.fr")
        .expect("account");
    state
        .store()
        .upsert_message(&Message {
            account_id: "perso".into(),
            folder_path: "INBOX".into(),
            uid: 40,
            uidvalidity: 1,
            thread_id: "t-40".into(),
            message_id: Some("<40@github.com>".into()),
            in_reply_to: None,
            references: vec![],
            from: Address {
                name: Some("GitHub Security".into()),
                email: "noreply@github.com".into(),
            },
            to: vec![],
            cc: vec![],
            subject: "Code de vérification 40".into(),
            date: None,
            flags: Flags {
                unread: true,
                starred: false,
                answered: false,
            },
            size: 120,
            pgp: PgpState::None,
            preview: "Votre code de vérification est 482917".into(),
            body_text: Some("Votre code de vérification est 482917.".into()),
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
            "targets": [{ "account_id": "perso", "folder_path": "INBOX", "uid": 40 }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(triaged["results"][0]["decision"]["category"], "auth_totp");
    assert_eq!(triaged["results"][0]["decision"]["totp_code"], "482917");
    assert!(
        triaged["results"][0]["decision"]
            .get("description")
            .is_none(),
        "le démon ne rédige pas la phrase quand la source est le LLM du front"
    );
    assert_eq!(
        mock.hits.load(Ordering::SeqCst),
        1,
        "décision structurée servie"
    );
    assert_eq!(
        mock.chat_hits.load(Ordering::SeqCst),
        0,
        "aucun appel au modèle de chat"
    );

    let (_, listed) = send_json(&router, &token, Method::GET, "/api/ai/decisions", None).await;
    assert!(listed[0].get("description").is_none());

    let (_, back) = send_json(
        &router,
        &token,
        Method::PUT,
        "/api/ai/decision/config",
        Some(json!({
            "enabled": true,
            "provider": "neuralwatt",
            "endpoint": mock.url,
            "model": "mammoth-1",
            "description_model": "nw-flash",
            "description_source": "decision",
            "auth_header": "bearer",
            "api_key": "nw-secret-key"
        })),
    )
    .await;
    assert_eq!(back["description_source"], "decision");
}

#[tokio::test]
async fn trusted_senders_and_domains_override_phishing_and_spam_in_triage() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&hits);
    let router = Router::new()
        .route(
            "/v1/systemone",
            post(
                move |AxumState(_): AxumState<Arc<AtomicUsize>>| async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    (
                        StatusCode::OK,
                        Json(json!({
                            "model": "mammoth-1",
                            "answers": {
                                "category": {
                                    "type": "choice",
                                    "choice": "spam",
                                    "probabilities": { "spam": 0.95 },
                                    "confidence": 0.95
                                },
                                "urgency": { "type": "score", "score": 1.2 },
                                "needs_reply": { "type": "noul", "noul": 0.1 },
                                "has_task": { "type": "noul", "noul": 0.0 },
                                "has_event": { "type": "noul", "noul": 0.0 },
                                "security": {
                                    "type": "choice",
                                    "choice": "phishing",
                                    "probabilities": { "phishing": 0.96 },
                                    "confidence": 0.96
                                },
                                "cleanup_candidate": { "type": "noul", "noul": 0.8 }
                            },
                            "usage": { "input_tokens": 50, "output_tokens": 0 }
                        })),
                    )
                },
            ),
        )
        .with_state(hits);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    let (_dir, state, app_router, token) = setup_daemon().await;
    let (status, saved) = send_json(
        &app_router,
        &token,
        Method::PUT,
        "/api/ai/decision/config",
        Some(json!({
            "enabled": true,
            "provider": "custom",
            "protocol": "systemone",
            "endpoint": format!("http://{addr}/v1/systemone"),
            "model": "mammoth-1",
            "auth_header": "none",
            "trusted_senders": ["Alertes@Banque.FR"],
            "trusted_domains": ["@boursorama.fr"]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["trusted_senders"], json!(["alertes@banque.fr"]));
    assert_eq!(saved["trusted_domains"], json!(["boursorama.fr"]));

    state
        .store()
        .upsert_account("perso", "Perso", "roman@lavande.fr")
        .expect("account");
    state
        .store()
        .upsert_message(&Message {
            account_id: "perso".into(),
            folder_path: "INBOX".into(),
            uid: 20,
            uidvalidity: 1,
            thread_id: "t-20".into(),
            message_id: Some("<20@boursorama.fr>".into()),
            in_reply_to: None,
            references: vec![],
            from: Address {
                name: Some("Service Client".into()),
                email: "service@boursorama.fr".into(),
            },
            to: vec![],
            cc: vec![],
            subject: "Relevé mensuel".into(),
            date: None,
            flags: Flags {
                unread: true,
                starred: false,
                answered: false,
            },
            size: 100,
            pgp: PgpState::None,
            preview: "Votre relevé".into(),
            body_text: Some("Votre relevé est disponible.".into()),
            body_html: None,
            pgp_detail: None,
            attachments: vec![],
        })
        .expect("msg");

    let (status, triaged) = send_json(
        &app_router,
        &token,
        Method::POST,
        "/api/ai/decisions/triage",
        Some(json!({
            "targets": [{ "account_id": "perso", "folder_path": "INBOX", "uid": 20 }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(triaged["results"][0]["decision"]["security"], "safe");
    assert_eq!(triaged["results"][0]["decision"]["security_conf"], 1.0);
    assert_eq!(triaged["results"][0]["decision"]["category"], "important");
}

#[tokio::test]
async fn spam_category_is_offered_and_kept_only_when_enabled() {
    let sent: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&sent);
    let router = Router::new().route(
        "/v1/systemone",
        post(move |Json(body): Json<Value>| {
            let recorder = Arc::clone(&recorder);
            async move {
                if let Some(questions) = body.get("questions") {
                    recorder.lock().expect("lock").push(questions.clone());
                }
                (
                    StatusCode::OK,
                    Json(json!({
                        "model": "mammoth-1",
                        "answers": {
                            "category": {
                                "type": "choice",
                                "choice": "spam",
                                "probabilities": { "spam": 0.95 },
                                "confidence": 0.95
                            },
                            "urgency": { "type": "score", "score": 1.1 },
                            "needs_reply": { "type": "noul", "noul": 0.1 },
                            "has_task": { "type": "noul", "noul": 0.0 },
                            "has_event": { "type": "noul", "noul": 0.0 },
                            "security": {
                                "type": "choice",
                                "choice": "safe",
                                "probabilities": { "safe": 0.97 },
                                "confidence": 0.97
                            },
                            "cleanup_candidate": { "type": "noul", "noul": 0.6 }
                        },
                        "usage": { "input_tokens": 60, "output_tokens": 0 }
                    })),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    let (_dir, state, app_router, token) = setup_daemon().await;

    // 1. Sans `spam_enabled` : le défaut est désactivé et le modèle ne voit pas la catégorie.
    let (status, saved) = send_json(
        &app_router,
        &token,
        Method::PUT,
        "/api/ai/decision/config",
        Some(json!({
            "enabled": true,
            "provider": "custom",
            "protocol": "systemone",
            "endpoint": format!("http://{addr}/v1/systemone"),
            "model": "mammoth-1",
            "auth_header": "none"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["spam_enabled"], false);

    state
        .store()
        .upsert_account("perso", "Perso", "roman@lavande.fr")
        .expect("account");
    state
        .store()
        .upsert_message(&Message {
            account_id: "perso".into(),
            folder_path: "INBOX".into(),
            uid: 30,
            uidvalidity: 1,
            thread_id: "t-30".into(),
            message_id: Some("<30@promo.example>".into()),
            in_reply_to: None,
            references: vec![],
            from: Address {
                name: Some("Promo".into()),
                email: "offres@promo.example".into(),
            },
            to: vec![],
            cc: vec![],
            subject: "Offre du jour".into(),
            date: None,
            flags: Flags {
                unread: true,
                starred: false,
                answered: false,
            },
            size: 90,
            pgp: PgpState::None,
            preview: "Une offre exceptionnelle".into(),
            body_text: Some("Une offre exceptionnelle vous attend.".into()),
            body_html: None,
            pgp_detail: None,
            attachments: vec![],
        })
        .expect("msg");

    let (status, triaged) = send_json(
        &app_router,
        &token,
        Method::POST,
        "/api/ai/decisions/triage",
        Some(json!({
            "targets": [{ "account_id": "perso", "folder_path": "INBOX", "uid": 30 }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(triaged["results"][0]["decision"]["category"], "info");
    assert_eq!(
        triaged["results"][0]["decision"]["category_probs"]["info"],
        0.95
    );
    assert!(triaged["results"][0]["decision"]["category_probs"]
        .get("spam")
        .is_none());

    let first = sent.lock().expect("lock")[0].clone();
    let criteria = &first["category"]["criteria"];
    assert!(criteria.get("spam").is_none());
    assert_eq!(
        criteria["important"],
        "Message humain ou professionnel important nécessitant attention ou suivi"
    );

    // 2. La liste relue ne garde pas le libellé spam stocké.
    let (status, listed) =
        send_json(&app_router, &token, Method::GET, "/api/ai/decisions", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed[0]["category"], "info");

    // 3. Catégorisation réactivée : la catégorie est de nouveau offerte et conservée.
    let (status, saved) = send_json(
        &app_router,
        &token,
        Method::PUT,
        "/api/ai/decision/config",
        Some(json!({
            "enabled": true,
            "provider": "custom",
            "protocol": "systemone",
            "endpoint": format!("http://{addr}/v1/systemone"),
            "model": "mammoth-1",
            "auth_header": "none",
            "spam_enabled": true
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["spam_enabled"], true);

    let (status, retriaged) = send_json(
        &app_router,
        &token,
        Method::POST,
        "/api/ai/decisions/triage",
        Some(json!({
            "targets": [{ "account_id": "perso", "folder_path": "INBOX", "uid": 30 }],
            "force": true
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(retriaged["results"][0]["decision"]["category"], "spam");
    assert_eq!(
        retriaged["results"][0]["decision"]["category_probs"]["spam"],
        0.95
    );

    let last = sent
        .lock()
        .expect("lock")
        .last()
        .cloned()
        .expect("questions");
    assert!(last["category"]["criteria"].get("spam").is_some());
}

/// Le nombre de mails récents analysés voyage dans la config décision : défaut
/// 40, valeur choisie conservée d'un appel à l'autre, bornée à 10–200.
#[tokio::test]
async fn recent_mail_count_defaults_clamps_and_persists() {
    let (_dir, state, router, token) = setup_daemon().await;

    let (status, initial) = send_json(
        &router,
        &token,
        Method::GET,
        "/api/ai/decision/config",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(initial["recent_mail_count"], 40);

    let (status, saved) = send_json(
        &router,
        &token,
        Method::PUT,
        "/api/ai/decision/config",
        Some(json!({ "recent_mail_count": 120 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["recent_mail_count"], 120);

    let (_, reread) = send_json(
        &router,
        &token,
        Method::GET,
        "/api/ai/decision/config",
        None,
    )
    .await;
    assert_eq!(reread["recent_mail_count"], 120);
    assert_eq!(
        state
            .decision_config()
            .expect("config relue")
            .recent_mail_count,
        120
    );

    let (_, high) = send_json(
        &router,
        &token,
        Method::PUT,
        "/api/ai/decision/config",
        Some(json!({ "recent_mail_count": 500 })),
    )
    .await;
    assert_eq!(high["recent_mail_count"], 200);

    let (_, low) = send_json(
        &router,
        &token,
        Method::PUT,
        "/api/ai/decision/config",
        Some(json!({ "recent_mail_count": 3 })),
    )
    .await;
    assert_eq!(low["recent_mail_count"], 10);
}

/// À l'arrivée IMAP IDLE, le nombre de mails triés suit le réglage de la config
/// décision : l'ancien plafond fixe de 10 est remplacé par `recent_mail_count`.
#[tokio::test]
async fn idle_triage_follows_the_configured_recent_mail_count() {
    use lavande_mail::config::{AccountConfig, AuthConfig, Encryption, Endpoint};
    use lavande_mail::model::{Folder, FolderRole};
    use lavande_mail_api::decision::DecisionConfig;
    use lavande_mail_api::events::triage_selection_uids;

    let mock = start_mock_neuralwatt().await;
    let (_dir, state, _router, _token) = setup_daemon().await;

    let endpoint = Endpoint {
        host: "imap.lavande.fr".to_string(),
        port: 993,
        encryption: Encryption::Tls,
    };
    let config = AccountConfig {
        id: "perso".to_string(),
        label: "Perso".to_string(),
        email: "roman@lavande.fr".to_string(),
        username: "roman@lavande.fr".to_string(),
        imap: endpoint.clone(),
        smtp: Endpoint {
            port: 465,
            ..endpoint
        },
        auth: AuthConfig::Password {
            password: "secret".to_string(),
        },
        synced_folders: None,
        ai_folders: None,
    };
    state
        .add_account(
            &config,
            &[Folder {
                account_id: "perso".to_string(),
                path: "INBOX".to_string(),
                name: "INBOX".to_string(),
                role: FolderRole::Inbox,
                uidvalidity: 1,
                uidnext: 9,
                last_sync_at: None,
                modseq: None,
                delimiter: Some("/".to_string()),
            }],
        )
        .await
        .expect("compte");
    for uid in 1..=24 {
        state
            .store()
            .upsert_message(&Message {
                account_id: "perso".into(),
                folder_path: "INBOX".into(),
                uid,
                uidvalidity: 1,
                thread_id: format!("t-{uid}"),
                message_id: Some(format!("<{uid}@lavande.fr>")),
                in_reply_to: None,
                references: vec![],
                from: Address {
                    name: Some("Camille".into()),
                    email: "camille@lavande.fr".into(),
                },
                to: vec![],
                cc: vec![],
                subject: format!("Sujet {uid}"),
                date: None,
                flags: Flags {
                    unread: true,
                    starred: false,
                    answered: false,
                },
                size: 120,
                pgp: PgpState::None,
                preview: format!("Aperçu {uid}"),
                body_text: Some(format!("Corps {uid}")),
                body_html: None,
                pgp_detail: None,
                attachments: vec![],
            })
            .expect("msg");
    }
    state
        .set_decision_api_key("nw-secret-key")
        .await
        .expect("clé");
    state
        .save_decision_config(&DecisionConfig {
            enabled: true,
            endpoint: mock.url.clone(),
            recent_mail_count: 200,
            ..Default::default()
        })
        .expect("config");

    let first: Vec<u32> = (1..=12).collect();
    triage_selection_uids(&state, "perso", "INBOX", &first).await;

    // Les douze mails passent : l'ancien plafond fixe de 10 n'existe plus.
    assert_eq!(mock.hits.load(Ordering::SeqCst), 12);

    // Réglé plus bas, le même lot est coupé au nombre demandé.
    state
        .save_decision_config(&DecisionConfig {
            enabled: true,
            endpoint: mock.url.clone(),
            recent_mail_count: 10,
            ..Default::default()
        })
        .expect("config");
    let second: Vec<u32> = (13..=24).collect();
    triage_selection_uids(&state, "perso", "INBOX", &second).await;

    assert_eq!(mock.hits.load(Ordering::SeqCst), 22);
}

/// Un lot de triage n'est plus coupé à 50 cibles : le réglage « mails récents
/// analysés » monte jusqu'à 200, et le lot suit. Les cibles inconnues reviennent
/// en erreurs, une par cible — sans appel au modèle.
#[tokio::test]
async fn a_triage_batch_carries_more_than_fifty_targets() {
    let (_dir, state, router, token) = setup_daemon().await;
    state
        .store()
        .upsert_account("perso", "Perso", "roman@lavande.fr")
        .expect("account");

    let targets: Vec<Value> = (1..=120)
        .map(|uid| json!({ "account_id": "perso", "folder_path": "INBOX", "uid": uid }))
        .collect();
    let (status, reply) = send_json(
        &router,
        &token,
        Method::POST,
        "/api/ai/decisions/triage",
        Some(json!({ "targets": targets })),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(reply["errors"].as_array().expect("erreurs").len(), 120);
    assert!(reply["results"].as_array().expect("résultats").is_empty());
}
