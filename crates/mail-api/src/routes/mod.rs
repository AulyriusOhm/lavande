//! HTTP routes, split between account management, mailbox operations and
//! read-only calendar import.

pub mod accounts;
pub mod calendars;
pub mod counts;
pub mod discover;
pub mod events;
pub mod mail;
pub mod oauth;
pub mod pgp;
pub mod search;
