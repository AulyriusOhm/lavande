use tauri::Manager;

pub mod attachment;
pub mod open_external;

#[cfg(target_os = "android")]
pub mod sync_bridge;

/// Poignées des plugins Kotlin. Une commande Kotlin n'est joignable depuis le
/// JS que par une commande Rust qui la relaie : `PluginManager.runCommand`
/// n'est appelé que par `run_mobile_plugin`. C'est ce relais qui porte aussi la
/// permission ACL (`build.rs`).
#[cfg(target_os = "android")]
struct UpdaterPluginHandle(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
struct SyncPluginHandle(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
struct AttachmentsPluginHandle(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
struct UiBarsPluginHandle(tauri::plugin::PluginHandle<tauri::Wry>);

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

#[tauri::command]
fn update_host() -> serde_json::Value {
    serde_json::json!({
        "immutable": std::path::Path::new("/run/ostree-booted").exists(),
        "bundle": tauri::utils::platform::bundle_type().map(|b| format!("{b:?}").to_lowercase()),
    })
}

/// Relais des commandes du plugin Kotlin `LavandeUpdaterPlugin`.
#[cfg(target_os = "android")]
mod android_commands {
    use super::{AttachmentsPluginHandle, SyncPluginHandle, UiBarsPluginHandle, UpdaterPluginHandle};
    use serde_json::Value;
    use tauri::State;

    async fn forward(
        handle: &tauri::plugin::PluginHandle<tauri::Wry>,
        command: &str,
        payload: Value,
    ) -> Result<Value, String> {
        handle
            .run_mobile_plugin_async(command, payload)
            .await
            .map_err(|error| error.to_string())
    }

    #[tauri::command]
    pub async fn download_apk(
        updater: State<'_, UpdaterPluginHandle>,
        url: String,
    ) -> Result<Value, String> {
        forward(&updater.0, "downloadApk", serde_json::json!({ "url": url })).await
    }

    #[tauri::command]
    pub async fn can_install(updater: State<'_, UpdaterPluginHandle>) -> Result<Value, String> {
        forward(&updater.0, "canInstall", Value::Null).await
    }

    #[tauri::command]
    pub async fn open_install_settings(
        updater: State<'_, UpdaterPluginHandle>,
    ) -> Result<Value, String> {
        forward(&updater.0, "openInstallSettings", Value::Null).await
    }

    #[tauri::command]
    pub async fn install_apk(
        updater: State<'_, UpdaterPluginHandle>,
        path: String,
    ) -> Result<Value, String> {
        forward(&updater.0, "installApk", serde_json::json!({ "path": path })).await
    }

    #[tauri::command]
    pub async fn set_background_sync(
        sync: State<'_, SyncPluginHandle>,
        enabled: bool,
    ) -> Result<Value, String> {
        forward(&sync.0, "setBackgroundSync", serde_json::json!({ "enabled": enabled })).await
    }

    #[tauri::command]
    pub async fn background_sync_state(
        sync: State<'_, SyncPluginHandle>,
    ) -> Result<Value, String> {
        forward(&sync.0, "backgroundSyncState", Value::Null).await
    }

    #[tauri::command]
    pub async fn set_muted_accounts(
        sync: State<'_, SyncPluginHandle>,
        ids: Vec<String>,
    ) -> Result<Value, String> {
        forward(&sync.0, "setMutedAccounts", serde_json::json!({ "ids": ids })).await
    }

    #[tauri::command]
    pub async fn set_widget_agenda_summary(
        sync: State<'_, SyncPluginHandle>,
        events: Vec<lavande_mail_api::widget_agenda::WidgetEvent>,
        now: i64,
        day_start: i64,
        day_end: i64,
    ) -> Result<Value, String> {
        let summary =
            lavande_mail_api::widget_agenda::summarize_agenda(&events, now, day_start, day_end);
        let json = serde_json::to_string(&summary).map_err(|error| error.to_string())?;
        forward(&sync.0, "setWidgetAgendaSummary", serde_json::json!({ "summary": json })).await
    }

    #[tauri::command]
    pub async fn sync_now(sync: State<'_, SyncPluginHandle>) -> Result<Value, String> {
        forward(&sync.0, "syncNow", Value::Null).await
    }

    #[tauri::command]
    pub async fn set_bars_appearance(
        bars: State<'_, UiBarsPluginHandle>,
        dark: bool,
    ) -> Result<Value, String> {
        forward(&bars.0, "setBarsAppearance", serde_json::json!({ "dark": dark })).await
    }

    #[tauri::command]
    pub async fn open_attachment(
        attachments: State<'_, AttachmentsPluginHandle>,
        name: String,
        mime: String,
        data_base64: String,
    ) -> Result<Value, String> {
        forward(
            &attachments.0,
            "openAttachment",
            serde_json::json!({ "name": name, "mime": mime, "dataBase64": data_base64 }),
        )
        .await
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    // Plugins Kotlin locaux (fournis par scripts/patch-android.mjs) + leurs
    // relais Rust : sans `invoke_handler`, un invoke JS sur le plugin n'a
    // aucune commande à qui répondre.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(
        tauri::plugin::Builder::<_, ()>::new("lavandeupdater")
            .setup(|app, api| {
                let handle =
                    api.register_android_plugin("mail.lavande.app", "LavandeUpdaterPlugin")?;
                app.manage(UpdaterPluginHandle(handle));
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                android_commands::download_apk,
                android_commands::can_install,
                android_commands::open_install_settings,
                android_commands::install_apk
            ])
            .build(),
    );
    #[cfg(target_os = "android")]
    let builder = builder.plugin(
        tauri::plugin::Builder::<_, ()>::new("lavandebgsync")
            .setup(|app, api| {
                let handle =
                    api.register_android_plugin("mail.lavande.app", "BackgroundSyncPlugin")?;
                app.manage(SyncPluginHandle(handle));
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                android_commands::set_background_sync,
                android_commands::background_sync_state,
                android_commands::set_muted_accounts,
                android_commands::set_widget_agenda_summary,
                android_commands::sync_now
            ])
            .build(),
    );
    #[cfg(target_os = "android")]
    let builder = builder.plugin(
        tauri::plugin::Builder::<_, ()>::new("lavandeattachments")
            .setup(|app, api| {
                let handle =
                    api.register_android_plugin("mail.lavande.app", "LavandeAttachmentsPlugin")?;
                app.manage(AttachmentsPluginHandle(handle));
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                android_commands::open_attachment
            ])
            .build(),
    );
    #[cfg(target_os = "android")]
    let builder = builder.plugin(
        tauri::plugin::Builder::<_, ()>::new("lavandeuibars")
            .setup(|app, api| {
                let handle = api.register_android_plugin("mail.lavande.app", "LavandeUiBarsPlugin")?;
                app.manage(UiBarsPluginHandle(handle));
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                android_commands::set_bars_appearance
            ])
            .build(),
    );
    builder
        .invoke_handler(tauri::generate_handler![
            open_external::open_external,
            attachment::save_attachment,
            mail_daemon_token,
            verify_android_update,
            android_update_endpoint,
            update_host
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
