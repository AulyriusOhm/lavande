use tauri::Manager;

/// Boucle locale : la coquille Tauri embarque le routeur HTTP du démon mail.
const BIND: &str = "127.0.0.1:8790";

/// Le front lit le jeton du démon via cette commande : le démon et la coquille
/// partagent le même fichier `daemon-token` du répertoire de données.
#[tauri::command]
fn mail_daemon_token(app: tauri::AppHandle) -> Result<String, String> {
    let data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    lavande_mail_api::token::load_or_create(&data_dir).map_err(|error| error.to_string())
}

/// Même vérification que tauri-plugin-updater (minisign + version dans le trusted
/// comment) : l'updater ne couvre pas Android, l'app doit donc vérifier l'APK
/// elle-même avant de le confier à PackageInstaller.
fn verify_update_signature(
    data: &[u8],
    signature: &str,
    pubkey: &str,
    version: &str,
) -> Result<(), String> {
    use base64::Engine;
    let decode = |s: &str| -> Result<String, String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(s.trim())
            .map_err(|e| format!("base64 invalide : {e}"))?;
        String::from_utf8(bytes).map_err(|_| "signature/pubkey non UTF-8".to_string())
    };
    let pk = minisign_verify::PublicKey::decode(&decode(pubkey)?)
        .map_err(|e| format!("pubkey invalide : {e}"))?;
    let sig = minisign_verify::Signature::decode(&decode(signature)?)
        .map_err(|e| format!("signature invalide : {e}"))?;
    pk.verify(data, &sig, true)
        .map_err(|_| "signature de l'APK rejetée".to_string())?;
    let signed = sig
        .trusted_comment()
        .split('\t')
        .find_map(|f| f.strip_prefix("version:"));
    match signed {
        Some(v) if v.trim_start_matches('v') == version.trim_start_matches('v') => Ok(()),
        Some(v) => Err(format!(
            "version signée ({v}) différente de la version annoncée ({version})"
        )),
        None => Err("version signée absente de la signature".to_string()),
    }
}

#[tauri::command]
fn verify_android_update(
    app: tauri::AppHandle,
    path: String,
    signature: String,
    version: String,
) -> Result<(), String> {
    let pubkey = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .ok_or("pubkey updater absente de la configuration")?;
    let data =
        std::fs::read(&path).map_err(|e| format!("lecture de l'APK impossible : {e}"))?;
    verify_update_signature(&data, &signature, pubkey, &version)
}

#[tauri::command]
fn android_update_endpoint(app: tauri::AppHandle) -> Result<String, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("endpoints"))
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or("aucun endpoint updater configuré".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    // Plugin Kotlin local (téléchargement + PackageInstaller) : fourni par
    // scripts/patch-android.mjs dans le projet Android régénéré.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(
        tauri::plugin::Builder::<_, ()>::new("lavandeupdater")
            .setup(|_app, api| {
                api.register_android_plugin("mail.lavande.app", "LavandeUpdaterPlugin")?;
                Ok(())
            })
            .build(),
    );
    builder
        .invoke_handler(tauri::generate_handler![
            mail_daemon_token,
            verify_android_update,
            android_update_endpoint
        ])
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            tauri::async_runtime::spawn(async move {
                if let Err(error) = lavande_mail_api::serve(
                    BIND,
                    data_dir,
                    lavande_mail::tls::TlsOptions::default(),
                )
                .await
                {
                    eprintln!("lavande : API mail indisponible ({error})");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
