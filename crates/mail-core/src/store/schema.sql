CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    label TEXT,
    email TEXT,
    pgp INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS folders (
    account_id TEXT,
    path TEXT,
    name TEXT,
    role TEXT,
    uidvalidity INTEGER,
    uidnext INTEGER,
    last_sync_at TEXT,
    modseq INTEGER,
    delimiter TEXT,
    PRIMARY KEY (account_id, path)
);

CREATE TABLE IF NOT EXISTS messages (
    account_id TEXT,
    folder_path TEXT,
    uid INTEGER,
    uidvalidity INTEGER,
    thread_id TEXT,
    message_id TEXT,
    in_reply_to TEXT,
    references_json TEXT,
    from_json TEXT,
    to_json TEXT,
    cc_json TEXT,
    subject TEXT,
    date TEXT,
    unread INTEGER,
    starred INTEGER,
    answered INTEGER,
    size INTEGER,
    pgp TEXT,
    preview TEXT,
    body_text TEXT,
    body_html TEXT,
    pgp_detail TEXT,
    has_attachment INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, folder_path, uid)
);

CREATE TABLE IF NOT EXISTS contacts (
    account_id TEXT,
    email TEXT,
    name TEXT,
    received INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT,
    last_seen TEXT,
    source TEXT NOT NULL DEFAULT 'mail',
    PRIMARY KEY (account_id, email)
);

CREATE TABLE IF NOT EXISTS attachments (
    account_id TEXT,
    folder_path TEXT,
    uid INTEGER,
    idx INTEGER,
    filename TEXT,
    mime TEXT,
    size INTEGER,
    inline INTEGER,
    PRIMARY KEY (account_id, folder_path, uid, idx)
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    subject,
    sender,
    recipients,
    body,
    content = '',
    contentless_delete = 1,
    tokenize = "unicode61 remove_diacritics 2"
);

CREATE INDEX IF NOT EXISTS idx_messages_folder_date
    ON messages (account_id, folder_path, date DESC);

CREATE INDEX IF NOT EXISTS idx_messages_thread
    ON messages (account_id, thread_id);

CREATE INDEX IF NOT EXISTS idx_messages_message_id
    ON messages (account_id, message_id);

CREATE INDEX IF NOT EXISTS idx_contacts_last_seen
    ON contacts (last_seen DESC);

CREATE TABLE IF NOT EXISTS mail_decisions (
    account_id TEXT NOT NULL,
    folder_path TEXT NOT NULL,
    uid INTEGER NOT NULL,
    message_id TEXT,
    content_hash TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    model TEXT NOT NULL,
    category TEXT NOT NULL,
    category_conf REAL NOT NULL,
    category_probs_json TEXT NOT NULL,
    urgency REAL NOT NULL,
    needs_reply REAL NOT NULL,
    has_task REAL NOT NULL,
    has_event REAL NOT NULL,
    security TEXT NOT NULL,
    security_conf REAL NOT NULL,
    cleanup_score REAL NOT NULL,
    assignee TEXT,
    assignee_conf REAL,
    totp_code TEXT,
    totp_service TEXT,
    suggested_folder TEXT,
    suggested_folder_conf REAL,
    decided_at INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'local',
    PRIMARY KEY (account_id, folder_path, uid)
);

CREATE INDEX IF NOT EXISTS idx_decisions_category
    ON mail_decisions (account_id, category, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_decisions_message_id
    ON mail_decisions (message_id);
