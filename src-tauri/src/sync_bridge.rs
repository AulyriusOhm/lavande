//! Pont JNI du widget Android : `LavandeSyncWorker` (WorkManager) appelle
//! `BackgroundSyncLib.syncNow` depuis un processus sans activité ni WebView.
//! Le worker ouvre donc sa propre instance du démon — même base SQLite que
//! l'app, connexions distinctes — et rend le résumé en JSON ; le filtrage des
//! comptes muets et le rendu se font côté Kotlin.

use std::path::PathBuf;
use std::sync::Arc;

use jni::objects::{JObject, JString};
use jni::sys::jstring;
use jni::JNIEnv;

use lavande_mail::tls::TlsOptions;
use lavande_mail_api::state::AppState;
use lavande_mail_api::widget;

/// Le widget ne rend que le premier mail (`LavandeWidgetProvider`), les autres
/// servent aux notifications par mail de `LavandeSyncWorker`.
const MAIL_LIMIT: usize = 10;

fn error_json(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}

/// Entrée JNI de `BackgroundSyncLib.syncNow` : rend `{"summary":…}` ou
/// `{"error":…}`. Aucune panique ni exception ne traverse la frontière FFI.
///
/// `BackgroundSyncLib` est un `object` Kotlin : `external fun` y est une méthode
/// d'instance, le second argument JNI est donc l'instance du singleton (un
/// `jobject`), jamais un `jclass`. Une déclaration `JClass` compilerait mais
/// mentirait sur le type reçu.
#[no_mangle]
pub extern "system" fn Java_mail_lavande_app_BackgroundSyncLib_syncNow<'local>(
    mut env: JNIEnv<'local>,
    _this: JObject<'local>,
    data_dir: JString<'local>,
) -> jstring {
    let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        sync_payload(&mut env, &data_dir)
    }))
    .unwrap_or_else(|_| error_json("synchro de fond interrompue par une panique"));
    match env.new_string(payload) {
        Ok(text) => text.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

fn sync_payload(env: &mut JNIEnv, data_dir: &JString) -> String {
    let directory = match env.get_string(data_dir) {
        Ok(text) => PathBuf::from(String::from(text)),
        Err(error) => return error_json(&format!("chemin de données illisible : {error}")),
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => return error_json(&format!("runtime tokio indisponible : {error}")),
    };
    runtime.block_on(async move {
        let state = match AppState::open(&directory, TlsOptions::default()).await {
            Ok(state) => Arc::new(state),
            Err(error) => {
                return error_json(&format!(
                    "ouverture de {} : {}",
                    directory.display(),
                    error.message()
                ))
            }
        };
        let (summary, errors) = widget::sync_and_summarize(&state, MAIL_LIMIT).await;
        // Tous les comptes en échec = serveur injoignable : le worker réessaie
        // une fois et le widget garde le dernier résumé stocké.
        if !errors.is_empty() && errors.len() >= summary.accounts.len() {
            return error_json(&errors.join(" ; "));
        }
        match serde_json::to_value(&summary) {
            Ok(summary) => serde_json::json!({ "summary": summary }).to_string(),
            Err(error) => error_json(&format!("résumé non sérialisable : {error}")),
        }
    })
}
