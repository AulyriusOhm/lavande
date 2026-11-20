use url::Url;

#[cfg(not(target_os = "linux"))]
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "linux")]
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

/// Sous KDE Wayland, `xdg-open` délègue à `kde-open6` qui échoue après plus de
/// 250 ms : la fenêtre d'échec par défaut du crate `open` croit alors à un
/// succès et aucun launcher de secours n'est tenté.
#[cfg(target_os = "linux")]
const LAUNCHER_FAILURE_WINDOW: Duration = Duration::from_secs(5);

/// L'activation de la fenêtre est best-effort : l'URL est déjà ouverte, donc les
/// appels D-Bus ne doivent jamais retarder la commande plus que ça.
#[cfg(target_os = "linux")]
const KWIN_SCRIPT_TIMEOUT: Duration = Duration::from_secs(2);

/// Chaque script KWin temporaire a besoin d'un nom de fichier distinct.
#[cfg(target_os = "linux")]
static KWIN_SCRIPT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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

/// Le portal `OpenURI` n'est plus une option : sur Fedora récente, ni le backend
/// GTK ni le backend KDE n'implémentent `org.freedesktop.impl.portal.OpenURI` —
/// l'appel rend un chemin de Request mais aucun signal `Response` n'arrive jamais
/// et rien ne s'ouvre. Les launchers du crate `open` sont donc le seul chemin.
#[cfg(target_os = "linux")]
async fn launcher_open(_app: tauri::AppHandle, url: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        open::that_detached_with_timeout(&url, LAUNCHER_FAILURE_WINDOW)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    kde_activate_browser().await;
    Ok(())
}

/// Sous Wayland, KWin refuse l'activation demandée par le client qui vient de
/// recevoir le clic (pas de jeton d'activation frais) : l'onglet s'ouvre en
/// arrière-plan et l'utilisateur conclut que « rien ne se passe ». Le scripting
/// KWin, lui, passe par le compositeur, qui a le droit d'activer une fenêtre :
/// un script chargé puis exécuté aussitôt active la fenêtre du navigateur
/// par défaut. Best-effort complet, tout échec est ignoré (l'URL est ouverte).
#[cfg(target_os = "linux")]
async fn kde_activate_browser() {
    if std::env::var("KDE_FULL_SESSION").as_deref() != Ok("true") {
        return;
    }
    let Some(wm_class) = default_browser_wm_class() else {
        return;
    };
    let Ok(script_path) = write_activation_script(&wm_class) else {
        return;
    };
    let _ = tokio::time::timeout(KWIN_SCRIPT_TIMEOUT, run_kwin_script(&script_path)).await;
    let _ = std::fs::remove_file(&script_path);
}

#[cfg(target_os = "linux")]
async fn run_kwin_script(script_path: &Path) -> Option<()> {
    let path = script_path.to_str()?.to_string();
    let connection = zbus::Connection::session().await.ok()?;
    let scripting = zbus::Proxy::new(
        &connection,
        "org.kde.KWin",
        "/Scripting",
        "org.kde.kwin.Scripting",
    )
    .await
    .ok()?;
    let id = scripting
        .call::<_, _, i32>("loadScript", &path)
        .await
        .ok()?;
    let object_path = format!("/Scripting/Script{id}");
    let script = zbus::Proxy::new(
        &connection,
        "org.kde.KWin",
        object_path.as_str(),
        "org.kde.kwin.Script",
    )
    .await
    .ok()?;
    let _ = script.call::<_, _, ()>("run", &()).await;
    let _ = scripting.call::<_, _, bool>("unloadScript", &path).await;
    Some(())
}

#[cfg(target_os = "linux")]
fn write_activation_script(wm_class: &str) -> std::io::Result<PathBuf> {
    let sequence = KWIN_SCRIPT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "lavande-kwin-activation-{}-{sequence}.js",
        std::process::id()
    ));
    // La comparaison est insensible à la casse : mesuré, le .desktop dit
    // `brave-browser` alors que le `resourceClass` KWin réel est `Brave-browser`.
    let script = format!(
        "const cls = \"{}\";\n\
         const w = workspace.windowList().find(w => String(w.resourceClass).toLowerCase() === cls);\n\
         if (w) workspace.activeWindow = w;\n",
        wm_class.to_lowercase()
    );
    std::fs::write(&path, script)?;
    Ok(path)
}

#[cfg(target_os = "linux")]
fn default_browser_wm_class() -> Option<String> {
    let output = std::process::Command::new("xdg-settings")
        .args(["get", "default-web-browser"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let desktop_file = String::from_utf8(output.stdout).ok()?;
    let desktop_file = desktop_file.trim();
    if desktop_file.is_empty() {
        return None;
    }
    let fallback = desktop_file
        .strip_suffix(".desktop")
        .unwrap_or(desktop_file);
    let class = sanitize_wm_class(&wm_class_from_desktop(
        &desktop_file_contents(desktop_file),
        fallback,
    ));
    (!class.is_empty()).then_some(class)
}

#[cfg(target_os = "linux")]
fn desktop_file_contents(name: &str) -> String {
    let mut candidates = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(
            Path::new(&home)
                .join(".local/share/applications")
                .join(name),
        );
    }
    candidates.push(Path::new("/usr/share/applications").join(name));
    candidates
        .iter()
        .find_map(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn wm_class_from_desktop(contents: &str, fallback: &str) -> String {
    for line in contents.lines() {
        if let Some(value) = line.strip_prefix("StartupWMClass=") {
            let value = value.trim();
            if !value.is_empty() {
                return value.to_string();
            }
        }
    }
    fallback.to_string()
}

/// La classe finit dans un script JS entre guillemets : on ne garde que ce qui
/// est inoffensif et utile à une classe WM.
#[cfg(target_os = "linux")]
fn sanitize_wm_class(raw: &str) -> String {
    raw.chars()
        .filter(|caractere| {
            caractere.is_ascii_alphanumeric() || matches!(caractere, '.' | '_' | '-')
        })
        .collect()
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

    #[cfg(target_os = "linux")]
    use super::{sanitize_wm_class, wm_class_from_desktop};

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

    #[cfg(target_os = "linux")]
    #[test]
    fn lit_startup_wm_class() {
        let desktop = "[Desktop Entry]\nName=Brave\nStartupWMClass=brave-browser\n";
        assert_eq!(
            wm_class_from_desktop(desktop, "brave-browser"),
            "brave-browser"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn retombe_sur_le_nom_de_fichier_sans_startup_wm_class() {
        let desktop = "[Desktop Entry]\nName=Brave\nExec=brave-browser %U\n";
        assert_eq!(
            wm_class_from_desktop(desktop, "brave-browser"),
            "brave-browser"
        );
        assert_eq!(wm_class_from_desktop("", "firefox"), "firefox");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn ignore_une_valeur_vide() {
        assert_eq!(
            wm_class_from_desktop("StartupWMClass=\n", "firefox"),
            "firefox"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn nettoie_la_classe() {
        assert_eq!(sanitize_wm_class("brave-browser"), "brave-browser");
        assert_eq!(sanitize_wm_class("Google-chrome"), "Google-chrome");
        assert_eq!(
            sanitize_wm_class("libre.office_writer-1"),
            "libre.office_writer-1"
        );
        assert_eq!(sanitize_wm_class("Brave\" ; code\n"), "Bravecode");
        assert_eq!(sanitize_wm_class("  "), "");
        assert_eq!(sanitize_wm_class("éà"), "");
    }
}
