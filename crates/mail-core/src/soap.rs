//! Zimbra SOAP client, JSON flavour: login, generic call, `GetInfo`, the server
//! filter rules and the out-of-office answer.
//!
//! Zimbra serves every operation on one endpoint, `/service/soap`: the `Body`
//! names the operation and its namespace, the `AuthResponse` hands out the
//! `authToken` reused in the `Header.context` of the following calls. Both sides
//! speak JSON (`fmt=json`), so no XML is built or parsed here.
//!
//! The endpoint is the mail server of the account (`https://<hôte IMAP>/service/soap`):
//! the password travels in the `AuthRequest` body only, never in a URL, a log
//! line or an error message, and the token is not printed either. A token the
//! server no longer accepts is negotiated again once, then the refusal is
//! reported.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use chrono::NaiveDate;
use reqwest::{StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::MailError;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Largest SOAP answer read from the server.
const MAX_SOAP_BYTES: usize = 4 * 1024 * 1024;

/// Longest fault text kept in an error message.
const MAX_FAULT_CHARS: usize = 200;

/// The reply is JSON because the request body is: the server decides on the
/// body it parses, whatever the media type announces.
const CONTENT_TYPE: &str = "application/soap+xml; charset=utf-8";

const ACCEPT: &str = "application/json";

const ACCOUNT_NS: &str = "urn:zimbraAccount";
const MAIL_NS: &str = "urn:zimbraMail";
const ZIMBRA_NS: &str = "urn:zimbra";

/// Prefs holding the out-of-office answer.
const VACATION_PREFS: [&str; 4] = [
    "zimbraPrefOutOfOfficeReplyEnabled",
    "zimbraPrefOutOfOfficeReply",
    "zimbraPrefOutOfOfficeFromDate",
    "zimbraPrefOutOfOfficeUntilDate",
];

/// Codes the server sends when the presented token is missing, expired or
/// refused: only a new `AuthRequest` can answer them. The server prefixes them
/// with the namespace of the component refusing (`account.AUTH_FAILED`,
/// `service.AUTH_REQUIRED`), so only the last segment is compared.
const AUTH_CODES: [&str; 3] = ["AUTH_FAILED", "AUTH_EXPIRED", "AUTH_REQUIRED"];

/// `AuthResponse`: the token every later call presents and the lifetime the
/// server announced, when it did. Its `Debug` masks the token.
#[derive(Clone, Deserialize, Serialize)]
pub struct AuthToken {
    #[serde(rename = "authToken")]
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifetime: Option<i64>,
}

impl std::fmt::Debug for AuthToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthToken")
            .field("token", &"<masqué>")
            .field("lifetime", &self.lifetime)
            .finish()
    }
}

/// What `GetInfo` says about the authenticated account.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct AccountInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// How the tests of a rule combine.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FilterCondition {
    AnyOf,
    #[default]
    AllOf,
}

impl FilterCondition {
    fn as_str(self) -> &'static str {
        match self {
            Self::AnyOf => "anyof",
            Self::AllOf => "allof",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "anyof" => Some(Self::AnyOf),
            "allof" => Some(Self::AllOf),
            _ => None,
        }
    }
}

/// Comparison of a header or address test. Zimbra keeps the comparison and a
/// `negative` flag apart, the front toggles one of six choices.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FilterComparison {
    Contains,
    NotContains,
    Is,
    NotIs,
    Matches,
    NotMatches,
}

impl FilterComparison {
    fn wire(self) -> (&'static str, bool) {
        match self {
            Self::Contains => ("contains", false),
            Self::NotContains => ("contains", true),
            Self::Is => ("is", false),
            Self::NotIs => ("is", true),
            Self::Matches => ("matches", false),
            Self::NotMatches => ("matches", true),
        }
    }

    fn parse(comparison: &str, negative: bool) -> Option<Self> {
        Some(match (comparison, negative) {
            ("contains", false) => Self::Contains,
            ("contains", true) => Self::NotContains,
            ("is", false) => Self::Is,
            ("is", true) => Self::NotIs,
            ("matches", false) => Self::Matches,
            ("matches", true) => Self::NotMatches,
            _ => return None,
        })
    }
}

/// Which part of an address an `addressTest` compares.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AddressPart {
    All,
    LocalPart,
    Domain,
}

impl AddressPart {
    fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::LocalPart => "localpart",
            Self::Domain => "domain",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "all" => Some(Self::All),
            "localpart" => Some(Self::LocalPart),
            "domain" => Some(Self::Domain),
            _ => None,
        }
    }
}

/// Comparison of a `sizeTest`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SizeComparison {
    Over,
    Under,
}

impl SizeComparison {
    fn as_str(self) -> &'static str {
        match self {
            Self::Over => "over",
            Self::Under => "under",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "over" => Some(Self::Over),
            "under" => Some(Self::Under),
            _ => None,
        }
    }
}

/// Comparison of a `dateTest`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DateComparison {
    Before,
    After,
}

impl DateComparison {
    fn as_str(self) -> &'static str {
        match self {
            Self::Before => "before",
            Self::After => "after",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "before" => Some(Self::Before),
            "after" => Some(Self::After),
            _ => None,
        }
    }
}

/// One condition of a rule.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FilterTest {
    Header {
        header: String,
        comparison: FilterComparison,
        value: String,
    },
    Address {
        header: String,
        part: AddressPart,
        comparison: FilterComparison,
        value: String,
    },
    Size {
        comparison: SizeComparison,
        size: String,
    },
    Date {
        comparison: DateComparison,
        date: String,
    },
}

/// One action of a rule, applied in order once the tests pass.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FilterAction {
    Keep,
    Discard,
    Stop,
    FileInto { folder_path: String },
    Tag { tag_name: String },
    Flag { flag_name: String },
    Redirect { address: String },
}

/// One server filter rule. `read_only` marks a rule holding something this
/// client does not model (a nested rule, a notification action, an attribute
/// it cannot write back): it is shown as is and never rebuilt.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct FilterRule {
    pub name: String,
    /// A rule the front only names (a deletion) is active and combines allof.
    #[serde(default = "active")]
    pub active: bool,
    #[serde(default)]
    pub condition: FilterCondition,
    #[serde(default)]
    pub tests: Vec<FilterTest>,
    #[serde(default)]
    pub actions: Vec<FilterAction>,
    #[serde(default)]
    pub read_only: bool,
}

fn active() -> bool {
    true
}

/// A rule as the server keeps it: `raw` is the `filterRule` object, sent back
/// untouched when the daemon does not edit that rule.
#[derive(Clone, Debug)]
pub struct ServerFilterRule {
    pub rule: FilterRule,
    pub raw: Value,
}

/// Out-of-office answer of the account, in the terms of the Zimbra prefs.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct Vacation {
    pub enabled: bool,
    #[serde(default)]
    pub message: String,
    /// `AAAA-MM-JJ`, absent when the answer has no date bound.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
}

/// JSON-SOAP client of one Zimbra account. It holds the password and the token
/// and prints neither: no `Debug`, no secret in an error message.
pub struct SoapClient {
    endpoint: Url,
    account: String,
    password: String,
    token: Mutex<Option<String>>,
    http: reqwest::Client,
}

impl SoapClient {
    pub fn new(endpoint: &str, account: &str, password: &str) -> Result<Self, MailError> {
        let account = account.trim();
        if account.is_empty() {
            return Err(MailError::Config("SOAP : compte vide".to_string()));
        }
        if password.is_empty() {
            return Err(MailError::Config("SOAP : mot de passe vide".to_string()));
        }
        let mut endpoint = parse_endpoint(endpoint)?;
        if endpoint.query().is_none() {
            endpoint.set_query(Some("fmt=json"));
        }
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("Lavande/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| MailError::Soap(format!("client HTTP SOAP : {error}")))?;
        Ok(Self {
            endpoint,
            account: account.to_string(),
            password: password.to_string(),
            token: Mutex::new(None),
            http,
        })
    }

    /// Logs the account in: the password goes in the `AuthRequest` body, the
    /// answer becomes the session token.
    pub async fn authenticate(&self) -> Result<AuthToken, MailError> {
        let operation = json!({"AuthRequest": {
            "_jsns": ACCOUNT_NS,
            "account": {"by": "name", "_content": self.account},
            "password": self.password,
        }});
        let answer: AuthToken = answer(self.post(operation, None).await?)?;
        if answer.token.trim().is_empty() {
            return Err(MailError::Auth(format!(
                "{} n'a renvoyé aucun jeton",
                self.address()
            )));
        }
        self.store_token(answer.token.clone());
        Ok(answer)
    }

    /// One operation whose answer describes what `T` expects.
    pub async fn request<T: DeserializeOwned>(&self, operation: Value) -> Result<T, MailError> {
        answer(self.call(operation).await?)
    }

    /// One operation whose answer carries nothing: only a fault can fail here.
    async fn request_empty(&self, operation: Value) -> Result<(), MailError> {
        self.call(operation).await.map(|_| ())
    }

    /// One operation: `operation` is the `Body` (`{"GetInfoRequest": {...}}`)
    /// and the whole `Body` of the answer comes back. A token the server refused
    /// is renewed once before the call is replayed.
    async fn call(&self, operation: Value) -> Result<Value, MailError> {
        let token = match self.cached_token() {
            Some(token) => token,
            None => self.authenticate().await?.token,
        };
        match self.post(operation.clone(), Some(&token)).await {
            Ok(body) => Ok(body),
            Err(error @ MailError::Auth(_)) => {
                tracing::debug!(%error, "jeton Zimbra refusé, renouvelé");
                let token = self.authenticate().await?.token;
                self.post(operation, Some(&token)).await
            }
            Err(error) => Err(error),
        }
    }

    /// `GetInfo` of the account: its name, its id and the server version.
    pub async fn get_info(&self) -> Result<AccountInfo, MailError> {
        self.request(json!({"GetInfoRequest": {"_jsns": ACCOUNT_NS}}))
            .await
    }

    /// Filter rules of the account, each with the object it came from.
    pub async fn get_filter_rules(&self) -> Result<Vec<ServerFilterRule>, MailError> {
        let answer = self
            .request(json!({"GetFilterRulesRequest": {"_jsns": MAIL_NS}}))
            .await?;
        parse_filter_rules(&answer)
    }

    /// Replaces the whole rule list: `ModifyFilterRules` takes the complete set,
    /// so an untouched rule travels back exactly as the server wrote it.
    pub async fn modify_filter_rules(&self, rules: &[ServerFilterRule]) -> Result<(), MailError> {
        let filter_rules: Vec<Value> = rules
            .iter()
            .map(|rule| json!({"filterRule": [rule.raw]}))
            .collect();
        self.request_empty(json!({"ModifyFilterRulesRequest": {
            "_jsns": MAIL_NS,
            "filterRules": filter_rules,
        }}))
        .await
    }

    /// Prefs the caller names, as the server spells them.
    pub async fn get_prefs(&self, names: &[&str]) -> Result<HashMap<String, String>, MailError> {
        let pref: Vec<Value> = names.iter().map(|name| json!({"name": name})).collect();
        let answer: Value = self
            .request(json!({"GetPrefsRequest": {"_jsns": ACCOUNT_NS, "pref": pref}}))
            .await?;
        let mut prefs = HashMap::new();
        for entry in as_list(answer.get("pref")) {
            let name = text(entry.get("name"));
            if !name.is_empty() {
                prefs.insert(name, text(entry.get("_content")));
            }
        }
        Ok(prefs)
    }

    /// Writes prefs: the JSON form of `ModifyPrefs` carries them as attributes.
    pub async fn modify_prefs(&self, prefs: &[(String, String)]) -> Result<(), MailError> {
        let mut attrs = Map::new();
        for (name, value) in prefs {
            attrs.insert(name.clone(), json!(value));
        }
        self.request_empty(json!({"ModifyPrefsRequest": {"_jsns": ACCOUNT_NS, "_attrs": attrs}}))
            .await
    }

    /// Out-of-office answer of the account.
    pub async fn get_vacation(&self) -> Result<Vacation, MailError> {
        let prefs = self.get_prefs(&VACATION_PREFS).await?;
        let pref = |index: usize| prefs.get(VACATION_PREFS[index]).map(String::as_str);
        Ok(Vacation {
            enabled: pref(0).is_some_and(truthy),
            message: pref(1).unwrap_or_default().to_string(),
            from: pref(2).and_then(iso_date),
            until: pref(3).and_then(iso_date),
        })
    }

    /// Writes the answer: no date clears the bound, no message empties the pref.
    pub async fn set_vacation(&self, vacation: &Vacation) -> Result<(), MailError> {
        let prefs = [
            (VACATION_PREFS[0].to_string(), flag_pref(vacation.enabled)),
            (VACATION_PREFS[1].to_string(), vacation.message.clone()),
            (
                VACATION_PREFS[2].to_string(),
                date_pref(vacation.from.as_deref(), false)?,
            ),
            (
                VACATION_PREFS[3].to_string(),
                date_pref(vacation.until.as_deref(), true)?,
            ),
        ];
        self.modify_prefs(&prefs).await
    }

    /// One POST. `token` is `None` for the `AuthRequest` itself.
    async fn post(&self, operation: Value, token: Option<&str>) -> Result<Value, MailError> {
        let mut context = Map::new();
        context.insert("_jsns".to_string(), json!(ZIMBRA_NS));
        if let Some(token) = token {
            context.insert("authToken".to_string(), json!(token));
        }
        let payload = json!({"Header": {"context": Value::Object(context)}, "Body": operation});
        let response = self
            .http
            .post(self.endpoint.clone())
            .header(reqwest::header::CONTENT_TYPE, CONTENT_TYPE)
            .header(reqwest::header::ACCEPT, ACCEPT)
            .body(payload.to_string())
            .send()
            .await
            .map_err(|error| {
                MailError::Soap(format!("{} injoignable : {error}", self.address()))
            })?;
        let status = response.status();
        let text = answer_body(response).await?;
        if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
            return Err(MailError::Auth(format!(
                "identifiants Zimbra refusés par {} ({})",
                self.address(),
                status.as_u16()
            )));
        }
        let answer: Value = serde_json::from_str(&text)
            .map_err(|error| MailError::Soap(format!("réponse SOAP illisible : {error}")))?;
        let body = answer
            .get("Body")
            .ok_or_else(|| MailError::Soap("réponse SOAP sans « Body »".to_string()))?;
        if let Some(fault) = fault(body) {
            return Err(fault.error());
        }
        Ok(body.clone())
    }

    /// The token of the last `AuthRequest`: the lock is taken and released here,
    /// so no guard can travel across the `await` of a call.
    fn cached_token(&self) -> Option<String> {
        self.token
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn store_token(&self, token: String) {
        *self
            .token
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(token);
    }

    /// Host and port of the endpoint: what an error message may show.
    fn address(&self) -> String {
        match (self.endpoint.host_str(), self.endpoint.port()) {
            (Some(host), Some(port)) => format!("{host}:{port}"),
            (Some(host), None) => host.to_string(),
            (None, _) => self.endpoint.path().to_string(),
        }
    }
}

/// SOAP endpoint of a mail account: the IMAP host, in HTTPS. A numeric loopback
/// host is joined in clear, the way the CalDAV source of a test account is.
pub fn account_endpoint(host: &str) -> String {
    let host = host.trim();
    let name = host.split(':').next().unwrap_or_default();
    let scheme = if name == "127.0.0.1" { "http" } else { "https" };
    format!("{scheme}://{host}/service/soap")
}

impl FilterTest {
    fn wire(&self) -> (&'static str, Value) {
        match self {
            Self::Header {
                header,
                comparison,
                value,
            } => {
                let (comparison, negative) = comparison.wire();
                (
                    "headerTest",
                    json!({"header": header, "stringComparison": comparison, "value": value, "negative": negative}),
                )
            }
            Self::Address {
                header,
                part,
                comparison,
                value,
            } => {
                let (comparison, negative) = comparison.wire();
                (
                    "addressTest",
                    json!({
                        "header": header,
                        "part": part.as_str(),
                        "stringComparison": comparison,
                        "value": value,
                        "negative": negative,
                    }),
                )
            }
            Self::Size { comparison, size } => (
                "sizeTest",
                json!({"numberComparison": comparison.as_str(), "s": size}),
            ),
            Self::Date { comparison, date } => (
                "dateTest",
                json!({
                    "dateComparison": comparison.as_str(),
                    "d": epoch_millis(date).unwrap_or_default(),
                }),
            ),
        }
    }

    /// One test of the answer, or `None` when it falls outside what this client
    /// writes back (the rule then stays read-only).
    fn read(key: &str, value: &Value) -> Option<Self> {
        let fields = value.as_object()?;
        let only = |names: &[&str]| {
            fields
                .keys()
                .all(|field| field == "_jsns" || names.contains(&field.as_str()))
        };
        let comparison = || {
            FilterComparison::parse(
                &text(fields.get("stringComparison")),
                flag(fields.get("negative")).unwrap_or(false),
            )
        };
        Some(match key {
            "headerTest" if only(&["header", "stringComparison", "value", "negative"]) => {
                let header = text(fields.get("header"));
                let value = text(fields.get("value"));
                if header.trim().is_empty() || value.is_empty() {
                    return None;
                }
                Self::Header {
                    header,
                    comparison: comparison()?,
                    value,
                }
            }
            "addressTest" if only(&["header", "part", "stringComparison", "value", "negative"]) => {
                let header = text(fields.get("header"));
                let value = text(fields.get("value"));
                if header.trim().is_empty() || value.is_empty() {
                    return None;
                }
                Self::Address {
                    header,
                    part: AddressPart::parse(&text(fields.get("part"))).unwrap_or(AddressPart::All),
                    comparison: comparison()?,
                    value,
                }
            }
            "sizeTest" if only(&["numberComparison", "s"]) => {
                let size = text(fields.get("s"));
                if !size_form(&size) {
                    return None;
                }
                Self::Size {
                    comparison: SizeComparison::parse(&text(fields.get("numberComparison")))?,
                    size,
                }
            }
            "dateTest" if only(&["dateComparison", "d", "negative"]) => Self::Date {
                comparison: DateComparison::parse(&text(fields.get("dateComparison")))?,
                date: day_of(fields.get("d"))?,
            },
            _ => return None,
        })
    }

    fn is_valid(&self) -> bool {
        match self {
            Self::Header { header, value, .. } | Self::Address { header, value, .. } => {
                !header.trim().is_empty() && !value.is_empty()
            }
            Self::Size { size, .. } => size_form(size),
            Self::Date { date, .. } => NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok(),
        }
    }
}

impl FilterAction {
    fn wire(&self) -> (&'static str, Value) {
        match self {
            Self::Keep => ("actionKeep", json!({})),
            Self::Discard => ("actionDiscard", json!({})),
            Self::Stop => ("actionStop", json!({})),
            Self::FileInto { folder_path } => {
                ("actionFileInto", json!({"folderPath": folder_path}))
            }
            Self::Tag { tag_name } => ("actionTag", json!({"tagName": tag_name})),
            Self::Flag { flag_name } => ("actionFlag", json!({"flagName": flag_name})),
            Self::Redirect { address } => ("actionRedirect", json!({"a": address})),
        }
    }

    fn read(key: &str, value: &Value) -> Option<Self> {
        let fields = value.as_object()?;
        let bare = || fields.keys().all(|field| field == "_jsns");
        let only = |name: &str| fields.keys().all(|field| field == "_jsns" || field == name);
        let required = |name: &str| {
            let value = text(fields.get(name));
            (!value.trim().is_empty()).then_some(value)
        };
        Some(match key {
            "actionKeep" if bare() => Self::Keep,
            "actionDiscard" if bare() => Self::Discard,
            "actionStop" if bare() => Self::Stop,
            "actionFileInto" if only("folderPath") => Self::FileInto {
                folder_path: required("folderPath")?,
            },
            "actionTag" if only("tagName") => Self::Tag {
                tag_name: required("tagName")?,
            },
            "actionFlag" if only("flagName") => Self::Flag {
                flag_name: required("flagName")?,
            },
            "actionRedirect" if only("a") => Self::Redirect {
                address: required("a")?,
            },
            _ => return None,
        })
    }

    fn is_valid(&self) -> bool {
        match self {
            Self::FileInto { folder_path } => !folder_path.trim().is_empty(),
            Self::Tag { tag_name } => !tag_name.trim().is_empty(),
            Self::Flag { flag_name } => !flag_name.trim().is_empty(),
            Self::Redirect { address } => address.contains('@'),
            Self::Keep | Self::Discard | Self::Stop => true,
        }
    }
}

impl FilterRule {
    /// The `filterRule` object to write: tests grouped by kind, actions in the
    /// order they run.
    pub fn to_wire(&self) -> Value {
        let mut tests = Map::new();
        tests.insert("condition".to_string(), json!(self.condition.as_str()));
        for test in &self.tests {
            let (key, value) = test.wire();
            match tests.get_mut(key) {
                Some(Value::Array(items)) => items.push(value),
                _ => {
                    tests.insert(key.to_string(), Value::Array(vec![value]));
                }
            }
        }
        let actions: Vec<Value> = self
            .actions
            .iter()
            .map(|action| {
                let (key, value) = action.wire();
                let mut entry = Map::new();
                entry.insert(key.to_string(), Value::Array(vec![value]));
                Value::Object(entry)
            })
            .collect();
        json!({
            "name": self.name,
            "active": self.active,
            "filterTests": [Value::Object(tests)],
            "filterActions": actions,
        })
    }

    /// One rule of the answer; what the model does not cover turns the rule
    /// read-only instead of being dropped.
    fn read(raw: &Value) -> Result<Self, MailError> {
        let Some(fields) = raw.as_object() else {
            return Err(MailError::Soap("règle de filtrage illisible".to_string()));
        };
        let name = text(fields.get("name")).trim().to_string();
        if name.is_empty() {
            return Err(MailError::Soap("règle de filtrage sans nom".to_string()));
        }
        let mut read_only = fields.keys().any(|key| {
            !matches!(
                key.as_str(),
                "name" | "active" | "filterTests" | "filterActions" | "_jsns"
            )
        });
        let mut condition = FilterCondition::AllOf;
        let mut tests = Vec::new();
        for wrapper in as_list(fields.get("filterTests")) {
            for (key, value) in wrapper.as_object().into_iter().flatten() {
                if key == "_jsns" {
                    continue;
                }
                if key == "condition" {
                    match FilterCondition::parse(&text(Some(value))) {
                        Some(parsed) => condition = parsed,
                        None => read_only = true,
                    }
                    continue;
                }
                for item in as_list(Some(value)) {
                    match FilterTest::read(key, item) {
                        Some(test) => tests.push(test),
                        None => read_only = true,
                    }
                }
            }
        }
        let mut actions = Vec::new();
        for wrapper in as_list(fields.get("filterActions")) {
            for (key, value) in wrapper.as_object().into_iter().flatten() {
                if key == "_jsns" {
                    continue;
                }
                for item in as_list(Some(value)) {
                    match FilterAction::read(key, item) {
                        Some(action) => actions.push(action),
                        None => read_only = true,
                    }
                }
            }
        }
        Ok(Self {
            name,
            active: flag(fields.get("active")).unwrap_or(true),
            condition,
            tests,
            actions,
            read_only,
        })
    }

    /// Refuses a rule the server would reject or that means nothing.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.name.trim().is_empty() {
            return Err("le nom du filtre est vide");
        }
        if self.tests.is_empty() {
            return Err("le filtre n'a aucune condition");
        }
        if self.actions.is_empty() {
            return Err("le filtre n'a aucune action");
        }
        if !self.tests.iter().all(FilterTest::is_valid) {
            return Err("une condition est incomplète");
        }
        if !self.actions.iter().all(FilterAction::is_valid) {
            return Err("une action est incomplète");
        }
        Ok(())
    }
}

/// The `filterRule` objects of a `GetFilterRulesResponse`.
fn parse_filter_rules(answer: &Value) -> Result<Vec<ServerFilterRule>, MailError> {
    let mut rules = Vec::new();
    for wrapper in as_list(answer.get("filterRules")) {
        for raw in as_list(wrapper.get("filterRule")) {
            rules.push(ServerFilterRule {
                rule: FilterRule::read(raw)?,
                raw: raw.clone(),
            });
        }
    }
    Ok(rules)
}

/// Zimbra repeats list members in an array; a single one may come as an object.
fn as_list(value: Option<&Value>) -> Vec<&Value> {
    match value {
        Some(Value::Array(items)) => items.iter().collect(),
        Some(item @ Value::Object(_)) => vec![item],
        _ => Vec::new(),
    }
}

fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        _ => String::new(),
    }
}

/// Zimbra writes booleans as JSON booleans, older answers as `1`/`0`.
fn flag(value: Option<&Value>) -> Option<bool> {
    match value? {
        Value::Bool(flag) => Some(*flag),
        Value::Number(number) => Some(number.as_i64()? != 0),
        Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "1" | "true" => Some(true),
            "0" | "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// A pref boolean: Zimbra stores `TRUE`/`FALSE`.
fn truthy(value: &str) -> bool {
    matches!(value.trim().to_ascii_lowercase().as_str(), "true" | "1")
}

fn flag_pref(value: bool) -> String {
    if value { "TRUE" } else { "FALSE" }.to_string()
}

/// Size of a `sizeTest`: a number, in bytes or with a `K`/`M`/`G` suffix.
fn size_form(size: &str) -> bool {
    let trimmed = size.trim();
    let digits = match trimmed.chars().last() {
        Some(last) if last.is_ascii_alphabetic() => &trimmed[..trimmed.len() - 1],
        _ => trimmed,
    };
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

/// `AAAA-MM-JJ` → the generalized time Zimbra keeps for a date bound.
pub fn zimbra_date(date: &str, end_of_day: bool) -> Option<String> {
    let day = NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d").ok()?;
    let clock = if end_of_day { "235959" } else { "000000" };
    Some(format!("{}{clock}Z", day.format("%Y%m%d")))
}

/// Generalized time of a pref → `AAAA-MM-JJ`; anything else is ignored.
fn iso_date(value: &str) -> Option<String> {
    let digits = value.trim().trim_end_matches('Z');
    if digits.len() < 8 || !digits[..8].bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let day = NaiveDate::parse_from_str(&digits[..8], "%Y%m%d").ok()?;
    Some(day.format("%Y-%m-%d").to_string())
}

fn date_pref(date: Option<&str>, end_of_day: bool) -> Result<String, MailError> {
    match date.map(str::trim) {
        None | Some("") => Ok(String::new()),
        Some(date) => zimbra_date(date, end_of_day).ok_or_else(|| {
            MailError::Config(format!(
                "date Zimbra invalide : « {date} » (AAAA-MM-JJ attendu)"
            ))
        }),
    }
}

/// `AAAA-MM-JJ` → the millisecond timestamp a `dateTest` compares.
fn epoch_millis(date: &str) -> Option<i64> {
    let day = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    Some(day.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis())
}

fn day_of(value: Option<&Value>) -> Option<String> {
    let millis = match value? {
        Value::Number(number) => number.as_i64()?,
        Value::String(text) => text.trim().parse::<i64>().ok()?,
        _ => return None,
    };
    let day = chrono::DateTime::from_timestamp_millis(millis)?.date_naive();
    Some(day.format("%Y-%m-%d").to_string())
}

/// The `...Response` of a `Body`: the only named member of a successful answer.
fn answer<T: DeserializeOwned>(body: Value) -> Result<T, MailError> {
    let Value::Object(fields) = body else {
        return Err(MailError::Soap("réponse SOAP inattendue".to_string()));
    };
    let (name, value) = fields
        .into_iter()
        .find(|(name, _)| name.ends_with("Response"))
        .ok_or_else(|| MailError::Soap("réponse SOAP sans réponse nommée".to_string()))?;
    serde_json::from_value(value)
        .map_err(|error| MailError::Soap(format!("réponse {name} illisible : {error}")))
}

/// `Body.Fault` of a failed call: the code decides whether a new token can
/// help, the reason says what the server refused.
struct Fault {
    code: String,
    text: String,
}

impl Fault {
    fn error(self) -> MailError {
        let text: String = self.text.chars().take(MAX_FAULT_CHARS).collect();
        if is_auth_code(&self.code) {
            return MailError::Auth(format!("{} ({})", text, self.code));
        }
        MailError::Soap(format!("{} ({})", text, self.code))
    }
}

fn is_auth_code(code: &str) -> bool {
    let name = code.rsplit('.').next().unwrap_or(code);
    AUTH_CODES.contains(&name)
}

fn fault(body: &Value) -> Option<Fault> {
    let fault = body.get("Fault")?;
    let code = fault
        .pointer("/Detail/Error/Code")
        .or_else(|| fault.pointer("/Code/Value"))
        .and_then(Value::as_str)
        .unwrap_or("soap:SoapFault");
    let text = fault
        .pointer("/Reason/Text")
        .and_then(Value::as_str)
        .unwrap_or("requête refusée par le serveur Zimbra");
    Some(Fault {
        code: code.to_string(),
        text: text.to_string(),
    })
}

fn parse_endpoint(raw: &str) -> Result<Url, MailError> {
    let url = Url::parse(raw.trim())
        .map_err(|error| MailError::Config(format!("URL SOAP invalide : {error}")))?;
    match url.scheme() {
        "https" => {}
        "http" if url.host_str().is_some_and(is_loopback) => {}
        "http" => {
            return Err(MailError::Config(
                "SOAP : HTTPS requis hors boucle locale".to_string(),
            ))
        }
        scheme => {
            return Err(MailError::Config(format!(
                "schéma d'URL refusé : « {scheme} » (http ou https)"
            )))
        }
    }
    if url.host_str().is_none() {
        return Err(MailError::Config("URL SOAP sans hôte".to_string()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(MailError::Config(
            "l'URL SOAP ne doit pas porter d'identifiants".to_string(),
        ));
    }
    Ok(url)
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "::1" | "[::1]" | "localhost")
}

async fn answer_body(mut response: reqwest::Response) -> Result<String, MailError> {
    if let Some(announced) = response.content_length() {
        if announced > MAX_SOAP_BYTES as u64 {
            return Err(too_large());
        }
    }
    let mut buffer = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| MailError::Soap(format!("réponse interrompue : {error}")))?
    {
        if buffer.len() + chunk.len() > MAX_SOAP_BYTES {
            return Err(too_large());
        }
        buffer.extend_from_slice(&chunk);
    }
    String::from_utf8(buffer).map_err(|_| MailError::Soap("réponse SOAP non UTF-8".to_string()))
}

fn too_large() -> MailError {
    MailError::Soap(format!(
        "réponse SOAP trop volumineuse (maximum {MAX_SOAP_BYTES} octets)"
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    const AUTH_ANSWER: &str = r#"{"Header":{"context":{"_jsns":"urn:zimbra"}},
        "Body":{"AuthResponse":{"_jsns":"urn:zimbraAccount","authToken":"jeton-1","lifetime":43199999}}}"#;

    const EXPIRED_ANSWER: &str = r#"{"Body":{"Fault":{"Reason":{"Text":"auth credentials have expired"},
        "Detail":{"Error":{"Code":"service.AUTH_EXPIRED"}}}}}"#;

    /// The real server prefixes the code with the component that refused and
    /// answers HTTP 500, both copied from mailserver.grenoble.archi.fr.
    const REFUSED_ANSWER: &str = r#"{"Body":{"Fault":{"Code":{"Value":"soap:Sender"},
        "Reason":{"Text":"authentication failed for [roman]"},
        "Detail":{"Error":{"Code":"account.AUTH_FAILED"}}}}}"#;

    const FAILURE_ANSWER: &str = r#"{"Body":{"Fault":{"Code":{"Value":"soap:Receiver"},
        "Reason":{"Text":"service failure"},
        "Detail":{"Error":{"Code":"service.FAILURE"}}}}}"#;

    const INFO_ANSWER: &str = r#"{"Header":{"context":{"_jsns":"urn:zimbra"}},
        "Body":{"GetInfoResponse":{"_jsns":"urn:zimbraAccount",
        "name":"roman@exemple.tld","id":"7f2c","version":"9.0.0_GA_4642"}}}"#;

    /// Faux Zimbra : une réponse par requête, dans l'ordre, et les corps reçus.
    async fn serve(answers: Vec<&'static str>) -> (String, Arc<Mutex<Vec<Value>>>) {
        use tokio::io::AsyncWriteExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("écoute");
        let address = listener.local_addr().expect("adresse locale");
        let received = Arc::new(Mutex::new(Vec::new()));
        let seen = received.clone();
        let mut answers = answers.into_iter();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let seen = seen.clone();
                let answer = answers.next().unwrap_or(r#"{"Body":{}}"#);
                tokio::spawn(async move {
                    if let Some(body) = read_request(&mut socket).await {
                        if let Ok(value) = serde_json::from_str::<Value>(&body) {
                            seen.lock().expect("journal").push(value);
                        }
                    }
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n\
                         Content-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                        answer.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        (format!("http://{address}/service/soap"), received)
    }

    /// Corps d'une requête, une fois l'en-tête et son `Content-Length` lus.
    async fn read_request(socket: &mut tokio::net::TcpStream) -> Option<String> {
        use tokio::io::AsyncReadExt;

        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        let mut start = None;
        let mut length = 0usize;
        while let Ok(read) = socket.read(&mut chunk).await {
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
            let text = String::from_utf8_lossy(&buffer).to_string();
            if start.is_none() {
                if let Some(end) = text.find("\r\n\r\n") {
                    length = text[..end]
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    start = Some(end + 4);
                }
            }
            if let Some(begin) = start {
                if buffer.len() >= begin + length {
                    return String::from_utf8(buffer[begin..begin + length].to_vec()).ok();
                }
            }
        }
        None
    }

    #[tokio::test]
    async fn the_login_hands_out_the_token_get_info_uses() {
        let (url, received) = serve(vec![AUTH_ANSWER, INFO_ANSWER]).await;
        let client = SoapClient::new(&url, "roman@exemple.tld", "secret").expect("client");
        let info = client.get_info().await.expect("GetInfo");
        assert_eq!(info.name.as_deref(), Some("roman@exemple.tld"));
        assert_eq!(info.id.as_deref(), Some("7f2c"));
        assert_eq!(info.version.as_deref(), Some("9.0.0_GA_4642"));
        let requests = received.lock().expect("journal");
        assert_eq!(requests.len(), 2);
        let login = &requests[0]["Body"]["AuthRequest"];
        assert_eq!(login["_jsns"], "urn:zimbraAccount");
        assert_eq!(login["account"]["by"], "name");
        assert_eq!(login["account"]["_content"], "roman@exemple.tld");
        assert_eq!(login["password"], "secret");
        assert!(requests[0]["Header"]["context"].get("authToken").is_none());
        let call = &requests[1];
        assert!(call["Body"].get("GetInfoRequest").is_some());
        assert_eq!(call["Header"]["context"]["authToken"], "jeton-1");
        assert_eq!(call["Header"]["context"]["_jsns"], "urn:zimbra");
    }

    #[tokio::test]
    async fn the_token_stays_out_of_debug() {
        let (url, _) = serve(vec![AUTH_ANSWER]).await;
        let client = SoapClient::new(&url, "roman@exemple.tld", "secret").expect("client");
        let token = client.authenticate().await.expect("entrée");
        assert_eq!(token.token, "jeton-1");
        assert!(!format!("{token:?}").contains("jeton-1"));
    }

    #[tokio::test]
    async fn a_refused_login_never_echoes_the_password() {
        let (url, _) = serve(vec![REFUSED_ANSWER]).await;
        let client = SoapClient::new(&url, "roman@exemple.tld", "secret").expect("client");
        let error = client.get_info().await.expect_err("refus");
        assert!(matches!(error, MailError::Auth(_)), "{error}");
        assert!(error.to_string().contains("account.AUTH_FAILED"), "{error}");
        assert!(!error.to_string().contains("secret"), "{error}");
    }

    #[tokio::test]
    async fn a_soap_fault_the_token_cannot_fix_is_not_replayed() {
        let (url, received) = serve(vec![AUTH_ANSWER, FAILURE_ANSWER]).await;
        let client = SoapClient::new(&url, "roman@exemple.tld", "secret").expect("client");
        let error = client.get_info().await.expect_err("faute serveur");
        assert!(matches!(error, MailError::Soap(_)), "{error}");
        assert!(error.to_string().contains("service.FAILURE"), "{error}");
        let requests = received.lock().expect("journal");
        assert_eq!(requests.len(), 2);
    }

    #[tokio::test]
    async fn an_expired_token_is_renewed_once() {
        let (url, received) =
            serve(vec![AUTH_ANSWER, EXPIRED_ANSWER, AUTH_ANSWER, INFO_ANSWER]).await;
        let client = SoapClient::new(&url, "roman@exemple.tld", "secret").expect("client");
        client.authenticate().await.expect("entrée");
        let info = client
            .get_info()
            .await
            .expect("GetInfo après renouvellement");
        assert_eq!(info.name.as_deref(), Some("roman@exemple.tld"));
        let requests = received.lock().expect("journal");
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[0]["Header"]["context"].get("authToken"), None);
        assert!(requests[1]["Body"].get("GetInfoRequest").is_some());
        assert!(requests[2]["Body"].get("AuthRequest").is_some());
        assert!(requests[3]["Body"].get("GetInfoRequest").is_some());
        assert_eq!(requests[3]["Header"]["context"]["authToken"], "jeton-1");
    }

    #[tokio::test]
    async fn a_silent_server_is_a_soap_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("écoute");
        let address = listener.local_addr().expect("adresse locale");
        drop(listener);
        let url = format!("http://{address}/service/soap");
        let client = SoapClient::new(&url, "roman@exemple.tld", "secret").expect("client");
        let error = client.get_info().await.expect_err("serveur absent");
        assert!(matches!(error, MailError::Soap(_)), "{error}");
        assert!(!error.to_string().contains("secret"), "{error}");
    }

    #[test]
    fn an_endpoint_outside_loopback_needs_https() {
        let error = match SoapClient::new("http://mail.exemple.tld/service/soap", "roman", "secret")
        {
            Ok(_) => panic!("http hors boucle locale accepté"),
            Err(error) => error,
        };
        assert!(matches!(error, MailError::Config(_)), "{error}");
        let client = SoapClient::new("https://mail.exemple.tld/service/soap", "roman", "secret")
            .expect("client");
        assert_eq!(
            client.endpoint.as_str(),
            "https://mail.exemple.tld/service/soap?fmt=json"
        );
    }

    /// La forme exacte que Zimbra sérialise (son propre test JaxbToJson).
    const FILTERS_ANSWER: &str = r#"{"Header":{"context":{"_jsns":"urn:zimbra"}},
        "Body":{"GetFilterRulesResponse":{"_jsns":"urn:zimbraMail","filterRules":[{"filterRule":[
        {"name":"facture","active":false,
         "filterTests":[{"condition":"anyof","headerTest":[
            {"header":"X-Spam-Score","stringComparison":"contains","value":"0"}]}],
         "filterActions":[{"actionFlag":[{"flagName":"flagged"}]},{"actionStop":[{}]}]}]}]}}}"#;

    const NOTIFY_ANSWER: &str = r#"{"Body":{"GetFilterRulesResponse":{"_jsns":"urn:zimbraMail",
        "filterRules":[{"filterRule":[{"name":"alerte","active":"1",
        "filterTests":[{"condition":"allof","addressTest":[
            {"header":"from","part":"domain","stringComparison":"is","value":"exemple.tld"}]}],
        "filterActions":[{"actionNotify":[{"a":"autre@exemple.tld"}]}]}]}]}}}"#;

    const MODIFIED_ANSWER: &str =
        r#"{"Body":{"ModifyFilterRulesResponse":{"_jsns":"urn:zimbraMail"}}}"#;

    const PREFS_ANSWER: &str = r#"{"Body":{"GetPrefsResponse":{"_jsns":"urn:zimbraAccount",
        "pref":[
        {"name":"zimbraPrefOutOfOfficeReplyEnabled","_content":"TRUE"},
        {"name":"zimbraPrefOutOfOfficeReply","_content":"Absent jusqu'à lundi."},
        {"name":"zimbraPrefOutOfOfficeFromDate","_content":"20260101000000Z"},
        {"name":"zimbraPrefOutOfOfficeUntilDate","_content":""}]}}}"#;

    const PREFS_WRITTEN: &str = r#"{"Body":{"ModifyPrefsResponse":{"_jsns":"urn:zimbraAccount"}}}"#;

    #[tokio::test]
    async fn the_filter_rules_of_the_server_are_read() {
        let (url, received) = serve(vec![AUTH_ANSWER, FILTERS_ANSWER]).await;
        let client = SoapClient::new(&url, "roman@exemple.tld", "secret").expect("client");
        let rules = client.get_filter_rules().await.expect("GetFilterRules");
        assert_eq!(rules.len(), 1);
        let rule = &rules[0].rule;
        assert_eq!(rule.name, "facture");
        assert!(!rule.active);
        assert_eq!(rule.condition, FilterCondition::AnyOf);
        assert_eq!(
            rule.tests,
            vec![FilterTest::Header {
                header: "X-Spam-Score".to_string(),
                comparison: FilterComparison::Contains,
                value: "0".to_string(),
            }]
        );
        assert_eq!(
            rule.actions,
            vec![
                FilterAction::Flag {
                    flag_name: "flagged".to_string()
                },
                FilterAction::Stop,
            ]
        );
        assert!(!rule.read_only);
        let requests = received.lock().expect("journal");
        assert_eq!(
            requests[1]["Body"]["GetFilterRulesRequest"]["_jsns"],
            "urn:zimbraMail"
        );
    }

    #[tokio::test]
    async fn a_rule_the_client_cannot_rewrite_is_read_only() {
        let (url, _) = serve(vec![AUTH_ANSWER, NOTIFY_ANSWER]).await;
        let client = SoapClient::new(&url, "roman@exemple.tld", "secret").expect("client");
        let rules = client.get_filter_rules().await.expect("GetFilterRules");
        let rule = &rules[0];
        assert!(rule.rule.read_only, "{rule:?}");
        assert_eq!(rule.rule.name, "alerte");
        assert!(rule.rule.active);
        assert_eq!(rule.raw["name"], "alerte");
    }

    #[tokio::test]
    async fn the_whole_rule_list_is_written_back() {
        let (url, received) = serve(vec![AUTH_ANSWER, FILTERS_ANSWER, MODIFIED_ANSWER]).await;
        let client = SoapClient::new(&url, "roman@exemple.tld", "secret").expect("client");
        let mut rules = client.get_filter_rules().await.expect("GetFilterRules");
        rules.push(ServerFilterRule {
            rule: FilterRule {
                name: "dossier".to_string(),
                active: true,
                condition: FilterCondition::AllOf,
                tests: vec![FilterTest::Address {
                    header: "from".to_string(),
                    part: AddressPart::Domain,
                    comparison: FilterComparison::NotIs,
                    value: "exemple.tld".to_string(),
                }],
                actions: vec![FilterAction::FileInto {
                    folder_path: "Archive".to_string(),
                }],
                read_only: false,
            },
            raw: Value::Null,
        });
        let added = rules[1].rule.to_wire();
        rules[1].raw = added;
        client
            .modify_filter_rules(&rules)
            .await
            .expect("ModifyFilterRules");
        let requests = received.lock().expect("journal");
        let sent = &requests[2]["Body"]["ModifyFilterRulesRequest"];
        assert_eq!(sent["_jsns"], "urn:zimbraMail");
        let written = &sent["filterRules"][1]["filterRule"][0];
        assert_eq!(written["name"], "dossier");
        assert_eq!(written["active"], true);
        assert_eq!(written["filterTests"][0]["condition"], "allof");
        assert_eq!(
            written["filterTests"][0]["addressTest"][0]["header"],
            "from"
        );
        assert_eq!(
            written["filterTests"][0]["addressTest"][0]["part"],
            "domain"
        );
        assert_eq!(
            written["filterTests"][0]["addressTest"][0]["stringComparison"],
            "is"
        );
        assert_eq!(
            written["filterTests"][0]["addressTest"][0]["negative"],
            true
        );
        assert_eq!(
            written["filterActions"][0]["actionFileInto"][0]["folderPath"],
            "Archive"
        );
        assert_eq!(sent["filterRules"][0]["filterRule"][0]["name"], "facture");
    }

    #[tokio::test]
    async fn the_vacation_answer_is_read_and_written() {
        let (url, received) = serve(vec![AUTH_ANSWER, PREFS_ANSWER, PREFS_WRITTEN]).await;
        let client = SoapClient::new(&url, "roman@exemple.tld", "secret").expect("client");
        let vacation = client.get_vacation().await.expect("GetPrefs");
        assert_eq!(
            vacation,
            Vacation {
                enabled: true,
                message: "Absent jusqu'à lundi.".to_string(),
                from: Some("2026-01-01".to_string()),
                until: None,
            }
        );
        client
            .set_vacation(&Vacation {
                enabled: false,
                message: "De retour lundi.".to_string(),
                from: Some("2026-01-01".to_string()),
                until: Some("2026-01-15".to_string()),
            })
            .await
            .expect("ModifyPrefs");
        let requests = received.lock().expect("journal");
        assert_eq!(
            requests[1]["Body"]["GetPrefsRequest"]["pref"][0]["name"],
            "zimbraPrefOutOfOfficeReplyEnabled"
        );
        let attrs = &requests[2]["Body"]["ModifyPrefsRequest"]["_attrs"];
        assert_eq!(attrs["zimbraPrefOutOfOfficeReplyEnabled"], "FALSE");
        assert_eq!(attrs["zimbraPrefOutOfOfficeReply"], "De retour lundi.");
        assert_eq!(attrs["zimbraPrefOutOfOfficeFromDate"], "20260101000000Z");
        assert_eq!(attrs["zimbraPrefOutOfOfficeUntilDate"], "20260115235959Z");
    }

    #[test]
    fn zimbra_dates_are_generalized_times() {
        assert_eq!(
            zimbra_date("2026-01-01", false).as_deref(),
            Some("20260101000000Z")
        );
        assert_eq!(
            zimbra_date("2026-01-15", true).as_deref(),
            Some("20260115235959Z")
        );
        assert_eq!(zimbra_date("01/01/2026", false), None);
        assert_eq!(zimbra_date("2026-02-30", false), None);
        assert_eq!(iso_date("20260101000000Z").as_deref(), Some("2026-01-01"));
        assert_eq!(iso_date(""), None);
        assert_eq!(iso_date("pas une date"), None);
    }

    #[test]
    fn a_rule_needs_a_name_a_test_and_an_action() {
        let rule = FilterRule {
            name: " ".to_string(),
            active: true,
            condition: FilterCondition::AnyOf,
            tests: vec![],
            actions: vec![],
            read_only: false,
        };
        assert_eq!(rule.validate(), Err("le nom du filtre est vide"));
        let named = FilterRule {
            name: "vide".to_string(),
            ..rule
        };
        assert_eq!(named.validate(), Err("le filtre n'a aucune condition"));
        let tested = FilterRule {
            tests: vec![FilterTest::Size {
                comparison: SizeComparison::Over,
                size: "50K".to_string(),
            }],
            ..named
        };
        assert_eq!(tested.validate(), Err("le filtre n'a aucune action"));
        let incomplete = FilterRule {
            actions: vec![FilterAction::Redirect {
                address: "pas-une-adresse".to_string(),
            }],
            ..tested
        };
        assert_eq!(incomplete.validate(), Err("une action est incomplète"));
    }

    #[test]
    fn the_size_of_a_test_travels_as_zimbra_writes_it() {
        let rule = FilterRule {
            name: "gros".to_string(),
            active: false,
            condition: FilterCondition::AllOf,
            tests: vec![
                FilterTest::Size {
                    comparison: SizeComparison::Over,
                    size: "2M".to_string(),
                },
                FilterTest::Date {
                    comparison: DateComparison::Before,
                    date: "2026-01-01".to_string(),
                },
            ],
            actions: vec![
                FilterAction::Keep,
                FilterAction::Tag {
                    tag_name: "tri".to_string(),
                },
            ],
            read_only: false,
        };
        assert_eq!(
            rule.to_wire(),
            json!({
                "name": "gros",
                "active": false,
                "filterTests": [{
                    "condition": "allof",
                    "sizeTest": [{"numberComparison": "over", "s": "2M"}],
                    "dateTest": [{"dateComparison": "before", "d": 1767225600000i64}],
                }],
                "filterActions": [
                    {"actionKeep": [{}]},
                    {"actionTag": [{"tagName": "tri"}]},
                ],
            })
        );
    }

    #[test]
    fn the_account_endpoint_follows_the_imap_host() {
        assert_eq!(
            account_endpoint(" zimap.exemple.tld "),
            "https://zimap.exemple.tld/service/soap"
        );
        assert_eq!(
            account_endpoint("127.0.0.1:8080"),
            "http://127.0.0.1:8080/service/soap"
        );
    }
}
