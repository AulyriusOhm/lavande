use tauri::Manager;

/// Boucle locale : la coquille Tauri embarque le routeur HTTP du démon mail.
const BIND: &str = "127.0.0.1:8790";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
