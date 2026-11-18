use url::Url;

#[cfg(target_os = "linux")]
use std::{collections::HashMap, time::Duration};

/// Sous KDE Wayland, `xdg-open` délègue à `kde-open6` qui échoue après plus de
/// 250 ms : la fenêtre d'échec par défaut du crate `open` croit alors à un
/// succès et aucun launcher de secours n'est tenté.
#[cfg(target_os = "linux")]
const LAUNCHER_FAILURE_WINDOW: Duration = Duration::from_secs(5);

/// Le portal est best-effort : s'il ne répond pas, les launchers restent la voie
/// de secours, donc inutile d'attendre longtemps.
#[cfg(target_os = "linux")]
const PORTAL_TIMEOUT: Duration = Duration::from_secs(2);

fn validate_http_url(raw: &str) -> Result<(), String> {
    let url = Url::parse(raw.trim()).map_err(|error| format!("URL invalide : {error}"))?;
    match url.scheme() {
        "http" | "https" => Ok(()),
        scheme => Err(format!("schéma non supporté : {scheme}")),
    }
}

#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    validate_http_url(&url)?;
    launcher_open(url).await
}

#[cfg(target_os = "linux")]
async fn launcher_open(url: String) -> Result<(), String> {
    if let Ok(Ok(())) = tokio::time::timeout(PORTAL_TIMEOUT, portal_open(&url)).await {
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
async fn portal_open(url: &str) -> Result<(), zbus::Error> {
    let connection = zbus::Connection::session().await?;
    let proxy = zbus::Proxy::new(
        &connection,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.OpenURI",
    )
    .await?;
    let options: HashMap<String, zbus::zvariant::Value> = HashMap::new();
    let _request: zbus::zvariant::OwnedObjectPath =
        proxy.call("OpenURI", &("", url, options)).await?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
async fn launcher_open(url: String) -> Result<(), String> {
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|error| error.to_string())
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
