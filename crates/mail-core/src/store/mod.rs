//! SQLite-backed local store for accounts, folders, messages and threads.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row, ToSql};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::error::MailError;
use crate::mime::ParsedMessage;
use crate::model::{Address, AttachmentMeta, Flags, Folder, FolderRole, Message, PgpState, Thread};

const SCHEMA: &str = include_str!("schema.sql");
const SCHEMA_VERSION: i64 = 9;

/// Rows reindexed per statement when `migrate` fills the FTS index of a
/// database written before it existed: a big mailbox must not hold the daemon
/// (or the Android widget) at startup.
const REINDEX_BATCH: i64 = 5000;

/// The rows `evict_bodies_before` empties: selected for reindexing and updated
/// with the same predicate, so the index says exactly what the table says.
const EVICTABLE: &str = "account_id = ?1 AND date < ?2 AND starred = 0 \
     AND (body_text IS NOT NULL OR body_html IS NOT NULL) \
     AND folder_path NOT IN \
     (SELECT path FROM folders WHERE account_id = ?1 AND role = ?3)";
const MESSAGE_COLUMNS: &str = "account_id, folder_path, uid, uidvalidity, thread_id, message_id, \
     in_reply_to, references_json, from_json, to_json, cc_json, subject, date, unread, starred, \
     answered, size, pgp, preview, body_text, body_html, pgp_detail";

/// How long a uid the store just dropped stays tombstoned. Exchange applies a
/// `MOVE` asynchronously: the IDLE watcher of the source folder wakes on the
/// move and resyncs while the server still lists the old uid, which would
/// re-import the message the user just moved away. Ten minutes cover that
/// convergence delay; past it a uid the server still lists is imported again,
/// because the move did not persist.
const TOMBSTONE_TTL: Duration = Duration::from_secs(600);

type Tombstones = HashMap<(String, String, u32), Instant>;

pub struct Store {
    conn: Mutex<Connection>,
    tombstones: Mutex<Tombstones>,
}

/// Per-folder message totals, as stored locally.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FolderCount {
    pub path: String,
    pub total: usize,
    pub unread: usize,
}

/// One address the mailbox has traded mail with, every account merged: what
/// the recipient field and the contacts search propose.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Contact {
    pub email: String,
    pub name: Option<String>,
    pub received: i64,
    pub sent: i64,
    pub last_seen: Option<String>,
}

/// Résultat persisté du modèle de décision (Système 1) pour un message.
/// Stocké localement dans SQLite (calcul local ou hérité via synchro E2EE).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MailDecision {
    pub account_id: String,
    pub folder_path: String,
    pub uid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub content_hash: String,
    pub schema_version: i64,
    pub model: String,
    pub category: String,
    pub category_conf: f64,
    pub category_probs: HashMap<String, f64>,
    pub urgency: f64,
    pub needs_reply: f64,
    pub has_task: f64,
    pub has_event: f64,
    pub security: String,
    pub security_conf: f64,
    pub cleanup_score: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee_conf: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_service: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_folder_conf: Option<f64>,
    pub decided_at: i64,
    #[serde(default = "default_decision_source")]
    pub source: String,
}

fn default_decision_source() -> String {
    "local".to_string()
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, MailError> {
        Self::from_connection(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self, MailError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> Result<Self, MailError> {
        conn.pragma_update(None, "foreign_keys", true)?;
        let _ = conn.query_row("PRAGMA journal_mode=WAL", [], |row| row.get::<_, String>(0));
        conn.busy_timeout(Duration::from_secs(5))?;
        Ok(Self {
            conn: Mutex::new(conn),
            tombstones: Mutex::new(HashMap::new()),
        })
    }

    fn conn(&self) -> Result<MutexGuard<'_, Connection>, MailError> {
        self.conn
            .lock()
            .map_err(|_| MailError::Lock("verrou de la base locale empoisonné".to_string()))
    }

    /// Applies pending migrations. Idempotent.
    pub fn migrate(&self) -> Result<(), MailError> {
        let conn = self.conn()?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        tracing::debug!(version, target = SCHEMA_VERSION, "mail store migration");
        if version < SCHEMA_VERSION {
            conn.execute_batch(SCHEMA)?;
            add_missing_columns(&conn)?;
            backfill_attachment_flags(&conn)?;
            backfill_search_index(&conn)?;
            backfill_contacts(&conn)?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        let healed = heal_reply_threads_on(&conn)?;
        if healed > 0 {
            tracing::info!(healed, "fils de réponse réalignés sur leur parent");
        }
        Ok(())
    }

    pub fn upsert_account(&self, id: &str, label: &str, email: &str) -> Result<(), MailError> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO accounts (id, label, email) VALUES (?1, ?2, ?3) \
             ON CONFLICT(id) DO UPDATE SET label = excluded.label, email = excluded.email",
            params![id, label, email],
        )?;
        Ok(())
    }

    /// Interrupteur PGP of an account: `false` keeps its encrypted bodies
    /// closed. An account the store has never seen is enabled (`accounts.pgp`
    /// defaults to `1`).
    pub fn pgp_enabled(&self, account_id: &str) -> Result<bool, MailError> {
        let conn = self.conn()?;
        let stored: Option<i64> = conn
            .query_row(
                "SELECT pgp FROM accounts WHERE id = ?1",
                params![account_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(stored.unwrap_or(1) != 0)
    }

    /// Sets the PGP switch of one account; nothing else changes.
    pub fn set_pgp_enabled(&self, account_id: &str, enabled: bool) -> Result<(), MailError> {
        let conn = self.conn()?;
        require_one(
            conn.execute(
                "UPDATE accounts SET pgp = ?2 WHERE id = ?1",
                params![account_id, enabled],
            )?,
            "account",
        )
    }

    /// Drops what was decrypted from encrypted messages: the body, the preview
    /// derived from it and the PGP detail. `fetch_body` fills the body again
    /// once the account allows decryption. Returns how many messages were
    /// closed.
    pub fn close_encrypted_bodies(&self, account_id: &str) -> Result<usize, MailError> {
        let conn = self.conn()?;
        Ok(conn.execute(
            "UPDATE messages SET body_text = NULL, body_html = NULL, preview = '', \
             pgp_detail = NULL WHERE account_id = ?1 AND pgp = ?2",
            params![account_id, PgpState::Encrypted.as_str()],
        )?)
    }

    pub fn upsert_folder(&self, folder: &Folder) -> Result<(), MailError> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO folders (account_id, path, name, role, uidvalidity, uidnext, last_sync_at, modseq, delimiter) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
             ON CONFLICT(account_id, path) DO UPDATE SET name = excluded.name, \
             role = excluded.role, uidvalidity = excluded.uidvalidity, \
             uidnext = excluded.uidnext, last_sync_at = excluded.last_sync_at, \
             modseq = excluded.modseq, delimiter = excluded.delimiter",
            params![
                folder.account_id,
                folder.path,
                folder.name,
                folder.role.as_str(),
                folder.uidvalidity,
                folder.uidnext,
                folder.last_sync_at.map(format_date),
                folder.modseq,
                folder.delimiter,
            ],
        )?;
        Ok(())
    }

    pub fn get_folder(&self, account_id: &str, path: &str) -> Result<Option<Folder>, MailError> {
        let conn = self.conn()?;
        get_folder_on(&conn, account_id, path)
    }

    /// Every folder known for one account, by path.
    pub fn list_folders(&self, account_id: &str) -> Result<Vec<Folder>, MailError> {
        let conn = self.conn()?;
        let mut statement = conn.prepare(
            "SELECT account_id, path, name, role, uidvalidity, uidnext, last_sync_at, modseq, \
             delimiter FROM folders WHERE account_id = ?1 ORDER BY path",
        )?;
        let rows = statement.query_map(params![account_id], FolderRow::read)?;
        let mut folders = Vec::new();
        for row in rows {
            folders.push(row?.into_folder()?);
        }
        Ok(folders)
    }

    /// Message totals per folder, computed from the local store (no IMAP round-trip).
    pub fn folder_counts(&self, account_id: &str) -> Result<Vec<FolderCount>, MailError> {
        let conn = self.conn()?;
        let mut statement = conn.prepare(
            "SELECT folder_path, COUNT(*), COALESCE(SUM(unread), 0) \
             FROM messages WHERE account_id = ?1 GROUP BY folder_path ORDER BY folder_path",
        )?;
        let rows = statement.query_map(params![account_id], |row| {
            Ok(FolderCount {
                path: row.get(0)?,
                total: row.get::<_, i64>(1)? as usize,
                unread: row.get::<_, i64>(2)? as usize,
            })
        })?;
        let mut counts = Vec::new();
        for row in rows {
            counts.push(row?);
        }
        Ok(counts)
    }

    /// Every account as `(id, label, email)`, in insertion order.
    pub fn list_accounts(&self) -> Result<Vec<(String, String, String)>, MailError> {
        let conn = self.conn()?;
        let mut statement = conn.prepare("SELECT id, label, email FROM accounts ORDER BY rowid")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        let mut accounts = Vec::new();
        for row in rows {
            accounts.push(row?);
        }
        Ok(accounts)
    }

    /// Drops an account and every row stored under it in one transaction;
    /// returns how many rows were deleted, `0` when the account is unknown.
    pub fn delete_account(&self, account_id: &str) -> Result<usize, MailError> {
        let conn = self.conn()?;
        let tx = conn.unchecked_transaction()?;
        drop_search_index(&tx, "account_id = ?1", params![account_id])?;
        let mut deleted = tx.execute(
            "DELETE FROM messages WHERE account_id = ?1",
            params![account_id],
        )?;
        deleted += tx.execute(
            "DELETE FROM attachments WHERE account_id = ?1",
            params![account_id],
        )?;
        deleted += tx.execute(
            "DELETE FROM folders WHERE account_id = ?1",
            params![account_id],
        )?;
        deleted += tx.execute("DELETE FROM accounts WHERE id = ?1", params![account_id])?;
        tx.commit()?;
        Ok(deleted)
    }

    /// Inserts a message and its attachments, or refreshes the envelope and the
    /// flags of a known one. Idempotent per `(account_id, folder_path, uid)`.
    /// A re-sync carries headers only: it never overwrites the body, the
    /// aperçu or the PGP detail `set_body` wrote, and it leaves the stored
    /// attachments alone when it brings none.
    pub fn upsert_message(&self, message: &Message) -> Result<(), MailError> {
        self.upsert_message_with_attachment(message, !message.attachments.is_empty())
    }

    /// Same write, with the attachment flag the caller read from the headers it
    /// imported: a sync never parses a body, so `multipart/mixed` announced in
    /// the headers is the only hint a message never opened can give. The flag
    /// only ever goes up here; `set_body` overwrites it with the truth.
    pub fn upsert_message_with_attachment(
        &self,
        message: &Message,
        has_attachment: bool,
    ) -> Result<(), MailError> {
        let conn = self.conn()?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO messages (account_id, folder_path, uid, uidvalidity, \
             thread_id, message_id, in_reply_to, references_json, from_json, to_json, cc_json, \
             subject, date, unread, starred, answered, size, pgp, preview, body_text, body_html, \
             pgp_detail, has_attachment) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, \
             ?17, ?18, ?19, ?20, ?21, ?22, ?23) \
             ON CONFLICT(account_id, folder_path, uid) DO UPDATE SET \
             uidvalidity = excluded.uidvalidity, thread_id = excluded.thread_id, \
             message_id = excluded.message_id, in_reply_to = excluded.in_reply_to, \
             references_json = excluded.references_json, from_json = excluded.from_json, \
             to_json = excluded.to_json, cc_json = excluded.cc_json, \
             subject = excluded.subject, date = excluded.date, unread = excluded.unread, \
             starred = excluded.starred, answered = excluded.answered, \
             size = excluded.size, pgp = excluded.pgp, \
             has_attachment = MAX(messages.has_attachment, excluded.has_attachment)",
            params![
                message.account_id,
                message.folder_path,
                message.uid,
                message.uidvalidity,
                message.thread_id,
                message.message_id,
                message.in_reply_to,
                to_json(&message.references)?,
                to_json(&message.from)?,
                to_json(&message.to)?,
                to_json(&message.cc)?,
                message.subject,
                message.date.map(format_date),
                message.flags.unread,
                message.flags.starred,
                message.flags.answered,
                message.size,
                message.pgp.as_str(),
                message.preview,
                message.body_text,
                message.body_html,
                to_json_option(&message.pgp_detail)?,
                has_attachment,
            ],
        )?;
        if !message.attachments.is_empty() {
            tx.execute(
                "DELETE FROM attachments WHERE account_id = ?1 AND folder_path = ?2 AND uid = ?3",
                params![message.account_id, message.folder_path, message.uid],
            )?;
            insert_attachments(
                &tx,
                &message.account_id,
                &message.folder_path,
                message.uid,
                &message.attachments,
            )?;
        }
        index_message(
            &tx,
            rowid_of(&tx, &message.account_id, &message.folder_path, message.uid)?,
        )?;
        collect_contacts(
            &tx,
            &message.account_id,
            &message.folder_path,
            &message.from,
            &message.to,
            &message.cc,
            message.date.map(format_date).as_deref(),
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Writes the aperçu of one message, leaving its body alone: it comes from
    /// the first bytes the sync pulled, not from a stored body.
    pub fn set_preview(
        &self,
        account_id: &str,
        folder_path: &str,
        uid: u32,
        preview: &str,
    ) -> Result<(), MailError> {
        let conn = self.conn()?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE messages SET preview = ?4 \
             WHERE account_id = ?1 AND folder_path = ?2 AND uid = ?3",
            params![account_id, folder_path, uid, preview],
        )?;
        index_message(&tx, rowid_of(&tx, account_id, folder_path, uid)?)?;
        tx.commit()?;
        Ok(())
    }

    /// Drops the bodies loaded before `cutoff` (an RFC 3339 instant), keeping
    /// the aperçu and the drafts, and never touching a starred message: opening
    /// the message again re-reads its body from the server. Returns how many
    /// messages were emptied.
    pub fn evict_bodies_before(&self, account_id: &str, cutoff: &str) -> Result<usize, MailError> {
        let conn = self.conn()?;
        let tx = conn.unchecked_transaction()?;
        let emptied: Vec<i64> = {
            let mut statement =
                tx.prepare(&format!("SELECT rowid FROM messages WHERE {EVICTABLE}"))?;
            let rows = statement
                .query_map(
                    params![account_id, cutoff, FolderRole::Drafts.as_str()],
                    |row| row.get(0),
                )?
                .collect::<Result<_, _>>()?;
            rows
        };
        let count = tx.execute(
            &format!(
                "UPDATE messages SET body_text = NULL, body_html = NULL, pgp_detail = NULL \
                 WHERE {EVICTABLE}"
            ),
            params![account_id, cutoff, FolderRole::Drafts.as_str()],
        )?;
        for rowid in emptied {
            index_message(&tx, rowid)?;
        }
        tx.commit()?;
        Ok(count)
    }

    pub fn get_message(
        &self,
        account_id: &str,
        folder_path: &str,
        uid: u32,
    ) -> Result<Option<Message>, MailError> {
        let conn = self.conn()?;
        let sql = format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages \
             WHERE account_id = ?1 AND folder_path = ?2 AND uid = ?3"
        );
        let row = conn
            .query_row(
                &sql,
                params![account_id, folder_path, uid],
                MessageRow::read,
            )
            .optional()?;
        let Some(row) = row else { return Ok(None) };
        let mut message = row.into_message()?;
        let mut attachments = attachments_of_on(&conn, account_id, folder_path, Some(uid))?;
        message.attachments = attachments.remove(&uid).unwrap_or_default();
        Ok(Some(message))
    }

    /// Flags of every message of a folder, in one query.
    pub fn flags_in_folder(
        &self,
        account_id: &str,
        folder_path: &str,
    ) -> Result<HashMap<u32, Flags>, MailError> {
        let conn = self.conn()?;
        let mut statement = conn.prepare(
            "SELECT uid, unread, starred, answered FROM messages \
             WHERE account_id = ?1 AND folder_path = ?2",
        )?;
        let rows = statement.query_map(params![account_id, folder_path], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                Flags {
                    unread: row.get(1)?,
                    starred: row.get(2)?,
                    answered: row.get(3)?,
                },
            ))
        })?;
        let mut by_uid = HashMap::new();
        for row in rows {
            let (uid, flags) = row?;
            by_uid.insert(uid, flags);
        }
        Ok(by_uid)
    }

    /// User-driven flag change: only `unread` and `starred` are written.
    /// `answered` belongs to the server sync and must survive a concurrent
    /// read-modify-write.
    pub fn set_flags(
        &self,
        account_id: &str,
        folder_path: &str,
        uid: u32,
        flags: &Flags,
    ) -> Result<(), MailError> {
        let conn = self.conn()?;
        let updated = conn.execute(
            "UPDATE messages SET unread = ?4, starred = ?5 \
             WHERE account_id = ?1 AND folder_path = ?2 AND uid = ?3",
            params![account_id, folder_path, uid, flags.unread, flags.starred],
        )?;
        require_one(updated, "message")
    }

    /// Folder and uid of the message carrying this `Message-ID`, if stored.
    pub fn find_by_message_id(
        &self,
        account_id: &str,
        message_id: &str,
    ) -> Result<Option<(String, u32)>, MailError> {
        let conn = self.conn()?;
        let found = conn
            .query_row(
                "SELECT folder_path, uid FROM messages \
                 WHERE account_id = ?1 AND message_id = ?2 LIMIT 1",
                params![account_id, message_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        Ok(found)
    }

    /// Thread the message carrying this `Message-ID` belongs to, if stored.
    pub fn thread_of_message(
        &self,
        account_id: &str,
        message_id: &str,
    ) -> Result<Option<String>, MailError> {
        let conn = self.conn()?;
        thread_of_message_on(&conn, account_id, message_id)
    }

    /// Moves one message to `thread_id`; `false` when it already was there.
    pub fn rethread(
        &self,
        account_id: &str,
        folder_path: &str,
        uid: u32,
        thread_id: &str,
    ) -> Result<bool, MailError> {
        let conn = self.conn()?;
        rethread_on(&conn, account_id, folder_path, uid, thread_id)
    }

    /// Marks a message answered locally; returns whether a row matched.
    pub fn mark_answered(
        &self,
        account_id: &str,
        folder_path: &str,
        uid: u32,
    ) -> Result<bool, MailError> {
        let conn = self.conn()?;
        let updated = conn.execute(
            "UPDATE messages SET answered = 1 \
             WHERE account_id = ?1 AND folder_path = ?2 AND uid = ?3",
            params![account_id, folder_path, uid],
        )?;
        Ok(updated > 0)
    }

    /// Writes many flag sets in one statement inside one transaction; returns
    /// how many rows matched.
    pub fn set_flags_batch(
        &self,
        account_id: &str,
        folder_path: &str,
        updates: &[(u32, Flags)],
    ) -> Result<usize, MailError> {
        if updates.is_empty() {
            return Ok(0);
        }
        let conn = self.conn()?;
        let rows = vec!["(?, ?, ?, ?)"; updates.len()].join(", ");
        let sql = format!(
            "WITH updates (uid, unread, starred, answered) AS (VALUES {rows}) \
             UPDATE messages SET unread = updates.unread, starred = updates.starred, \
             answered = updates.answered FROM updates \
             WHERE messages.account_id = ? AND messages.folder_path = ? \
             AND messages.uid = updates.uid"
        );
        let mut values: Vec<&dyn ToSql> = Vec::with_capacity(updates.len() * 4 + 2);
        for (uid, flags) in updates {
            values.push(uid);
            values.push(&flags.unread);
            values.push(&flags.starred);
            values.push(&flags.answered);
        }
        values.push(&account_id);
        values.push(&folder_path);
        let tx = conn.unchecked_transaction()?;
        let updated = tx.execute(&sql, values.as_slice())?;
        tx.commit()?;
        Ok(updated)
    }

    /// Fills the body of a message back in, once `fetch_body` has read the whole
    /// message: the body, the preview derived from it, the attachments and the
    /// PGP state all come from the same parse, so they land in one write.
    pub fn set_body(
        &self,
        account_id: &str,
        folder_path: &str,
        uid: u32,
        parsed: &ParsedMessage,
    ) -> Result<(), MailError> {
        let conn = self.conn()?;
        let tx = conn.unchecked_transaction()?;
        let updated = tx.execute(
            "UPDATE messages SET body_text = ?4, body_html = ?5, preview = ?6, pgp = ?7, \
             pgp_detail = ?8, has_attachment = ?9 \
             WHERE account_id = ?1 AND folder_path = ?2 AND uid = ?3",
            params![
                account_id,
                folder_path,
                uid,
                parsed.body_text,
                parsed.body_html,
                parsed.preview,
                parsed.pgp.as_str(),
                to_json_option(&parsed.pgp_detail)?,
                !parsed.attachments.is_empty(),
            ],
        )?;
        require_one(updated, "message")?;
        tx.execute(
            "DELETE FROM attachments WHERE account_id = ?1 AND folder_path = ?2 AND uid = ?3",
            params![account_id, folder_path, uid],
        )?;
        insert_attachments(&tx, account_id, folder_path, uid, &parsed.attachments)?;
        index_message(&tx, rowid_of(&tx, account_id, folder_path, uid)?)?;
        tx.commit()?;
        Ok(())
    }

    /// Remembers that `uid` was just dropped from `folder_path`: the import
    /// paths skip it until the tombstone expires, so a resync that still sees
    /// the uid on the server does not bring the message back. Memory only, so a
    /// restart of the daemon forgets every tombstone.
    pub fn tombstone_uid(&self, account_id: &str, folder_path: &str, uid: u32) {
        let now = Instant::now();
        if let Some(mut tombstones) = self.live_tombstones(now) {
            tombstones.insert(uid_key(account_id, folder_path, uid), now);
        }
    }

    /// Whether `uid` was dropped from `folder_path` less than `TOMBSTONE_TTL`
    /// ago.
    pub fn is_tombstoned(&self, account_id: &str, folder_path: &str, uid: u32) -> bool {
        self.live_tombstones(Instant::now())
            .is_some_and(|tombstones| {
                tombstones.contains_key(&uid_key(account_id, folder_path, uid))
            })
    }

    /// Drops the tombstones older than `TOMBSTONE_TTL` as of `now`.
    pub fn prune_tombstones(&self, now: Instant) {
        self.live_tombstones(now);
    }

    fn live_tombstones(&self, now: Instant) -> Option<MutexGuard<'_, Tombstones>> {
        let mut tombstones = self.tombstones.lock().ok()?;
        tombstones.retain(|_, at| now.saturating_duration_since(*at) < TOMBSTONE_TTL);
        Some(tombstones)
    }

    pub fn delete_message(
        &self,
        account_id: &str,
        folder_path: &str,
        uid: u32,
    ) -> Result<(), MailError> {
        let conn = self.conn()?;
        require_one(
            delete_messages_on(&conn, account_id, folder_path, &[uid])?,
            "message",
        )
    }

    /// Drops many messages and their attachments in one transaction; returns
    /// how many messages were stored.
    pub fn delete_messages(
        &self,
        account_id: &str,
        folder_path: &str,
        uids: &[u32],
    ) -> Result<usize, MailError> {
        let conn = self.conn()?;
        delete_messages_on(&conn, account_id, folder_path, uids)
    }

    /// Drops every message of a folder, keeping the folder row itself. Used
    /// when the server announces a new `UIDVALIDITY`.
    pub fn clear_folder(&self, account_id: &str, folder_path: &str) -> Result<usize, MailError> {
        let conn = self.conn()?;
        let tx = conn.unchecked_transaction()?;
        drop_search_index(
            &tx,
            "account_id = ?1 AND folder_path = ?2",
            params![account_id, folder_path],
        )?;
        let deleted = tx.execute(
            "DELETE FROM messages WHERE account_id = ?1 AND folder_path = ?2",
            params![account_id, folder_path],
        )?;
        tx.execute(
            "DELETE FROM attachments WHERE account_id = ?1 AND folder_path = ?2",
            params![account_id, folder_path],
        )?;
        tx.commit()?;
        Ok(deleted)
    }

    /// Local desync: forgets the messages stored for a folder and clears its
    /// sync baseline, so the next pass fetches the folder again from the
    /// server.
    pub fn reset_folder(&self, account_id: &str, folder_path: &str) -> Result<usize, MailError> {
        let deleted = self.clear_folder(account_id, folder_path)?;
        let conn = self.conn()?;
        conn.execute(
            "UPDATE folders SET modseq = NULL, last_sync_at = NULL \
             WHERE account_id = ?1 AND path = ?2",
            params![account_id, folder_path],
        )?;
        Ok(deleted)
    }

    /// Drops a folder row and everything stored under it in one transaction;
    /// returns how many messages went with it. The folder is not recreated by
    /// the next sync: its row is gone.
    pub fn delete_folder(&self, account_id: &str, folder_path: &str) -> Result<usize, MailError> {
        let conn = self.conn()?;
        let tx = conn.unchecked_transaction()?;
        drop_search_index(
            &tx,
            "account_id = ?1 AND folder_path = ?2",
            params![account_id, folder_path],
        )?;
        let deleted = tx.execute(
            "DELETE FROM messages WHERE account_id = ?1 AND folder_path = ?2",
            params![account_id, folder_path],
        )?;
        tx.execute(
            "DELETE FROM attachments WHERE account_id = ?1 AND folder_path = ?2",
            params![account_id, folder_path],
        )?;
        tx.execute(
            "DELETE FROM folders WHERE account_id = ?1 AND path = ?2",
            params![account_id, folder_path],
        )?;
        tx.commit()?;
        Ok(deleted)
    }

    /// Moves the messages replying to `message_id` into `thread_id`. Returns
    /// how many rows changed thread.
    pub fn relink_replies(
        &self,
        account_id: &str,
        message_id: &str,
        thread_id: &str,
    ) -> Result<usize, MailError> {
        let conn = self.conn()?;
        relink_replies_on(&conn, account_id, message_id, thread_id)
    }

    /// Aligns every stored reply whose parent lives in another thread, and
    /// drags the replies of each realigned message along. A reply imported
    /// before its parent, a split left by an older schema: one pass heals what
    /// is stored. Idempotent; returns how many replies were realigned.
    pub fn heal_reply_threads(&self) -> Result<usize, MailError> {
        let conn = self.conn()?;
        heal_reply_threads_on(&conn)
    }

    /// Messages of a folder, newest first. `limit <= 0` returns everything.
    pub fn messages_in_folder(
        &self,
        account_id: &str,
        folder_path: &str,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<Message>, MailError> {
        let conn = self.conn()?;
        messages_in_folder_on(&conn, account_id, folder_path, limit, offset)
    }

    /// The contact list, every account merged: the counters of an address add
    /// up, the most recent name that is not empty wins, `last_seen` is the
    /// latest. The accounts' own addresses never come back. `query` is a
    /// case-insensitive substring of the name or the address, empty for the
    /// whole list.
    pub fn contacts(&self, query: &str, limit: i64) -> Result<Vec<Contact>, MailError> {
        let conn = self.conn()?;
        let mut statement = conn.prepare(CONTACTS_SQL)?;
        let rows = statement.query_map(params![like_pattern(query), limit.max(0)], |row| {
            Ok(Contact {
                email: row.get(0)?,
                name: row.get(1)?,
                received: row.get(2)?,
                sent: row.get(3)?,
                last_seen: row.get(4)?,
            })
        })?;
        let mut contacts = Vec::new();
        for row in rows {
            contacts.push(row?);
        }
        Ok(contacts)
    }

    /// Search over the subjects, correspondents and bodies of one account,
    /// newest first.
    pub fn search_messages(
        &self,
        account_id: &str,
        query: &str,
        limit: i64,
    ) -> Result<Vec<Message>, MailError> {
        self.search(
            account_id,
            &SearchFilter {
                q: query,
                limit,
                ..SearchFilter::default()
            },
        )
    }

    /// The full search: a free-text query, the structured filters, a page. The
    /// text goes through the FTS index when it holds at least one word, and the
    /// filters are plain SQL on `messages`. An empty query with filters is a
    /// filtered listing, with nothing at all an unfiltered one.
    pub fn search(
        &self,
        account_id: &str,
        filter: &SearchFilter<'_>,
    ) -> Result<Vec<Message>, MailError> {
        let conn = self.conn()?;
        let matched = fts_query(filter);
        if matched.is_none() && !filter.q.trim().is_empty() {
            return Ok(Vec::new());
        }
        let bounds = [
            ("folder_path = ", filter.folder),
            ("date >= ", filter.after),
            ("date < ", filter.before),
        ];
        let switches = [
            ("unread", filter.unread.map(i64::from)),
            ("starred", filter.starred.map(i64::from)),
            ("has_attachment", filter.has_attachment.map(i64::from)),
        ];
        let limit = if filter.limit <= 0 { -1 } else { filter.limit };
        let offset = filter.offset.max(0);
        let mut sql = format!("SELECT {MESSAGE_COLUMNS} FROM messages WHERE account_id = ?1");
        let mut values: Vec<&dyn ToSql> = vec![&account_id];
        if let Some(matched) = &matched {
            values.push(matched);
            sql.push_str(&format!(
                " AND rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?{})",
                values.len()
            ));
        }
        for (column, value) in &bounds {
            if let Some(value) = value {
                values.push(value);
                sql.push_str(&format!(" AND {column}?{}", values.len()));
            }
        }
        for (column, value) in &switches {
            if let Some(value) = value {
                values.push(value);
                sql.push_str(&format!(" AND {column} = ?{}", values.len()));
            }
        }
        values.push(&limit);
        sql.push_str(&format!(
            " ORDER BY date DESC, uid DESC LIMIT ?{} OFFSET ?{}",
            values.len(),
            values.len() + 1
        ));
        values.push(&offset);
        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map(values.as_slice(), MessageRow::read)?;
        let mut messages = Vec::new();
        for row in rows {
            messages.push(row?.into_message()?);
        }
        let folders: HashSet<String> = messages
            .iter()
            .map(|message| message.folder_path.clone())
            .collect();
        for folder in folders {
            let mut attachments = attachments_of_on(&conn, account_id, &folder, None)?;
            for message in messages.iter_mut().filter(|m| m.folder_path == folder) {
                message.attachments = attachments.remove(&message.uid).unwrap_or_default();
            }
        }
        Ok(messages)
    }

    /// Threads of a folder, newest activity first, paginated in SQL: only the
    /// requested page of threads is loaded. `limit <= 0` returns everything.
    /// `unread`, `preview` and `participants` are computed on the folder's
    /// messages only.
    pub fn threads_in_folder(
        &self,
        account_id: &str,
        folder_path: &str,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<Thread>, MailError> {
        let conn = self.conn()?;
        let sent = get_folder_on(&conn, account_id, folder_path)?
            .map(|folder| folder.role == FolderRole::Sent)
            .unwrap_or(false);

        let mut statement = conn.prepare(
            "SELECT thread_id FROM messages WHERE account_id = ?1 AND folder_path = ?2 \
             GROUP BY thread_id ORDER BY MAX(date) DESC, MAX(uid) DESC LIMIT ?3 OFFSET ?4",
        )?;
        let ids: Vec<String> = statement
            .query_map(params![account_id, folder_path, limit, offset], |row| {
                row.get(0)
            })?
            .collect::<Result<_, _>>()?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }

        let placeholders = vec!["?"; ids.len()].join(", ");
        let sql = format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages \
             WHERE account_id = ?1 AND folder_path = ?2 AND thread_id IN ({placeholders})"
        );
        let mut values: Vec<&dyn ToSql> = vec![&account_id, &folder_path];
        for id in &ids {
            values.push(id);
        }
        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map(values.as_slice(), MessageRow::read)?;
        let mut groups: HashMap<String, Vec<Message>> = HashMap::new();
        for row in rows {
            let message = row?.into_message()?;
            groups
                .entry(message.thread_id.clone())
                .or_default()
                .push(message);
        }
        let mut attachments = attachments_of_on(&conn, account_id, folder_path, None)?;
        for messages in groups.values_mut() {
            for message in messages {
                message.attachments = attachments.remove(&message.uid).unwrap_or_default();
            }
        }

        let mut threads = Vec::new();
        for id in ids {
            let Some(messages) = groups.remove(&id) else {
                continue;
            };
            if let Some(thread) = build_thread(account_id, id, messages, sent) {
                threads.push(thread);
            }
        }
        Ok(threads)
    }

    /// Every message of one thread, whatever its folder: the reader's
    /// conversation view. The aggregate is the one of `threads_in_folder`
    /// (newest first, `primary` = most recent), read like the inbox: sender
    /// prefix and participants. Bodies come from the base only, the lazy body
    /// contract is untouched.
    pub fn thread_full(
        &self,
        account_id: &str,
        thread_id: &str,
    ) -> Result<Option<Thread>, MailError> {
        let conn = self.conn()?;
        let sql = format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages \
             WHERE account_id = ?1 AND thread_id = ?2 ORDER BY date ASC, uid ASC"
        );
        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map(params![account_id, thread_id], MessageRow::read)?;
        let mut messages = Vec::new();
        for row in rows {
            messages.push(row?.into_message()?);
        }
        if messages.is_empty() {
            return Ok(None);
        }
        let folders: HashSet<String> = messages
            .iter()
            .map(|message| message.folder_path.clone())
            .collect();
        for folder in folders {
            let mut attachments = attachments_of_on(&conn, account_id, &folder, None)?;
            for message in messages.iter_mut().filter(|m| m.folder_path == folder) {
                message.attachments = attachments.remove(&message.uid).unwrap_or_default();
            }
        }
        Ok(build_thread(
            account_id,
            thread_id.to_string(),
            messages,
            false,
        ))
    }
}

/// Aggregates one thread's messages, newest first, around its most recent
/// message. `sent` is the role of the folder the thread is listed in: a sent
/// listing shows no sender prefix and no participants.
fn build_thread(
    account_id: &str,
    id: String,
    mut messages: Vec<Message>,
    sent: bool,
) -> Option<Thread> {
    messages.sort_by(|a, b| b.date.cmp(&a.date).then(b.uid.cmp(&a.uid)));
    let primary = messages.first().cloned()?;
    let subject = messages
        .last()
        .map(|message| message.subject.clone())
        .unwrap_or_default();
    let preview = if sent {
        primary.preview.clone()
    } else {
        format!("{} : {}", sender_label(&primary), primary.preview)
    };
    let mut participants: Vec<String> = Vec::new();
    if !sent {
        for message in &messages {
            let name = sender_name(message);
            if !name.is_empty() && !participants.contains(&name) {
                participants.push(name);
            }
        }
    }
    Some(Thread {
        account_id: account_id.to_string(),
        id,
        count: messages.len(),
        unread: messages
            .iter()
            .filter(|message| message.flags.unread)
            .count(),
        starred: messages.iter().any(|message| message.flags.starred),
        encrypted: messages
            .iter()
            .filter(|message| message.pgp == PgpState::Encrypted)
            .count(),
        attachments: messages
            .iter()
            .map(|message| message.attachments.len())
            .sum(),
        subject,
        preview,
        participants,
        messages,
        primary,
    })
}

fn thread_of_message_on(
    conn: &Connection,
    account_id: &str,
    message_id: &str,
) -> Result<Option<String>, MailError> {
    Ok(conn
        .query_row(
            "SELECT thread_id FROM messages \
             WHERE account_id = ?1 AND message_id = ?2 LIMIT 1",
            params![account_id, message_id],
            |row| row.get(0),
        )
        .optional()?)
}

fn rethread_on(
    conn: &Connection,
    account_id: &str,
    folder_path: &str,
    uid: u32,
    thread_id: &str,
) -> Result<bool, MailError> {
    let updated = conn.execute(
        "UPDATE messages SET thread_id = ?4 \
         WHERE account_id = ?1 AND folder_path = ?2 AND uid = ?3 AND thread_id IS NOT ?4",
        params![account_id, folder_path, uid, thread_id],
    )?;
    Ok(updated > 0)
}

fn relink_replies_on(
    conn: &Connection,
    account_id: &str,
    message_id: &str,
    thread_id: &str,
) -> Result<usize, MailError> {
    let updated = conn.execute(
        "UPDATE messages SET thread_id = ?3 WHERE account_id = ?1 \
         AND (in_reply_to = ?2 OR EXISTS (\
             SELECT 1 FROM json_each(messages.references_json) WHERE value = ?2)) \
         AND thread_id IS NOT ?3",
        params![account_id, message_id, thread_id],
    )?;
    Ok(updated)
}

fn heal_reply_threads_on(conn: &Connection) -> Result<usize, MailError> {
    let split: Vec<(String, String, u32, Option<String>, String)> = {
        let mut statement = conn.prepare(
            "SELECT m.account_id, m.folder_path, m.uid, m.message_id, m.in_reply_to \
             FROM messages m WHERE m.in_reply_to IS NOT NULL AND m.in_reply_to <> '' \
             AND EXISTS (SELECT 1 FROM messages p WHERE p.account_id = m.account_id \
                 AND p.message_id = m.in_reply_to AND p.thread_id IS NOT m.thread_id)",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (account_id, folder_path, uid, message_id, in_reply_to) in &split {
        let Some(parent_thread) = thread_of_message_on(conn, account_id, in_reply_to)? else {
            continue;
        };
        rethread_on(conn, account_id, folder_path, *uid, &parent_thread)?;
        if let Some(message_id) = message_id {
            relink_replies_on(conn, account_id, message_id, &parent_thread)?;
        }
    }
    Ok(split.len())
}

fn get_folder_on(
    conn: &Connection,
    account_id: &str,
    path: &str,
) -> Result<Option<Folder>, MailError> {
    conn.query_row(
        "SELECT account_id, path, name, role, uidvalidity, uidnext, last_sync_at, modseq, \
         delimiter FROM folders WHERE account_id = ?1 AND path = ?2",
        params![account_id, path],
        FolderRow::read,
    )
    .optional()?
    .map(FolderRow::into_folder)
    .transpose()
}

fn messages_in_folder_on(
    conn: &Connection,
    account_id: &str,
    folder_path: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<Message>, MailError> {
    let sql = format!(
        "SELECT {MESSAGE_COLUMNS} FROM messages \
         WHERE account_id = ?1 AND folder_path = ?2 \
         ORDER BY date DESC, uid DESC LIMIT ?3 OFFSET ?4"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(
        params![account_id, folder_path, limit, offset],
        MessageRow::read,
    )?;
    let mut messages = Vec::new();
    for row in rows {
        messages.push(row?.into_message()?);
    }
    let mut attachments = attachments_of_on(conn, account_id, folder_path, None)?;
    for message in &mut messages {
        message.attachments = attachments.remove(&message.uid).unwrap_or_default();
    }
    Ok(messages)
}

fn insert_attachments(
    conn: &Connection,
    account_id: &str,
    folder_path: &str,
    uid: u32,
    attachments: &[AttachmentMeta],
) -> Result<(), MailError> {
    for (index, attachment) in attachments.iter().enumerate() {
        conn.execute(
            "INSERT INTO attachments (account_id, folder_path, uid, idx, filename, mime, \
             size, inline) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                account_id,
                folder_path,
                uid,
                index as i64,
                attachment.filename,
                attachment.mime,
                attachment.size as i64,
                attachment.inline,
            ],
        )?;
    }
    Ok(())
}

fn attachments_of_on(
    conn: &Connection,
    account_id: &str,
    folder_path: &str,
    uid: Option<u32>,
) -> Result<HashMap<u32, Vec<AttachmentMeta>>, MailError> {
    let mut statement = conn.prepare(
        "SELECT uid, filename, mime, size, inline FROM attachments \
         WHERE account_id = ?1 AND folder_path = ?2 AND (?3 IS NULL OR uid = ?3) \
         ORDER BY uid, idx",
    )?;
    let rows = statement.query_map(params![account_id, folder_path, uid], |row| {
        Ok((
            row.get::<_, u32>(0)?,
            AttachmentMeta {
                filename: row.get(1)?,
                mime: row.get(2)?,
                size: row.get::<_, i64>(3)? as u64,
                inline: row.get(4)?,
            },
        ))
    })?;
    let mut attachments: HashMap<u32, Vec<AttachmentMeta>> = HashMap::new();
    for row in rows {
        let (uid, attachment) = row?;
        attachments.entry(uid).or_default().push(attachment);
    }
    Ok(attachments)
}

fn delete_messages_on(
    conn: &Connection,
    account_id: &str,
    folder_path: &str,
    uids: &[u32],
) -> Result<usize, MailError> {
    if uids.is_empty() {
        return Ok(0);
    }
    let placeholders = vec!["?"; uids.len()].join(", ");
    let mut values: Vec<&dyn ToSql> = vec![&account_id, &folder_path];
    values.extend(uids.iter().map(|uid| uid as &dyn ToSql));
    let tx = conn.unchecked_transaction()?;
    drop_search_index(
        &tx,
        &format!("account_id = ?1 AND folder_path = ?2 AND uid IN ({placeholders})"),
        values.as_slice(),
    )?;
    let deleted = tx.execute(
        &format!(
            "DELETE FROM messages WHERE account_id = ?1 AND folder_path = ?2 \
             AND uid IN ({placeholders})"
        ),
        values.as_slice(),
    )?;
    tx.execute(
        &format!(
            "DELETE FROM attachments WHERE account_id = ?1 AND folder_path = ?2 \
             AND uid IN ({placeholders})"
        ),
        values.as_slice(),
    )?;
    tx.commit()?;
    Ok(deleted)
}

struct FolderRow {
    account_id: String,
    path: String,
    name: String,
    role: String,
    uidvalidity: u32,
    uidnext: u32,
    last_sync_at: Option<String>,
    modseq: Option<u64>,
    delimiter: Option<String>,
}

impl FolderRow {
    fn read(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            account_id: row.get(0)?,
            path: row.get(1)?,
            name: row.get(2)?,
            role: row.get(3)?,
            uidvalidity: row.get(4)?,
            uidnext: row.get(5)?,
            last_sync_at: row.get(6)?,
            modseq: row.get(7)?,
            delimiter: row.get(8)?,
        })
    }

    fn into_folder(self) -> Result<Folder, MailError> {
        Ok(Folder {
            account_id: self.account_id,
            path: self.path,
            name: self.name,
            role: FolderRole::from_db(&self.role),
            uidvalidity: self.uidvalidity,
            uidnext: self.uidnext,
            last_sync_at: parse_date(self.last_sync_at.as_deref())?,
            modseq: self.modseq,
            delimiter: self.delimiter,
        })
    }
}

struct MessageRow {
    account_id: String,
    folder_path: String,
    uid: u32,
    uidvalidity: u32,
    thread_id: String,
    message_id: Option<String>,
    in_reply_to: Option<String>,
    references_json: String,
    from_json: String,
    to_json: String,
    cc_json: String,
    subject: String,
    date: Option<String>,
    unread: bool,
    starred: bool,
    answered: bool,
    size: u32,
    pgp: String,
    preview: String,
    body_text: Option<String>,
    body_html: Option<String>,
    pgp_detail: Option<String>,
}

impl MessageRow {
    fn read(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            account_id: row.get(0)?,
            folder_path: row.get(1)?,
            uid: row.get(2)?,
            uidvalidity: row.get(3)?,
            thread_id: row.get(4)?,
            message_id: row.get(5)?,
            in_reply_to: row.get(6)?,
            references_json: row.get(7)?,
            from_json: row.get(8)?,
            to_json: row.get(9)?,
            cc_json: row.get(10)?,
            subject: row.get(11)?,
            date: row.get(12)?,
            unread: row.get(13)?,
            starred: row.get(14)?,
            answered: row.get(15)?,
            size: row.get(16)?,
            pgp: row.get(17)?,
            preview: row.get(18)?,
            body_text: row.get(19)?,
            body_html: row.get(20)?,
            pgp_detail: row.get(21)?,
        })
    }

    fn into_message(self) -> Result<Message, MailError> {
        Ok(Message {
            account_id: self.account_id,
            folder_path: self.folder_path,
            uid: self.uid,
            uidvalidity: self.uidvalidity,
            thread_id: self.thread_id,
            message_id: self.message_id,
            in_reply_to: self.in_reply_to,
            references: from_json(&self.references_json)?,
            from: from_json(&self.from_json)?,
            to: from_json(&self.to_json)?,
            cc: from_json(&self.cc_json)?,
            subject: self.subject,
            date: parse_date(self.date.as_deref())?,
            flags: Flags {
                unread: self.unread,
                starred: self.starred,
                answered: self.answered,
            },
            size: self.size,
            pgp: PgpState::from_db(&self.pgp),
            pgp_detail: from_json(self.pgp_detail.as_deref().unwrap_or_default())?,
            preview: self.preview,
            body_text: self.body_text,
            body_html: self.body_html,
            attachments: Vec::new(),
        })
    }
}

/// What a search looks for. `q` is free text, matched against the subject, the
/// correspondents and the body; `from`, `to` and `subject` narrow one field
/// each; `after` and `before` are RFC 3339 instants, `after` inclusive,
/// `before` exclusive. Every field is optional: no query and no filter lists the
/// account newest first.
#[derive(Clone, Debug, Default)]
pub struct SearchFilter<'a> {
    pub q: &'a str,
    pub folder: Option<&'a str>,
    pub from: Option<&'a str>,
    pub to: Option<&'a str>,
    pub subject: Option<&'a str>,
    pub unread: Option<bool>,
    pub starred: Option<bool>,
    pub has_attachment: Option<bool>,
    pub before: Option<&'a str>,
    pub after: Option<&'a str>,
    pub limit: i64,
    pub offset: i64,
}

/// The FTS5 expression of the text part of a search, `None` when there is no
/// word to match. Every word is quoted and taken as a prefix, so no character
/// the user types can reach the query grammar: a query made of punctuation
/// alone (`%`, `"`, `(`) simply has nothing to look for.
fn fts_query(filter: &SearchFilter<'_>) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(tokens) = match_tokens(filter.q) {
        parts.push(format!("({tokens})"));
    }
    for (column, value) in [
        ("subject", filter.subject),
        ("sender", filter.from),
        ("recipients", filter.to),
    ] {
        if let Some(tokens) = value.and_then(match_tokens) {
            parts.push(format!("{column} : ({tokens})"));
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join(" AND "))
}

/// The words of a text, each as a quoted FTS5 prefix phrase and joined by
/// `AND`; `None` when the text holds no word at all.
fn match_tokens(text: &str) -> Option<String> {
    let tokens: Vec<String> = text
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(|token| format!("\"{token}\"*"))
        .collect();
    if tokens.is_empty() {
        return None;
    }
    Some(tokens.join(" AND "))
}

/// Rewrites the index entry of one message from the row it points at: the only
/// place the FTS table is written, so every write path indexes the same
/// columns. `body` is indexed only while the message still holds one — an
/// evicted body must stop matching.
fn index_message(conn: &Connection, rowid: i64) -> Result<(), MailError> {
    conn.execute("DELETE FROM messages_fts WHERE rowid = ?1", params![rowid])?;
    let row = conn
        .query_row(
            "SELECT subject, from_json, to_json, cc_json, body_text FROM messages \
             WHERE rowid = ?1",
            params![rowid],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((subject, from_json, to_json, cc_json, body)) = row else {
        return Ok(());
    };
    let sender = sender_text(&from_json)?;
    let recipients = [addresses_text(&to_json)?, addresses_text(&cc_json)?].join(" ");
    conn.execute(
        "INSERT INTO messages_fts (rowid, subject, sender, recipients, body) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![rowid, subject, sender, recipients, body.unwrap_or_default()],
    )?;
    Ok(())
}

/// "name email" of a stored `from_json`, empty when the sender is unknown.
fn sender_text(raw: &str) -> Result<String, MailError> {
    let sender: Address = from_json(raw)?;
    Ok([sender.name.unwrap_or_default(), sender.email]
        .join(" ")
        .trim()
        .to_string())
}

/// "name email" of every stored recipient of `to_json` or `cc_json`.
fn addresses_text(raw: &str) -> Result<String, MailError> {
    let addresses: Vec<Address> = from_json(raw)?;
    Ok(addresses
        .iter()
        .map(|address| {
            [
                address.name.clone().unwrap_or_default(),
                address.email.clone(),
            ]
            .join(" ")
            .trim()
            .to_string()
        })
        .collect::<Vec<_>>()
        .join(" "))
}

/// The `messages.rowid` the FTS index keys on. Read after the write: an upsert
/// that took the `UPDATE` path gets no `last_insert_rowid`.
fn rowid_of(
    conn: &Connection,
    account_id: &str,
    folder_path: &str,
    uid: u32,
) -> Result<i64, MailError> {
    conn.query_row(
        "SELECT rowid FROM messages WHERE account_id = ?1 AND folder_path = ?2 AND uid = ?3",
        params![account_id, folder_path, uid],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

/// Drops the index entries of the messages `condition` selects, before the rows
/// themselves go: the index is keyed by `messages.rowid`, which dies with them.
fn drop_search_index(
    conn: &Connection,
    condition: &str,
    values: &[&dyn ToSql],
) -> Result<(), MailError> {
    conn.execute(
        &format!(
            "DELETE FROM messages_fts WHERE rowid IN \
             (SELECT rowid FROM messages WHERE {condition})"
        ),
        values,
    )?;
    Ok(())
}

/// Fills `has_attachment` for the mailboxes written before the column existed:
/// what was opened carries its stored attachments, what never was stays `0`.
fn backfill_attachment_flags(conn: &Connection) -> Result<(), MailError> {
    conn.execute(
        "UPDATE messages SET has_attachment = 1 WHERE has_attachment = 0 \
         AND EXISTS (SELECT 1 FROM attachments WHERE \
             attachments.account_id = messages.account_id \
             AND attachments.folder_path = messages.folder_path \
             AND attachments.uid = messages.uid)",
        [],
    )?;
    Ok(())
}

/// Indexes a mailbox written before the index existed, rowid batch after rowid
/// batch.
fn backfill_search_index(conn: &Connection) -> Result<(), MailError> {
    let mut last = 0;
    loop {
        let rowids: Vec<i64> = {
            let mut statement = conn
                .prepare("SELECT rowid FROM messages WHERE rowid > ?1 ORDER BY rowid LIMIT ?2")?;
            let rows = statement
                .query_map(params![last, REINDEX_BATCH], |row| row.get(0))?
                .collect::<Result<_, _>>()?;
            rows
        };
        let Some(batch_end) = rowids.last() else {
            return Ok(());
        };
        last = *batch_end;
        for rowid in rowids {
            index_message(conn, rowid)?;
        }
    }
}

/// The merged contact list: one row per address, counters added up, the name
/// of the most recent message that carried one, own addresses left out. The
/// pattern is `%%` when the query is empty, which matches every address.
const CONTACTS_SQL: &str = "\
     SELECT contacts.email, \
     (SELECT name FROM contacts AS named WHERE named.email = contacts.email \
     AND named.name IS NOT NULL AND named.name <> '' \
     ORDER BY named.last_seen DESC LIMIT 1) AS name, \
     SUM(contacts.received), SUM(contacts.sent), MAX(contacts.last_seen) \
     FROM contacts \
     WHERE contacts.email NOT IN \
     (SELECT lower(email) FROM accounts WHERE email IS NOT NULL AND email <> '') \
     AND (lower(contacts.email) LIKE ?1 ESCAPE '\\' \
     OR lower(COALESCE(contacts.name, '')) LIKE ?1 ESCAPE '\\') \
     GROUP BY contacts.email \
     ORDER BY SUM(contacts.received) + SUM(contacts.sent) DESC, \
     MAX(contacts.last_seen) DESC, contacts.email \
     LIMIT ?2";

/// One message's contribution to a contact: a counter, the name it carried and
/// the instant it was sent. The name only moves forward with `last_seen`, so an
/// old message re-imported later never brings back an outdated spelling.
const BUMP_CONTACT: &str = "\
     INSERT INTO contacts (account_id, email, name, received, sent, first_seen, last_seen, source) \
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 'mail') \
     ON CONFLICT(account_id, email) DO UPDATE SET \
     received = contacts.received + excluded.received, \
     sent = contacts.sent + excluded.sent, \
     name = CASE \
         WHEN excluded.last_seen IS NULL THEN contacts.name \
         WHEN contacts.last_seen IS NULL OR excluded.last_seen >= contacts.last_seen \
             THEN COALESCE(excluded.name, contacts.name) \
         ELSE contacts.name END, \
     first_seen = COALESCE(contacts.first_seen, excluded.first_seen), \
     last_seen = CASE \
         WHEN contacts.last_seen IS NULL THEN excluded.last_seen \
         WHEN excluded.last_seen IS NULL THEN contacts.last_seen \
         ELSE MAX(contacts.last_seen, excluded.last_seen) END";

/// Writes one message into the contact list: the sender of a received message,
/// the recipients (and copies) of a sent one. A folder the store does not know
/// (tests seeding messages by hand) and a folder the list ignores write nothing.
fn collect_contacts(
    conn: &Connection,
    account_id: &str,
    folder_path: &str,
    sender: &Address,
    recipients: &[Address],
    copies: &[Address],
    seen: Option<&str>,
) -> Result<(), MailError> {
    let Some((received, own)) = contact_scope(conn, account_id, folder_path)? else {
        return Ok(());
    };
    let addresses: Vec<&Address> = if received {
        vec![sender]
    } else {
        recipients.iter().chain(copies.iter()).collect()
    };
    let mut statement = conn.prepare(BUMP_CONTACT)?;
    let mut done = HashSet::new();
    for address in addresses {
        let email = normalize_email(&address.email);
        if email.is_empty() || Some(email.as_str()) == own.as_deref() || !done.insert(email.clone())
        {
            continue;
        }
        let name = address
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty());
        let (received, sent) = if received { (1, 0) } else { (0, 1) };
        statement.execute(params![account_id, email, name, received, sent, seen])?;
    }
    Ok(())
}

/// Whether a message of this folder feeds the list, and the address of the
/// account itself. `None` when the folder or the account is unknown here, and
/// for the folders whose mail is not correspondence (brouillons, spam,
/// corbeille).
fn contact_scope(
    conn: &Connection,
    account_id: &str,
    folder_path: &str,
) -> Result<Option<(bool, Option<String>)>, MailError> {
    let row = conn
        .query_row(
            "SELECT folders.role, accounts.email FROM folders \
             JOIN accounts ON accounts.id = folders.account_id \
             WHERE folders.account_id = ?1 AND folders.path = ?2",
            params![account_id, folder_path],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()?;
    let Some((role, own)) = row else {
        return Ok(None);
    };
    let received = match FolderRole::from_db(role.as_deref().unwrap_or_default()) {
        FolderRole::Sent => false,
        FolderRole::Drafts | FolderRole::Spam | FolderRole::Trash => return Ok(None),
        _ => true,
    };
    let own = own
        .map(|email| normalize_email(&email))
        .filter(|email| !email.is_empty());
    Ok(Some((received, own)))
}

/// Fills the contact list of a mailbox written before it existed, rowid batch
/// after rowid batch, with the rules of `collect_contacts`. The counters are
/// rebuilt, never added to what the table holds: `migrate` guards the call with
/// `user_version`, and a rebuild interrupted by a crash leaves the table as it
/// was. Contacts another source will bring (a CardDAV address book) stay.
fn backfill_contacts(conn: &Connection) -> Result<(), MailError> {
    let tx = conn.unchecked_transaction()?;
    let conn = &tx;
    conn.execute("DELETE FROM contacts WHERE source = 'mail'", [])?;
    let mut last = 0;
    loop {
        let rows: Vec<ContactRow> = {
            let mut statement = conn.prepare(
                "SELECT rowid, account_id, folder_path, from_json, to_json, cc_json, date \
                 FROM messages WHERE rowid > ?1 ORDER BY rowid LIMIT ?2",
            )?;
            let rows = statement
                .query_map(params![last, REINDEX_BATCH], |row| {
                    Ok(ContactRow {
                        rowid: row.get(0)?,
                        account_id: row.get(1)?,
                        folder_path: row.get(2)?,
                        sender: row.get(3)?,
                        recipients: row.get(4)?,
                        copies: row.get(5)?,
                        seen: row.get(6)?,
                    })
                })?
                .collect::<Result<_, _>>()?;
            rows
        };
        let Some(batch_end) = rows.last().map(|row| row.rowid) else {
            tx.commit()?;
            return Ok(());
        };
        last = batch_end;
        for row in rows {
            let ContactRow {
                account_id,
                folder_path,
                sender,
                recipients,
                copies,
                seen,
                ..
            } = row;
            let (Some(sender), Some(recipients), Some(copies)) = (sender, recipients, copies)
            else {
                continue;
            };
            let sender: Address = from_json(&sender)?;
            let recipients: Vec<Address> = from_json(&recipients)?;
            let copies: Vec<Address> = from_json(&copies)?;
            collect_contacts(
                conn,
                &account_id,
                &folder_path,
                &sender,
                &recipients,
                &copies,
                seen.as_deref(),
            )?;
        }
    }
}

struct ContactRow {
    rowid: i64,
    account_id: String,
    folder_path: String,
    sender: Option<String>,
    recipients: Option<String>,
    copies: Option<String>,
    seen: Option<String>,
}

fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

/// The `LIKE` pattern of a free-text query: its `%`, `_` and escape character
/// are neutralised, the text itself is matched case-insensitively.
fn like_pattern(query: &str) -> String {
    let mut pattern = String::from("%");
    for character in query.trim().to_lowercase().chars() {
        if matches!(character, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern.push('%');
    pattern
}

fn to_json<T: Serialize>(value: &T) -> Result<String, MailError> {
    Ok(serde_json::to_string(value)?)
}

fn to_json_option<T: Serialize>(value: &Option<T>) -> Result<Option<String>, MailError> {
    value.as_ref().map(to_json).transpose()
}

/// Adds the columns a database created by an older schema misses. The rows of
/// a database that predates them keep `NULL` there, which a folder reads back
/// as `modseq: None` — the next sync of that folder is the full pass.
fn add_missing_columns(conn: &Connection) -> Result<(), MailError> {
    if !column_exists(conn, "messages", "pgp_detail")? {
        conn.execute("ALTER TABLE messages ADD COLUMN pgp_detail TEXT", [])?;
    }
    if !column_exists(conn, "folders", "modseq")? {
        conn.execute("ALTER TABLE folders ADD COLUMN modseq INTEGER", [])?;
    }
    if !column_exists(conn, "folders", "delimiter")? {
        conn.execute("ALTER TABLE folders ADD COLUMN delimiter TEXT", [])?;
    }
    if !column_exists(conn, "messages", "has_attachment")? {
        conn.execute(
            "ALTER TABLE messages ADD COLUMN has_attachment INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !column_exists(conn, "accounts", "pgp")? {
        conn.execute(
            "ALTER TABLE accounts ADD COLUMN pgp INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }
    Ok(())
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, MailError> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        if row.get::<_, String>(1)? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn from_json<T: DeserializeOwned + Default>(raw: &str) -> Result<T, MailError> {
    if raw.is_empty() {
        return Ok(T::default());
    }
    Ok(serde_json::from_str(raw)?)
}

fn format_date(date: DateTime<Utc>) -> String {
    date.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn parse_date(raw: Option<&str>) -> Result<Option<DateTime<Utc>>, MailError> {
    raw.map(|value| {
        DateTime::parse_from_rfc3339(value)
            .map(|date| date.with_timezone(&Utc))
            .map_err(|error| MailError::InvalidData(format!("invalid date: {error}")))
    })
    .transpose()
}

fn uid_key(account_id: &str, folder_path: &str, uid: u32) -> (String, String, u32) {
    (account_id.to_string(), folder_path.to_string(), uid)
}

fn require_one(changed: usize, what: &str) -> Result<(), MailError> {
    if changed == 0 {
        return Err(MailError::InvalidData(format!("{what} not found")));
    }
    Ok(())
}

fn sender_name(message: &Message) -> String {
    match &message.from.name {
        Some(name) if !name.is_empty() => name.clone(),
        _ => message.from.email.clone(),
    }
}

fn sender_label(message: &Message) -> String {
    let name = sender_name(message);
    match name.split_whitespace().next() {
        Some(first) => first.to_string(),
        None => String::new(),
    }
}

const DECISION_COLUMNS: &str = "account_id, folder_path, uid, message_id, content_hash, \
    schema_version, model, category, category_conf, category_probs_json, urgency, needs_reply, \
    has_task, has_event, security, security_conf, cleanup_score, assignee, assignee_conf, \
    totp_code, totp_service, suggested_folder, suggested_folder_conf, decided_at, source";

fn decision_from_row(row: &Row<'_>) -> Result<MailDecision, rusqlite::Error> {
    let probs_raw: String = row.get(9)?;
    let category_probs: HashMap<String, f64> = serde_json::from_str(&probs_raw).unwrap_or_default();
    Ok(MailDecision {
        account_id: row.get(0)?,
        folder_path: row.get(1)?,
        uid: row.get(2)?,
        message_id: row.get(3)?,
        content_hash: row.get(4)?,
        schema_version: row.get(5)?,
        model: row.get(6)?,
        category: row.get(7)?,
        category_conf: row.get(8)?,
        category_probs,
        urgency: row.get(10)?,
        needs_reply: row.get(11)?,
        has_task: row.get(12)?,
        has_event: row.get(13)?,
        security: row.get(14)?,
        security_conf: row.get(15)?,
        cleanup_score: row.get(16)?,
        assignee: row.get(17)?,
        assignee_conf: row.get(18)?,
        totp_code: row.get(19)?,
        totp_service: row.get(20)?,
        suggested_folder: row.get(21)?,
        suggested_folder_conf: row.get(22)?,
        decided_at: row.get(23)?,
        source: row.get(24)?,
    })
}

impl Store {
    pub fn upsert_decision(&self, decision: &MailDecision) -> Result<(), MailError> {
        let conn = self.conn()?;
        let probs_json = serde_json::to_string(&decision.category_probs)?;
        conn.execute(
            "INSERT INTO mail_decisions ( \
                 account_id, folder_path, uid, message_id, content_hash, schema_version, model, \
                 category, category_conf, category_probs_json, urgency, needs_reply, has_task, \
                 has_event, security, security_conf, cleanup_score, assignee, assignee_conf, \
                 totp_code, totp_service, suggested_folder, suggested_folder_conf, decided_at, \
                 source \
             ) VALUES ( \
                 ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, \
                 ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25 \
             ) \
             ON CONFLICT(account_id, folder_path, uid) DO UPDATE SET \
                 message_id = excluded.message_id, \
                 content_hash = excluded.content_hash, \
                 schema_version = excluded.schema_version, \
                 model = excluded.model, \
                 category = excluded.category, \
                 category_conf = excluded.category_conf, \
                 category_probs_json = excluded.category_probs_json, \
                 urgency = excluded.urgency, \
                 needs_reply = excluded.needs_reply, \
                 has_task = excluded.has_task, \
                 has_event = excluded.has_event, \
                 security = excluded.security, \
                 security_conf = excluded.security_conf, \
                 cleanup_score = excluded.cleanup_score, \
                 assignee = excluded.assignee, \
                 assignee_conf = excluded.assignee_conf, \
                 totp_code = excluded.totp_code, \
                 totp_service = excluded.totp_service, \
                 suggested_folder = COALESCE(excluded.suggested_folder, mail_decisions.suggested_folder), \
                 suggested_folder_conf = COALESCE(excluded.suggested_folder_conf, mail_decisions.suggested_folder_conf), \
                 decided_at = excluded.decided_at, \
                 source = excluded.source",
            params![
                decision.account_id,
                decision.folder_path,
                decision.uid,
                decision.message_id,
                decision.content_hash,
                decision.schema_version,
                decision.model,
                decision.category,
                decision.category_conf,
                probs_json,
                decision.urgency,
                decision.needs_reply,
                decision.has_task,
                decision.has_event,
                decision.security,
                decision.security_conf,
                decision.cleanup_score,
                decision.assignee,
                decision.assignee_conf,
                decision.totp_code,
                decision.totp_service,
                decision.suggested_folder,
                decision.suggested_folder_conf,
                decision.decided_at,
                decision.source,
            ],
        )?;
        Ok(())
    }

    pub fn get_decision(
        &self,
        account_id: &str,
        folder_path: &str,
        uid: u32,
    ) -> Result<Option<MailDecision>, MailError> {
        let conn = self.conn()?;
        let sql = format!(
            "SELECT {DECISION_COLUMNS} FROM mail_decisions \
             WHERE account_id = ?1 AND folder_path = ?2 AND uid = ?3"
        );
        conn.query_row(
            &sql,
            params![account_id, folder_path, uid],
            decision_from_row,
        )
        .optional()
        .map_err(MailError::from)
    }

    pub fn get_decision_by_message_id(
        &self,
        message_id: &str,
    ) -> Result<Option<MailDecision>, MailError> {
        let conn = self.conn()?;
        let sql = format!(
            "SELECT {DECISION_COLUMNS} FROM mail_decisions \
             WHERE message_id = ?1 ORDER BY decided_at DESC LIMIT 1"
        );
        conn.query_row(&sql, params![message_id], decision_from_row)
            .optional()
            .map_err(MailError::from)
    }

    /// Retrouve le premier message local correspondant à un `Message-ID` RFC 5322
    /// (utilisé lors de l'import E2EE des décisions calculées par un autre appareil).
    pub fn find_message_by_message_id(
        &self,
        message_id: &str,
    ) -> Result<Option<(String, String, u32)>, MailError> {
        let conn = self.conn()?;
        conn.query_row(
            "SELECT account_id, folder_path, uid FROM messages \
             WHERE message_id = ?1 ORDER BY date DESC LIMIT 1",
            params![message_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(MailError::from)
    }

    pub fn list_decisions(
        &self,
        account_id: Option<&str>,
        folder_path: Option<&str>,
        limit: usize,
    ) -> Result<Vec<MailDecision>, MailError> {
        let conn = self.conn()?;
        let bounded = (limit.clamp(1, 2000)) as i64;
        let mut clauses: Vec<&str> = Vec::new();
        let mut values: Vec<Box<dyn ToSql>> = Vec::new();
        if let Some(account) = account_id.filter(|s| !s.trim().is_empty()) {
            clauses.push("account_id = ?");
            values.push(Box::new(account.to_string()));
        }
        if let Some(folder) = folder_path.filter(|s| !s.trim().is_empty()) {
            clauses.push("folder_path = ?");
            values.push(Box::new(folder.to_string()));
        }
        let where_sql = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {} ", clauses.join(" AND "))
        };
        values.push(Box::new(bounded));
        let sql = format!(
            "SELECT {DECISION_COLUMNS} FROM mail_decisions {where_sql}\
             ORDER BY decided_at DESC LIMIT ?"
        );
        let refs: Vec<&dyn ToSql> = values.iter().map(|v| v.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(refs.as_slice(), decision_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn update_suggested_folder(
        &self,
        account_id: &str,
        folder_path: &str,
        uid: u32,
        suggested_folder: &str,
        confidence: f64,
    ) -> Result<(), MailError> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE mail_decisions SET suggested_folder = ?4, suggested_folder_conf = ?5 \
             WHERE account_id = ?1 AND folder_path = ?2 AND uid = ?3",
            params![account_id, folder_path, uid, suggested_folder, confidence],
        )?;
        Ok(())
    }

    pub fn delete_decision(
        &self,
        account_id: &str,
        folder_path: &str,
        uid: u32,
    ) -> Result<(), MailError> {
        let conn = self.conn()?;
        conn.execute(
            "DELETE FROM mail_decisions WHERE account_id = ?1 AND folder_path = ?2 AND uid = ?3",
            params![account_id, folder_path, uid],
        )?;
        Ok(())
    }

    pub fn clear_decisions(&self, account_id: Option<&str>) -> Result<usize, MailError> {
        let conn = self.conn()?;
        let removed = match account_id.filter(|s| !s.trim().is_empty()) {
            Some(account) => conn.execute(
                "DELETE FROM mail_decisions WHERE account_id = ?1",
                params![account],
            )?,
            None => conn.execute("DELETE FROM mail_decisions", [])?,
        };
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Address, PgpState};

    #[test]
    fn delete_messages_drops_attachments() {
        let store = Store::open_in_memory().expect("open");
        store.migrate().expect("migrate");
        store
            .upsert_account("perso", "Perso", "roman@lavande.fr")
            .expect("account");
        store
            .upsert_message(&Message {
                account_id: "perso".to_string(),
                folder_path: "INBOX".to_string(),
                uid: 1,
                uidvalidity: 7,
                thread_id: "t1".to_string(),
                message_id: Some("<m1@x>".to_string()),
                in_reply_to: None,
                references: Vec::new(),
                from: Address {
                    name: None,
                    email: "marc@mail.fr".to_string(),
                },
                to: Vec::new(),
                cc: Vec::new(),
                subject: "Planning".to_string(),
                date: None,
                flags: Flags::default(),
                size: 10,
                pgp: PgpState::None,
                pgp_detail: None,
                preview: String::new(),
                body_text: None,
                body_html: None,
                attachments: vec![AttachmentMeta {
                    filename: "a.png".to_string(),
                    mime: "image/png".to_string(),
                    size: 4,
                    inline: false,
                }],
            })
            .expect("insert");
        assert!(
            !attachments_of_on(&store.conn().expect("lock"), "perso", "INBOX", None)
                .expect("attachments")
                .is_empty()
        );

        assert_eq!(
            store
                .delete_messages("perso", "INBOX", &[1])
                .expect("delete"),
            1
        );
        assert!(
            attachments_of_on(&store.conn().expect("lock"), "perso", "INBOX", None)
                .expect("attachments")
                .is_empty()
        );
    }

    #[test]
    fn store_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Store>();
    }

    /// A database written before `pgp_detail`, `modseq`, the per-account PGP
    /// switch and the folder delimiter: the columns `add_missing_columns` adds.
    fn legacy_database() -> Connection {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(
            "CREATE TABLE accounts (id TEXT PRIMARY KEY, label TEXT, email TEXT); \
             CREATE TABLE folders (account_id TEXT, path TEXT, name TEXT, role TEXT, \
             uidvalidity INTEGER, uidnext INTEGER, last_sync_at TEXT, \
             PRIMARY KEY (account_id, path)); \
             CREATE TABLE messages (account_id TEXT, folder_path TEXT, uid INTEGER, \
             uidvalidity INTEGER, thread_id TEXT, message_id TEXT, in_reply_to TEXT, \
             references_json TEXT, from_json TEXT, to_json TEXT, cc_json TEXT, \
             subject TEXT, date TEXT, unread INTEGER, starred INTEGER, answered INTEGER, \
             size INTEGER, pgp TEXT, preview TEXT, body_text TEXT, body_html TEXT, \
             PRIMARY KEY (account_id, folder_path, uid)); \
             INSERT INTO accounts VALUES ('perso', 'Perso', 'roman@lavande.fr'); \
             INSERT INTO folders VALUES ('perso', 'INBOX', 'Boite', 'inbox', 7, 10, NULL);",
        )
        .expect("old schema");
        conn
    }

    /// A database written by the schema that predates `modseq` keeps its rows
    /// and gains the column, empty: the next sync of those folders is the full
    /// pass, which is the safe path.
    #[test]
    fn migrate_adds_modseq_to_an_older_database() {
        let conn = legacy_database();
        assert!(!column_exists(&conn, "folders", "modseq").expect("probe"));

        add_missing_columns(&conn).expect("migrate");
        assert!(column_exists(&conn, "folders", "modseq").expect("probe"));
        let folder = get_folder_on(&conn, "perso", "INBOX")
            .expect("folder")
            .expect("present");
        assert_eq!(folder.uidvalidity, 7);
        assert_eq!(folder.modseq, None);

        add_missing_columns(&conn).expect("migrate again");
    }

    /// A database written before the hierarchy delimiter keeps its folders and
    /// gains the column, empty: a folder without a tree is a flat one.
    #[test]
    fn migrate_adds_the_hierarchy_delimiter_to_an_older_database() {
        let conn = legacy_database();
        assert!(!column_exists(&conn, "folders", "delimiter").expect("probe"));

        add_missing_columns(&conn).expect("migrate");
        assert!(column_exists(&conn, "folders", "delimiter").expect("probe"));
        let folder = get_folder_on(&conn, "perso", "INBOX")
            .expect("folder")
            .expect("present");
        assert_eq!(folder.delimiter, None);

        add_missing_columns(&conn).expect("migrate again");
    }

    /// A database written before the PGP switch keeps its accounts and gains
    /// the column enabled: a migration never closes an account by surprise.
    #[test]
    fn migrate_adds_the_pgp_switch_to_an_older_database() {
        let conn = legacy_database();
        assert!(!column_exists(&conn, "accounts", "pgp").expect("probe"));

        add_missing_columns(&conn).expect("migrate");
        assert!(column_exists(&conn, "accounts", "pgp").expect("probe"));
        let pgp: i64 = conn
            .query_row("SELECT pgp FROM accounts WHERE id = 'perso'", [], |row| {
                row.get(0)
            })
            .expect("compte");
        assert_eq!(pgp, 1, "l'interrupteur est ouvert par défaut");

        add_missing_columns(&conn).expect("migrate again");
    }

    /// The bundled SQLite must carry FTS5 (`ENABLE_FTS5`) with
    /// `contentless_delete`: the local search has no fallback.
    #[test]
    fn the_bundled_sqlite_compiles_fts5() {
        let store = Store::open_in_memory().expect("open");
        let conn = store.conn().expect("lock");
        conn.execute_batch(
            "CREATE VIRTUAL TABLE probe USING fts5(body, content='', contentless_delete=1, \
             tokenize=\"unicode61 remove_diacritics 2\"); \
             INSERT INTO probe (rowid, body) VALUES (1, 'zèbre');",
        )
        .expect("FTS5 compilé");
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM probe WHERE probe MATCH '\"ZEBRE\"'",
                [],
                |row| row.get(0),
            )
            .expect("requête");
        assert_eq!(hits, 1);
        conn.execute("DELETE FROM probe WHERE rowid = 1", [])
            .expect("contentless_delete");
    }

    /// A mailbox written before the index existed: `migrate` indexes what is
    /// stored, and the messages opened before the column existed keep their
    /// attachments.
    #[test]
    fn migrating_an_older_database_indexes_it_and_backfills_the_attachment_flag() {
        let conn = legacy_database();
        conn.pragma_update(None, "user_version", 6)
            .expect("version");
        conn.execute_batch(
            "CREATE TABLE attachments (account_id TEXT, folder_path TEXT, uid INTEGER, \
             idx INTEGER, filename TEXT, mime TEXT, size INTEGER, inline INTEGER, \
             PRIMARY KEY (account_id, folder_path, uid, idx)); \
             INSERT INTO messages (account_id, folder_path, uid, uidvalidity, thread_id, \
             message_id, in_reply_to, references_json, from_json, to_json, cc_json, subject, \
             date, unread, starred, answered, size, pgp, preview, body_text, body_html) \
             VALUES ('perso', 'INBOX', 1, 7, 't1', '<m1@x>', NULL, '[]', \
             '{\"name\":\"Léa\",\"email\":\"lea@mail.fr\"}', '[]', '[]', 'Zèbre rayé', \
             '2026-01-02T10:00:00Z', 1, 0, 0, 10, 'none', '', 'corps xylophone', NULL); \
             INSERT INTO attachments VALUES ('perso', 'INBOX', 1, 0, 'a.pdf', \
             'application/pdf', 4, 0);",
        )
        .expect("base ancienne");
        let store = Store::from_connection(conn).expect("store");
        store.migrate().expect("migrate");

        assert!(
            column_exists(&store.conn().expect("lock"), "messages", "has_attachment")
                .expect("probe")
        );
        assert_eq!(
            store
                .search_messages("perso", "zebre", 10)
                .expect("sujet")
                .len(),
            1
        );
        assert_eq!(
            store
                .search_messages("perso", "xylophone", 10)
                .expect("corps")
                .len(),
            1
        );
        assert_eq!(
            store
                .search_messages("perso", "lea@mail", 10)
                .expect("expéditeur")
                .len(),
            1
        );
        let attached = store
            .search(
                "perso",
                &SearchFilter {
                    has_attachment: Some(true),
                    limit: 10,
                    ..SearchFilter::default()
                },
            )
            .expect("pièces jointes");
        assert_eq!(attached.len(), 1);
        store.migrate().expect("migrate again");
        assert_eq!(
            store
                .search_messages("perso", "zebre", 10)
                .expect("sujet")
                .len(),
            1
        );
    }

    /// The backfill walks a mailbox bigger than one batch without stopping on
    /// the way.
    #[test]
    fn the_backfill_walks_a_mailbox_batch_after_batch() {
        let conn = legacy_database();
        conn.pragma_update(None, "user_version", 6)
            .expect("version");
        conn.execute_batch(
            "WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5001) \
             INSERT INTO messages (account_id, folder_path, uid, uidvalidity, thread_id, \
             message_id, in_reply_to, references_json, from_json, to_json, cc_json, subject, \
             date, unread, starred, answered, size, pgp, preview, body_text, body_html) \
             SELECT 'perso', 'INBOX', i, 7, 't' || i, NULL, NULL, '[]', \
             '{\"name\":null,\"email\":\"marc@mail.fr\"}', '[]', '[]', 'corps ' || i, \
             '2026-01-02T10:00:00Z', 0, 0, 0, 10, 'none', '', 'xylophone ' || i, NULL FROM n;",
        )
        .expect("grosse boîte");
        let store = Store::from_connection(conn).expect("store");
        store.migrate().expect("migrate");

        assert_eq!(
            store
                .search_messages("perso", "xylophone", -1)
                .expect("corps")
                .len(),
            5001
        );
    }

    #[test]
    fn mail_decisions_upsert_lookup_and_clear() {
        let store = Store::open_in_memory().expect("open");
        store.migrate().expect("migrate");
        let mut probs = HashMap::new();
        probs.insert("auth_totp".to_string(), 0.96);
        probs.insert("info".to_string(), 0.04);

        let decision = MailDecision {
            account_id: "perso".into(),
            folder_path: "INBOX".into(),
            uid: 42,
            message_id: Some("<otp-42@github.com>".into()),
            content_hash: "abc12345".into(),
            schema_version: 1,
            model: "mammoth-1".into(),
            category: "auth_totp".into(),
            category_conf: 0.96,
            category_probs: probs,
            urgency: 2.1,
            needs_reply: 0.02,
            has_task: 0.01,
            has_event: 0.0,
            security: "safe".into(),
            security_conf: 0.99,
            cleanup_score: 0.91,
            assignee: None,
            assignee_conf: None,
            totp_code: Some("482917".into()),
            totp_service: Some("GitHub".into()),
            suggested_folder: None,
            suggested_folder_conf: None,
            decided_at: 1_700_000_000,
            source: "local".into(),
        };

        store.upsert_decision(&decision).expect("upsert");
        let fetched = store
            .get_decision("perso", "INBOX", 42)
            .expect("get")
            .expect("present");
        assert_eq!(fetched.totp_code.as_deref(), Some("482917"));
        assert_eq!(fetched.category, "auth_totp");

        let by_mid = store
            .get_decision_by_message_id("<otp-42@github.com>")
            .expect("mid")
            .expect("present");
        assert_eq!(by_mid.uid, 42);

        store
            .update_suggested_folder("perso", "INBOX", 42, "Auth", 0.92)
            .expect("folder");
        let updated = store
            .get_decision("perso", "INBOX", 42)
            .expect("get")
            .expect("present");
        assert_eq!(updated.suggested_folder.as_deref(), Some("Auth"));

        assert_eq!(
            store
                .list_decisions(Some("perso"), None, 50)
                .expect("list")
                .len(),
            1
        );
        assert_eq!(store.clear_decisions(Some("perso")).expect("clear"), 1);
        assert!(store
            .get_decision("perso", "INBOX", 42)
            .expect("empty")
            .is_none());
    }
}
