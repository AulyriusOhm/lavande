//! HTTP routes, split between account management, mailbox operations,
//! read-only calendar import and the stored CalDAV sources.

pub mod accounts;
pub mod calendars;
pub mod counts;
pub mod discover;
pub mod events;
pub mod mail;
pub mod oauth;
pub mod pgp;
pub mod search;
