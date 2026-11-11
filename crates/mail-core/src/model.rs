use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::pgp::PgpDetail;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Address {
    pub name: Option<String>,
    pub email: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PgpState {
    #[default]
    None,
    Signed,
    Encrypted,
}

impl PgpState {
    pub fn as_str(self) -> &'static str {
        match self {
            PgpState::None => "none",
            PgpState::Signed => "signed",
            PgpState::Encrypted => "encrypted",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "signed" => PgpState::Signed,
            "encrypted" => PgpState::Encrypted,
            _ => PgpState::None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderRole {
    Inbox,
    Sent,
    Drafts,
    Archive,
    Trash,
    Spam,
    #[default]
    Other,
}

impl FolderRole {
    pub fn as_str(self) -> &'static str {
        match self {
            FolderRole::Inbox => "inbox",
            FolderRole::Sent => "sent",
            FolderRole::Drafts => "drafts",
            FolderRole::Archive => "archive",
            FolderRole::Trash => "trash",
            FolderRole::Spam => "spam",
            FolderRole::Other => "other",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "inbox" => FolderRole::Inbox,
            "sent" => FolderRole::Sent,
            "drafts" => FolderRole::Drafts,
            "archive" => FolderRole::Archive,
            "trash" => FolderRole::Trash,
            "spam" => FolderRole::Spam,
            _ => FolderRole::Other,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Folder {
    pub account_id: String,
    pub path: String,
    pub name: String,
    pub role: FolderRole,
    pub uidvalidity: u32,
    pub uidnext: u32,
    pub last_sync_at: Option<DateTime<Utc>>,
    /// `HIGHESTMODSEQ` (RFC 7162) the last complete sync left behind, or
    /// `None` when the server never advertised CONDSTORE: the next sync then
    /// runs the full pass.
    pub modseq: Option<u64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Flags {
    pub unread: bool,
    pub starred: bool,
    pub answered: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentMeta {
    pub filename: String,
    pub mime: String,
    pub size: u64,
    pub inline: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub account_id: String,
    pub folder_path: String,
    pub uid: u32,
    pub uidvalidity: u32,
    pub thread_id: String,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub from: Address,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub subject: String,
    pub date: Option<DateTime<Utc>>,
    pub flags: Flags,
    pub size: u32,
    pub pgp: PgpState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pgp_detail: Option<PgpDetail>,
    pub preview: String,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub attachments: Vec<AttachmentMeta>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Thread {
    pub id: String,
    pub account_id: String,
    pub messages: Vec<Message>,
    pub primary: Message,
    pub count: usize,
    pub unread: usize,
    pub starred: bool,
    pub encrypted: usize,
    pub attachments: usize,
    pub participants: Vec<String>,
    pub subject: String,
    pub preview: String,
}

/// Composite thread key used by the UI: `account_id:thread_id`.
pub fn thread_key(account_id: &str, thread_id: &str) -> String {
    format!("{account_id}:{thread_id}")
}
