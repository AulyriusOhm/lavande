//! SQLite-backed local store for accounts, folders, messages and threads.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row, ToSql};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::MailError;
use crate::model::{AttachmentMeta, Flags, Folder, FolderRole, Message, PgpState, Thread};

const SCHEMA: &str = include_str!("schema.sql");
const SCHEMA_VERSION: i64 = 1;
const MESSAGE_COLUMNS: &str = "account_id, folder_path, uid, uidvalidity, thread_id, message_id, \
     in_reply_to, references_json, from_json, to_json, cc_json, subject, date, unread, starred, \
     answered, size, pgp, preview, body_text, body_html";

pub struct Store {
    conn: Mutex<Connection>,
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
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
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

    pub fn upsert_folder(&self, folder: &Folder) -> Result<(), MailError> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO folders (account_id, path, name, role, uidvalidity, uidnext, last_sync_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(account_id, path) DO UPDATE SET name = excluded.name, \
             role = excluded.role, uidvalidity = excluded.uidvalidity, \
             uidnext = excluded.uidnext, last_sync_at = excluded.last_sync_at",
            params![
                folder.account_id,
                folder.path,
                folder.name,
                folder.role.as_str(),
                folder.uidvalidity,
                folder.uidnext,
                folder.last_sync_at.map(format_date),
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
            "SELECT account_id, path, name, role, uidvalidity, uidnext, last_sync_at \
             FROM folders WHERE account_id = ?1 ORDER BY path",
        )?;
        let rows = statement.query_map(params![account_id], FolderRow::read)?;
        let mut folders = Vec::new();
        for row in rows {
            folders.push(row?.into_folder()?);
        }
        Ok(folders)
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

    /// Inserts or replaces a message and its attachments. Idempotent per
    /// `(account_id, folder_path, uid)`.
    pub fn upsert_message(&self, message: &Message) -> Result<(), MailError> {
        let conn = self.conn()?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT OR REPLACE INTO messages (account_id, folder_path, uid, uidvalidity, \
             thread_id, message_id, in_reply_to, references_json, from_json, to_json, cc_json, \
             subject, date, unread, starred, answered, size, pgp, preview, body_text, body_html) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, \
             ?17, ?18, ?19, ?20, ?21)",
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
            ],
        )?;
        tx.execute(
            "DELETE FROM attachments WHERE account_id = ?1 AND folder_path = ?2 AND uid = ?3",
            params![message.account_id, message.folder_path, message.uid],
        )?;
        for (index, attachment) in message.attachments.iter().enumerate() {
            tx.execute(
                "INSERT INTO attachments (account_id, folder_path, uid, idx, filename, mime, \
                 size, inline) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    message.account_id,
                    message.folder_path,
                    message.uid,
                    index as i64,
                    attachment.filename,
                    attachment.mime,
                    attachment.size as i64,
                    attachment.inline,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
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

    pub fn set_flags(
        &self,
        account_id: &str,
        folder_path: &str,
        uid: u32,
        flags: &Flags,
    ) -> Result<(), MailError> {
        let conn = self.conn()?;
        let updated = conn.execute(
            "UPDATE messages SET unread = ?4, starred = ?5, answered = ?6 \
             WHERE account_id = ?1 AND folder_path = ?2 AND uid = ?3",
            params![
                account_id,
                folder_path,
                uid,
                flags.unread,
                flags.starred,
                flags.answered
            ],
        )?;
        require_one(updated, "message")
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

    pub fn set_body(
        &self,
        account_id: &str,
        folder_path: &str,
        uid: u32,
        text: Option<&str>,
        html: Option<&str>,
    ) -> Result<(), MailError> {
        let conn = self.conn()?;
        let updated = conn.execute(
            "UPDATE messages SET body_text = ?4, body_html = ?5 \
             WHERE account_id = ?1 AND folder_path = ?2 AND uid = ?3",
            params![account_id, folder_path, uid, text, html],
        )?;
        require_one(updated, "message")
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

    /// Moves the messages replying to `message_id` into `thread_id`. Returns
    /// how many rows changed.
    pub fn relink_replies(
        &self,
        account_id: &str,
        message_id: &str,
        thread_id: &str,
    ) -> Result<usize, MailError> {
        let conn = self.conn()?;
        let updated = conn.execute(
            "UPDATE messages SET thread_id = ?3 WHERE account_id = ?1 \
             AND (in_reply_to = ?2 OR instr(references_json, ?2) > 0)",
            params![account_id, message_id, thread_id],
        )?;
        Ok(updated)
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

    /// Threads of a folder, newest activity first. `unread`, `preview` and
    /// `participants` are computed on the folder's messages only.
    pub fn threads_in_folder(
        &self,
        account_id: &str,
        folder_path: &str,
    ) -> Result<Vec<Thread>, MailError> {
        let conn = self.conn()?;
        let sent = get_folder_on(&conn, account_id, folder_path)?
            .map(|folder| folder.role == FolderRole::Sent)
            .unwrap_or(false);

        let mut groups: HashMap<String, Vec<Message>> = HashMap::new();
        for message in messages_in_folder_on(&conn, account_id, folder_path, -1, 0)? {
            groups
                .entry(message.thread_id.clone())
                .or_default()
                .push(message);
        }

        let mut threads = Vec::new();
        for (id, mut messages) in groups {
            messages.sort_by(|a, b| b.date.cmp(&a.date).then(b.uid.cmp(&a.uid)));
            let Some(primary) = messages.first().cloned() else {
                continue;
            };
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
            threads.push(Thread {
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
            });
        }
        threads.sort_by(|a, b| {
            b.primary
                .date
                .cmp(&a.primary.date)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(threads)
    }
}

fn get_folder_on(
    conn: &Connection,
    account_id: &str,
    path: &str,
) -> Result<Option<Folder>, MailError> {
    conn.query_row(
        "SELECT account_id, path, name, role, uidvalidity, uidnext, last_sync_at \
         FROM folders WHERE account_id = ?1 AND path = ?2",
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
            preview: self.preview,
            body_text: self.body_text,
            body_html: self.body_html,
            attachments: Vec::new(),
        })
    }
}

fn to_json<T: Serialize>(value: &T) -> Result<String, MailError> {
    Ok(serde_json::to_string(value)?)
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
}
