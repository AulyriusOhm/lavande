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
