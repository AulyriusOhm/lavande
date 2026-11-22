//! HTTP routes, split between account management, mailbox operations,
//! read-only calendar import, the stored CalDAV sources, the contact list and
//! the Zimbra SOAP socle of an account.

pub mod accounts;
pub mod ai;
pub mod calendars;
pub mod contacts;
pub mod counts;
pub mod decision;
pub mod discover;
pub mod events;
pub mod mail;
pub mod oauth;
pub mod pgp;
pub mod search;
pub mod sync;
pub mod zimbra;
