CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    label TEXT,
    email TEXT
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
    PRIMARY KEY (account_id, folder_path, uid)
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

CREATE INDEX IF NOT EXISTS idx_messages_folder_date
    ON messages (account_id, folder_path, date DESC);

CREATE INDEX IF NOT EXISTS idx_messages_thread
    ON messages (account_id, thread_id);
