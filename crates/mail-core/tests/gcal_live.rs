//! Live read of a real Google Calendar account, ignored by default: it needs a
//! connected account. Run it with:
//!
//! ```sh
//! LAVANDE_GCAL_EMAIL=… LAVANDE_GCAL_CLIENT_ID=… LAVANDE_GCAL_CLIENT_SECRET=… \
//! LAVANDE_GCAL_REFRESH_TOKEN=… \
//!   cargo test -p lavande-mail --test gcal_live -- --ignored --nocapture
//! ```

use std::env;

use lavande_mail::config::{AccountConfig, AuthConfig, Encryption, Endpoint};
use lavande_mail::gcal::GcalClient;

fn variable(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("{name} is not set"))
}

#[tokio::test]
#[ignore = "requires a connected Google account (LAVANDE_GCAL_* variables)"]
async fn a_real_account_lists_its_calendars_and_events() {
    let account = AccountConfig {
        id: "google-live".to_string(),
        label: "Google".to_string(),
        email: variable("LAVANDE_GCAL_EMAIL"),
        username: "me".to_string(),
        imap: Endpoint {
            host: "imap.gmail.com".to_string(),
            port: 993,
            encryption: Encryption::Tls,
        },
        smtp: Endpoint {
            host: "smtp.gmail.com".to_string(),
            port: 465,
            encryption: Encryption::Tls,
        },
        auth: AuthConfig::OAuth2 {
            client_id: variable("LAVANDE_GCAL_CLIENT_ID"),
            client_secret: variable("LAVANDE_GCAL_CLIENT_SECRET"),
            refresh_token: variable("LAVANDE_GCAL_REFRESH_TOKEN"),
            token_endpoint: "https://oauth2.googleapis.com/token".to_string(),
        },
    };
    let mut client = GcalClient::new(&account).expect("client Google Calendar");
    let calendars = client.calendars().await.expect("calendriers Google");
    assert!(!calendars.is_empty(), "aucun calendrier");
    let primary = calendars
        .iter()
        .find(|calendar| calendar.primary)
        .unwrap_or(&calendars[0]);
    let events = client
        .events(&primary.id, None, None)
        .await
        .expect("événements Google");
    println!(
        "{} calendriers, {} événements dans « {} »",
        calendars.len(),
        events.len(),
        primary.summary
    );
}
