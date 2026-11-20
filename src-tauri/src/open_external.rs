use url::Url;

#[cfg(not(target_os = "linux"))]
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "linux")]
use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

#[cfg(target_os = "linux")]
use zbus::export::futures_util::StreamExt;

/// Sous KDE Wayland, `xdg-open` délègue à `kde-open6` qui échoue après plus de
/// 250 ms : la fenêtre d'échec par défaut du crate `open` croit alors à un
/// succès et aucun launcher de secours n'est tenté.
#[cfg(target_os = "linux")]
const LAUNCHER_FAILURE_WINDOW: Duration = Duration::from_secs(5);

/// Le portal est best-effort : s'il ne répond pas, les launchers restent la voie
/// de secours, donc inutile d'attendre longtemps.
#[cfg(target_os = "linux")]
const PORTAL_TIMEOUT: Duration = Duration::from_secs(2);

/// `OpenURI` rend la main avant d'avoir ouvert quoi que ce soit : le verdict réel
/// arrive ensuite par le signal `Response` de la Request, qu'un backend lent (KDE
/// Wayland) peut émettre plusieurs secondes après l'appel.
#[cfg(target_os = "linux")]
const PORTAL_RESPONSE_TIMEOUT: Duration = Duration::from_secs(5);

/// Jeton `handle_token` unique par appel : le portal nomme alors la Request
/// `/org/freedesktop/portal/desktop/request/{expéditeur}/{jeton}`, chemin connu
/// d'avance, donc le signal `Response` est écouté avant même l'appel `OpenURI`.
#[cfg(target_os = "linux")]
static PORTAL_HANDLE_TOKEN: AtomicU64 = AtomicU64::new(0);

fn validate_http_url(raw: &str) -> Result<(), String> {
    let url = Url::parse(raw.trim()).map_err(|error| format!("URL invalide : {error}"))?;
    match url.scheme() {
        "http" | "https" => Ok(()),
        scheme => Err(format!("schéma non supporté : {scheme}")),
    }
}

#[tauri::command]
pub async fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    validate_http_url(&url)?;
    launcher_open(app, url).await
}

#[cfg(target_os = "linux")]
async fn launcher_open(_app: tauri::AppHandle, url: String) -> Result<(), String> {
    if portal_open(&url).await {
        return Ok(());
    }
    tokio::task::spawn_blocking(move || {
        open::that_detached_with_timeout(&url, LAUNCHER_FAILURE_WINDOW)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
async fn portal_open(url: &str) -> bool {
    let Ok(connection) = zbus::Connection::session().await else {
        return false;
    };
    let Some(sender) = connection
        .unique_name()
        .map(|name| name.as_str().trim_start_matches(':').replace('.', "_"))
    else {
        return false;
    };
    let token = format!(
        "lavande{}",
        PORTAL_HANDLE_TOKEN.fetch_add(1, Ordering::Relaxed)
    );
    let request_path = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
    let Ok(request) = zbus::Proxy::new(
        &connection,
        "org.freedesktop.portal.Desktop",
        request_path.as_str(),
        "org.freedesktop.impl.portal.Request",
    )
    .await
    else {
        return false;
    };
    let Ok(mut responses) = request.receive_signal("Response").await else {
        return false;
    };
    let Ok(portal) = zbus::Proxy::new(
        &connection,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.OpenURI",
    )
    .await
    else {
        return false;
    };
    let mut options: HashMap<String, zbus::zvariant::Value> = HashMap::new();
    options.insert("handle_token".to_string(), token.as_str().into());
    let opened = tokio::time::timeout(
        PORTAL_TIMEOUT,
        portal.call::<_, _, zbus::zvariant::OwnedObjectPath>("OpenURI", &("", url, options)),
    )
    .await;
    if !matches!(opened, Ok(Ok(_))) {
        return false;
    }
    let Ok(Some(response)) = tokio::time::timeout(PORTAL_RESPONSE_TIMEOUT, responses.next()).await
    else {
        return false;
    };
    let Ok((code, _results)) = response
        .body()
        .deserialize::<(u32, HashMap<String, zbus::zvariant::OwnedValue>)>()
    else {
        return false;
    };
    code == 0
}

#[cfg(not(target_os = "linux"))]
async fn launcher_open(app: tauri::AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::validate_http_url;

    #[test]
    fn accepte_http_et_https() {
        for url in [
            "http://exemple.fr",
            "https://exemple.fr/chemin?q=1#bas",
            "  https://exemple.fr  ",
        ] {
            assert!(validate_http_url(url).is_ok(), "{url}");
        }
    }

    #[test]
    fn refuse_les_autres_schemas() {
        for url in [
            "ftp://exemple.fr",
            "javascript:alert(1)",
            "data:text/plain,x",
            "file:///tmp/x",
            "",
            "   ",
            "exemple.fr",
        ] {
            assert!(validate_http_url(url).is_err(), "{url}");
        }
    }
}
