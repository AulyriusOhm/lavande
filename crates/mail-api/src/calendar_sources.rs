//! `calendars.json`: the CalDAV sources of the daemon, **without credentials**.
//! Mode 0600, written atomically, never returned as is by the API.
//!
//! The username and the password live in the secret store, one entry per
//! source (`caldav:<id>`): this file only carries what the settings need.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::oauth_flow::slug;
use crate::private_file;

pub const SOURCES_FILE: &str = "calendars.json";

const SECRET_PREFIX: &str = "caldav:";

/// One CalDAV account of the daemon. `calendar_href` narrows it to a single
/// collection; absent, every discovered calendar is read.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CalendarSource {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_href: Option<String>,
}

/// Identifier of a source: the slug of its name, then `-2`, `-3`… when taken.
pub fn unique_id(name: &str, sources: &[CalendarSource]) -> String {
    let base = slug(name);
    let taken = |candidate: &str| sources.iter().any(|source| source.id == candidate);
    if !taken(&base) {
        return base;
    }
    (2..)
        .map(|suffix| format!("{base}-{suffix}"))
        .find(|candidate| !taken(candidate))
        .unwrap_or(base)
}

pub fn secret_id(id: &str) -> String {
    format!("{SECRET_PREFIX}{id}")
}

pub fn load(path: &Path) -> Result<Vec<CalendarSource>, ApiError> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            ApiError::internal(
                "config",
                format!("{} est illisible : {error}", path.display()),
            )
        }),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(ApiError::internal(
            "config",
            format!("lecture de {} : {error}", path.display()),
        )),
    }
}

pub fn save(path: &Path, sources: &[CalendarSource]) -> Result<(), ApiError> {
    let bytes = serde_json::to_vec_pretty(sources).map_err(|error| {
        ApiError::internal("config", format!("sérialisation des calendriers : {error}"))
    })?;
    private_file::write_private(path, &bytes)
}
