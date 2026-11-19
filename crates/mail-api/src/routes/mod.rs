//! HTTP routes, split between account management, mailbox operations,
//! read-only calendar import, the stored CalDAV sources and the contact list.

pub mod accounts;
pub mod calendars;
pub mod contacts;
pub mod counts;
pub mod discover;
pub mod events;
pub mod mail;
pub mod oauth;
pub mod pgp;
pub mod search;
pub mod sync;
