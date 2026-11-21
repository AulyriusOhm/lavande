//! `/api/accounts/{id}/…`: sync, threads, messages, flags, move, delete, purge,
//! send.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use lavande_mail::config::{AccountConfig, FolderMapping};
use lavande_mail::error::MailError;
use lavande_mail::imap::{self, ImapSession};
use lavande_mail::model::{Address, Flags, FolderRole, Message, Thread};
use lavande_mail::pgp;
use lavande_mail::smtp::{self, OutgoingMessage};
use lavande_mail::sync as mail_sync;
use lavande_mail::HTML_POLICY_MARKER;
use serde::Deserialize;

use crate::dto::{
    ApiJson, DeleteBulkRequest, DeleteRequest, FlagsBulkRequest, FlagsRequest, FolderReport,
    HtmlImagesResponse, MoveBulkRequest, MoveRequest, PreviewEntry, PreviewRequest, PurgeRequest,
    PurgeResponse, SendRequest, SyncRequest, SyncResponse,
};
use crate::error::ApiError;
use crate::state::AppState;

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;

/// The same bound as `imap`'s snippet batch: one request past it would fetch
/// nothing more.
const MAX_PREVIEW_UIDS: usize = 50;

/// A composition carries its images and attachments in base64, well past
/// axum's 2 MiB default: a few pasted screenshots blow it up before anything
/// is sent.
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/accounts/{id}/sync", post(sync))
        .route("/api/accounts/{id}/folders/{path}/threads", get(threads))
        .route("/api/accounts/{id}/folders/{path}/previews", post(previews))
        .route("/api/accounts/{id}/threads/{thread_id}", get(thread))
        .route(
            "/api/accounts/{id}/folders/{path}/messages/{uid}",
            get(message),
        )
        .route(
            "/api/accounts/{id}/folders/{path}/messages/{uid}/attachments/{index}",
            get(attachment),
        )
        .route(
            "/api/accounts/{id}/folders/{path}/messages/{uid}/html-images",
            get(html_images),
        )
        .route("/api/accounts/{id}/flags", post(set_flags))
        .route("/api/accounts/{id}/move", post(move_message))
        .route("/api/accounts/{id}/delete", post(delete_message))
        .route("/api/accounts/{id}/flags-bulk", post(set_flags_bulk))
        .route("/api/accounts/{id}/move-bulk", post(move_bulk))
        .route("/api/accounts/{id}/delete-bulk", post(delete_bulk))
        .route("/api/accounts/{id}/purge", post(purge_folder))
        .route("/api/accounts/{id}/send", post(send))
        .route("/api/accounts/{id}/drafts", post(save_draft))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
}

#[derive(Deserialize)]
struct Paging {
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Deserialize)]
struct MessageQuery {
    #[serde(default)]
    fetch_body: bool,
}

/// Marque le compte quand le fournisseur a révoqué son autorisation, puis rend
/// l'erreur telle quelle : la route répond son enveloppe 401 habituelle.
async fn revoked(state: &AppState, account_id: &str, error: MailError) -> ApiError {
    let marked = match &error {
        MailError::OAuthRevoked(_) => state.mark_reauth_required(account_id).await,
        _ => Ok(()),
    };
    if let Err(failure) = marked {
        tracing::warn!(
            account = %account_id,
            error = %failure,
            "reconnexion OAuth2 non enregistrée"
        );
    }
    error.into()
}

async fn sync(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> Result<Json<SyncResponse>, ApiError> {
    let request: SyncRequest = if body.is_empty() {
        SyncRequest::default()
    } else {
        serde_json::from_slice(&body).map_err(|error| {
            ApiError::bad_request("config", format!("corps de la requête refusé : {error}"))
        })?
    };
    let config = state.account(&id).await?;
    let selection = state.sync_folders(&id)?;
    let mapping = FolderMapping::default();
    let reports: Vec<FolderReport> = match request.folder_path {
        Some(folder_path) => {
            let mut session = match imap::connect_with(&config, state.tls()).await {
                Ok(session) => session,
                Err(error) => return Err(revoked(&state, &id, error).await),
            };
            let report = imap::sync_folder(
                &mut session,
                state.store(),
                &config.id,
                &folder_path,
                &mapping,
            )
            .await?;
            imap::fetch_previews(
                &config,
                state.tls(),
                state.store(),
                &config.id,
                &folder_path,
                &report.preview_uids,
            )
            .await;
            logout(session).await;
            vec![FolderReport::new(folder_path, report)]
        }
        None => {
            let synced = match mail_sync::sync_account_selected(
                state.store(),
                &config,
                &mapping,
                state.tls(),
                selection.as_deref(),
            )
            .await
            {
                Ok(synced) => synced,
                Err(error) => return Err(revoked(&state, &id, error).await),
            };
            synced
                .into_iter()
                .map(|(folder_path, report)| FolderReport::new(folder_path, report))
                .collect()
        }
    };
    tracing::info!(account = %id, folders = reports.len(), "synchro terminée");
    Ok(Json(SyncResponse { reports }))
}

async fn threads(
    Path((id, folder_path)): Path<(String, String)>,
    Query(paging): Query<Paging>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<Thread>>, ApiError> {
    state.ensure_account(&id)?;
    let limit = paging.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = paging.offset.unwrap_or(0);
    let threads =
        state
            .store()
            .threads_in_folder(&id, &folder_path, limit as i64, offset as i64)?;
    Ok(Json(threads))
}

/// One thread with every one of its messages, all folders included: the
/// reader's conversation view. Bodies stay in the base, nothing is read from
/// IMAP here.
async fn thread(
    Path((id, thread_id)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Thread>, ApiError> {
    state.ensure_account(&id)?;
    state
        .store()
        .thread_full(&id, &thread_id)?
        .map(Json)
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "fil « {thread_id} » introuvable pour le compte « {id} »"
            ))
        })
}

/// Fills the aperçus of a list the store still shows as pending. Best-effort:
/// `fetch_previews` opens its own session and swallows its own failures, so the
/// answer is only what the base holds once it returns.
async fn previews(
    Path((id, folder_path)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<PreviewRequest>,
) -> Result<Json<Vec<PreviewEntry>>, ApiError> {
    require_uids(&request.uids, MAX_PREVIEW_UIDS)?;
    let config = state.account(&id).await?;
    imap::fetch_previews(
        &config,
        state.tls(),
        state.store(),
        &id,
        &folder_path,
        &request.uids,
    )
    .await;
    let mut entries = Vec::with_capacity(request.uids.len());
    for uid in &request.uids {
        let Some(message) = state.store().get_message(&id, &folder_path, *uid)? else {
            continue;
        };
        if message.preview.is_empty() {
            continue;
        }
        entries.push(PreviewEntry {
            uid: *uid,
            preview: message.preview,
        });
    }
    Ok(Json(entries))
}

async fn message(
    Path((id, folder_path, uid)): Path<(String, String, u32)>,
    Query(query): Query<MessageQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Message>, ApiError> {
    let config = state.account(&id).await?;
    let stored = state
        .store()
        .get_message(&id, &folder_path, uid)?
        .ok_or_else(|| unknown(&id, &folder_path, uid))?;
    let body_missing = stored.body_text.is_none() && stored.body_html.is_none();
    // Un corps stocké sans marqueur a été assaini par une politique antérieure :
    // il est relu au serveur, comme un corps évincé, pour être réécrit avec la
    // politique courante.
    let body_stale = stored
        .body_html
        .as_deref()
        .is_some_and(|html| !html.starts_with(HTML_POLICY_MARKER));
    if !query.fetch_body || !(body_missing || body_stale) {
        return Ok(Json(stored));
    }

    let keys = state.keyring_for(&id).await?;
    let refreshed = match imap::connect_with(&config, state.tls()).await {
        Ok(mut session) => {
            let fetched =
                imap::fetch_body(&mut session, state.store(), &id, &folder_path, uid, &keys).await;
            logout(session).await;
            fetched
        }
        Err(error) => Err(error),
    };
    if let Err(error) = refreshed {
        if body_missing {
            return Err(error.into());
        }
        return Ok(Json(stored));
    }
    let message = state
        .store()
        .get_message(&id, &folder_path, uid)?
        .ok_or_else(|| unknown(&id, &folder_path, uid))?;
    Ok(Json(message))
}

/// The bytes of one attachment. They are never stored: the session re-reads
/// the message and hands back the part at `index`, in the order the model lists
/// its `AttachmentMeta` rows.
async fn attachment(
    Path((id, folder_path, uid, index)): Path<(String, String, u32, usize)>,
    State(state): State<Arc<AppState>>,
) -> Result<Response, ApiError> {
    let config = state.account(&id).await?;
    state
        .store()
        .get_message(&id, &folder_path, uid)?
        .ok_or_else(|| unknown(&id, &folder_path, uid))?;
    let keys = state.keyring_for(&id).await?;
    let mut session = imap::connect_with(&config, state.tls()).await?;
    let fetched = imap::fetch_attachment(&mut session, &folder_path, uid, index, &keys).await;
    logout(session).await;
    let part = fetched?.ok_or_else(|| {
        ApiError::not_found(format!(
            "pièce jointe {index} introuvable dans le message {uid} de « {folder_path} »"
        ))
    })?;

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, header_value(&part.mime)?);
    headers.insert(
        header::CONTENT_DISPOSITION,
        header_value(&disposition(&part.filename))?,
    );
    Ok((headers, part.data).into_response())
}

/// The HTML body of one message with its remote images kept. The stored body has
/// them stripped (tracking pixels): this is the explicit, per-message opt-in of
/// the reader, which re-reads the message on the server. The markup leaves
/// sanitized again here, with the same allow-list plus `img`.
async fn html_images(
    Path((id, folder_path, uid)): Path<(String, String, u32)>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<HtmlImagesResponse>, ApiError> {
    let config = state.account(&id).await?;
    let stored = state
        .store()
        .get_message(&id, &folder_path, uid)?
        .ok_or_else(|| unknown(&id, &folder_path, uid))?;
    // Un corps lu sans HTML n'en a pas sur le serveur non plus ; un corps évincé
    // (`body_text` et `body_html` nuls) est relu depuis le serveur.
    if stored.body_html.is_none() && stored.body_text.is_some() {
        return Err(no_html(&folder_path, uid));
    }

    let keys = state.keyring_for(&id).await?;
    let mut session = imap::connect_with(&config, state.tls()).await?;
    let fetched = imap::fetch_html_with_images(&mut session, &folder_path, uid, &keys).await;
    logout(session).await;
    let html = fetched?.ok_or_else(|| no_html(&folder_path, uid))?;
    Ok(Json(HtmlImagesResponse { html }))
}

fn header_value(value: &str) -> Result<HeaderValue, ApiError> {
    HeaderValue::from_str(value).map_err(|_| {
        ApiError::internal(
            "mime",
            format!("en-tête de pièce jointe refusé : « {value} »"),
        )
    })
}

/// `Content-Disposition` of a download: an ASCII fallback for old clients and
/// the RFC 5987 UTF-8 name so accents survive the trip.
fn disposition(filename: &str) -> String {
    let ascii: String = filename
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || "-_. ()".contains(character) {
                character
            } else {
                '_'
            }
        })
        .collect();
    format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
        percent_encoded(filename)
    )
}

fn percent_encoded(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// The server is written first: a refused `UID STORE` leaves the store alone.
async fn set_flags(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<FlagsRequest>,
) -> Result<StatusCode, ApiError> {
    let config = state.account(&id).await?;
    let stored = state
        .store()
        .get_message(&id, &request.folder_path, request.uid)?
        .ok_or_else(|| unknown(&id, &request.folder_path, request.uid))?;
    let flags = Flags {
        unread: request.unread,
        starred: request.starred,
        answered: stored.flags.answered,
    };

    let mut session = imap::connect_with(&config, state.tls()).await?;
    imap::set_flags(&mut session, &request.folder_path, request.uid, &flags).await?;
    logout(session).await;
    state
        .store()
        .set_flags(&id, &request.folder_path, request.uid, &flags)?;
    Ok(StatusCode::NO_CONTENT)
}

/// The rows go before the IMAP session is even opened: an optimistic list is
/// read while `connect_with` + `SELECT` + `MOVE` are in flight, and a row still
/// there brings the message the user just deleted back on screen.
async fn move_message(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<MoveRequest>,
) -> Result<StatusCode, ApiError> {
    let config = state.account(&id).await?;
    imap::drop_locally(state.store(), &id, &request.from_path, &[request.uid])?;
    let mut session =
        session_after_drop(&state, &id, &config, &request.from_path, &[request.uid]).await?;
    imap::move_message(
        &mut session,
        state.store(),
        &id,
        &request.from_path,
        request.uid,
        &request.to_path,
    )
    .await?;
    logout(session).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_message(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<DeleteRequest>,
) -> Result<StatusCode, ApiError> {
    let config = state.account(&id).await?;
    imap::drop_locally(state.store(), &id, &request.folder_path, &[request.uid])?;
    let mut session =
        session_after_drop(&state, &id, &config, &request.folder_path, &[request.uid]).await?;
    imap::delete_message(
        &mut session,
        state.store(),
        &id,
        &request.folder_path,
        request.uid,
    )
    .await?;
    logout(session).await;
    Ok(StatusCode::NO_CONTENT)
}

/// The whole selection goes through one IMAP session and one `UID STORE` per
/// direction; the local rows are written in one statement. Every uid must be
/// stored: a stale one refuses the batch before the connection is opened.
async fn set_flags_bulk(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<FlagsBulkRequest>,
) -> Result<StatusCode, ApiError> {
    require_uids(&request.uids, MAX_BULK_UIDS)?;
    let config = state.account(&id).await?;
    let stored = state.store().flags_in_folder(&id, &request.folder_path)?;
    let flags = Flags {
        unread: request.unread,
        starred: request.starred,
        answered: false,
    };
    let mut updates = Vec::with_capacity(request.uids.len());
    for uid in &request.uids {
        let known = stored
            .get(uid)
            .ok_or_else(|| unknown(&id, &request.folder_path, *uid))?;
        updates.push((
            *uid,
            Flags {
                answered: known.answered,
                ..flags
            },
        ));
    }

    let mut session = imap::connect_with(&config, state.tls()).await?;
    imap::set_flags_many(&mut session, &request.folder_path, &request.uids, &flags).await?;
    logout(session).await;
    state
        .store()
        .set_flags_batch(&id, &request.folder_path, &updates)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn move_bulk(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<MoveBulkRequest>,
) -> Result<StatusCode, ApiError> {
    require_uids(&request.uids, MAX_BULK_UIDS)?;
    let config = state.account(&id).await?;
    imap::drop_locally(state.store(), &id, &request.from_path, &request.uids)?;
    let mut session =
        session_after_drop(&state, &id, &config, &request.from_path, &request.uids).await?;
    imap::move_messages(
        &mut session,
        state.store(),
        &id,
        &request.from_path,
        &request.uids,
        &request.to_path,
    )
    .await?;
    logout(session).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_bulk(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<DeleteBulkRequest>,
) -> Result<StatusCode, ApiError> {
    require_uids(&request.uids, MAX_BULK_UIDS)?;
    let config = state.account(&id).await?;
    imap::drop_locally(state.store(), &id, &request.folder_path, &request.uids)?;
    let mut session =
        session_after_drop(&state, &id, &config, &request.folder_path, &request.uids).await?;
    imap::delete_messages_many(
        &mut session,
        state.store(),
        &id,
        &request.folder_path,
        &request.uids,
    )
    .await?;
    logout(session).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn purge_folder(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<PurgeRequest>,
) -> Result<Json<PurgeResponse>, ApiError> {
    let config = state.account(&id).await?;
    let mut session = imap::connect_with(&config, state.tls()).await?;
    let removed =
        imap::empty_folder(&mut session, state.store(), &id, &request.folder_path).await?;
    logout(session).await;
    Ok(Json(PurgeResponse { removed }))
}

async fn send(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<SendRequest>,
) -> Result<StatusCode, ApiError> {
    let config = state.account(&id).await?;
    let in_reply_to = request.in_reply_to.clone();
    let outgoing = request.into_outgoing(Address {
        name: None,
        email: config.email.clone(),
    })?;
    let (raw, message_id) = submit(&state, &config, &outgoing).await?;
    tracing::info!(
        account = %id,
        signe = outgoing.pgp_sign,
        chiffre = outgoing.pgp_encrypt,
        "message envoyé"
    );

    // Best effort: the mail is gone, a failing Sent copy or \Answered push
    // must not turn a successful send into an error.
    let sent_folder = state
        .store()
        .list_folders(&id)?
        .into_iter()
        .find(|folder| folder.role == FolderRole::Sent);
    if sent_folder.is_some() || in_reply_to.is_some() {
        match imap::connect_with(&config, state.tls()).await {
            Ok(mut session) => {
                if let Some(folder) = sent_folder {
                    if let Err(error) = imap::append_sent(
                        &mut session,
                        state.store(),
                        &id,
                        &folder.path,
                        &raw,
                        message_id.as_deref(),
                    )
                    .await
                    {
                        tracing::warn!(account = %id, %error, "copie vers « Envoyés » impossible");
                    }
                }
                if let Some(reply_id) = &in_reply_to {
                    if let Ok(Some((folder_path, uid))) =
                        state.store().find_by_message_id(&id, reply_id)
                    {
                        let _ = state.store().mark_answered(&id, &folder_path, uid);
                        if let Err(error) =
                            imap::mark_answered(&mut session, &folder_path, uid).await
                        {
                            tracing::debug!(%error, "\\Answered non poussé");
                        }
                    }
                }
                logout(session).await;
            }
            Err(error) => {
                tracing::warn!(account = %id, %error, "connexion IMAP après envoi impossible");
            }
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Saves the composition as a draft in the Drafts folder (IMAP APPEND with
/// `\Draft`). No SMTP submission and no encryption: a draft must stay editable.
async fn save_draft(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    ApiJson(request): ApiJson<SendRequest>,
) -> Result<StatusCode, ApiError> {
    let config = state.account(&id).await?;
    let mut outgoing = request.into_outgoing(Address {
        name: None,
        email: config.email.clone(),
    })?;
    outgoing.pgp_sign = false;
    outgoing.pgp_encrypt = false;
    let drafts_folder = state
        .store()
        .list_folders(&id)?
        .into_iter()
        .find(|folder| folder.role == FolderRole::Drafts)
        .ok_or_else(|| {
            ApiError::bad_request("config", "Aucun dossier Brouillons pour ce compte")
        })?;
    let email = smtp::build_message(&outgoing)?;
    let raw = email.formatted();
    let mut session = imap::connect_with(&config, state.tls()).await?;
    imap::append_draft(&mut session, state.store(), &id, &drafts_folder.path, &raw).await?;
    logout(session).await;
    tracing::info!(account = %id, "brouillon enregistré");
    Ok(StatusCode::NO_CONTENT)
}

/// Signs and/or encrypts when asked, then submits. Returns the exact bytes
/// that went out and the `Message-ID` the Sent copy must be matched with.
async fn submit(
    state: &Arc<AppState>,
    config: &AccountConfig,
    outgoing: &OutgoingMessage,
) -> Result<(Vec<u8>, Option<String>), ApiError> {
    if !outgoing.pgp_sign && !outgoing.pgp_encrypt {
        let email = smtp::build_message(outgoing)?;
        let raw = email.formatted();
        let message_id = email
            .headers()
            .get_raw("Message-ID")
            .map(|value| value.trim_matches(|c| c == '<' || c == '>').to_string());
        smtp::send_built_with(config, email, state.tls()).await?;
        return Ok((raw, message_id));
    }

    let keyring = state.pgp().keyring().await?;
    let signer = keyring.secret_for(&config.email);
    if outgoing.pgp_sign && signer.is_none() {
        return Err(ApiError::bad_request(
            "config",
            "Aucune clé secrète pour signer ce message",
        ));
    }
    let mut recipients = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    if outgoing.pgp_encrypt {
        for recipient in outgoing.to.iter().chain(&outgoing.cc).chain(&outgoing.bcc) {
            if seen
                .iter()
                .any(|email| email.eq_ignore_ascii_case(&recipient.email))
            {
                continue;
            }
            seen.push(recipient.email.clone());
            match keyring.public_for(&recipient.email) {
                Some(key) => recipients.push(key),
                None => missing.push(recipient.email.clone()),
            }
        }
        if !missing.is_empty() {
            return Err(ApiError::bad_request(
                "config",
                format!("Aucune clé publique pour : {}", missing.join(", ")),
            ));
        }
    }
    let sealed = pgp::mime::seal(outgoing, signer, &recipients)?;
    smtp::send_raw_with(config, &sealed.raw, &sealed.envelope, state.tls()).await?;
    let message_id = sealed
        .message_id
        .trim_matches(|c| c == '<' || c == '>')
        .to_string();
    Ok((sealed.raw, Some(message_id)))
}

async fn logout(mut session: ImapSession) {
    if let Err(error) = session.logout().await {
        tracing::debug!(error = %error, "fermeture de la session imap");
    }
}

/// Opens the session of a handler that has already dropped its rows: a server
/// that cannot be reached must not cost the user the message it never lost, so
/// the tombstones go and the next sync puts the rows back.
async fn session_after_drop(
    state: &Arc<AppState>,
    id: &str,
    config: &AccountConfig,
    folder_path: &str,
    uids: &[u32],
) -> Result<ImapSession, ApiError> {
    match imap::connect_with(config, state.tls()).await {
        Ok(session) => Ok(session),
        Err(error) => {
            state.store().forget_tombstones(id, folder_path, uids);
            Err(error.into())
        }
    }
}

/// Keeps the `UID STORE`/`UID MOVE` selector under the ~8 KiB command-line
/// limit servers enforce (RFC 2683): 500 uids of up to 10 digits stay well
/// below it. The client splits larger selections into several requests.
const MAX_BULK_UIDS: usize = 500;

fn require_uids(uids: &[u32], max: usize) -> Result<(), ApiError> {
    if uids.is_empty() {
        return Err(ApiError::bad_request("uids", "liste d'UIDs vide"));
    }
    if uids.len() > max {
        return Err(ApiError::bad_request(
            "uids",
            format!("sélection trop grande : {max} messages maximum par requête"),
        ));
    }
    Ok(())
}

fn unknown(account_id: &str, folder_path: &str, uid: u32) -> ApiError {
    ApiError::not_found(format!(
        "message {uid} introuvable dans « {folder_path} » du compte « {account_id} »"
    ))
}

fn no_html(folder_path: &str, uid: u32) -> ApiError {
    ApiError::not_found(format!(
        "le message {uid} de « {folder_path} » n'a pas de corps HTML à afficher"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_download_keeps_an_ascii_name_and_encodes_the_rest() {
        assert_eq!(
            disposition("facture.pdf"),
            "attachment; filename=\"facture.pdf\"; filename*=UTF-8''facture.pdf"
        );
    }

    #[test]
    fn an_accented_name_survives_the_trip() {
        assert_eq!(
            disposition("relevé.pdf"),
            "attachment; filename=\"relev_.pdf\"; filename*=UTF-8''relev%C3%A9.pdf"
        );
        assert_eq!(
            disposition("capture d’écran.png"),
            "attachment; filename=\"capture d__cran.png\"; \
             filename*=UTF-8''capture%20d%E2%80%99%C3%A9cran.png"
        );
    }
}
