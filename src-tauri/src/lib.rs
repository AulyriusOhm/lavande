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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![mail_daemon_token])
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
