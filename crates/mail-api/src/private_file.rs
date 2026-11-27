//! Écriture atomique de fichiers privés (0600) : temporaire puis renommage.

use std::fs;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::ApiError;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// `0o600` sur Unix ; sous Windows le fichier hérite des ACL du répertoire
/// parent, faute de durcissement explicite (chantier séparé).
fn open_private(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options.open(path)?;
    #[cfg(unix)]
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), ApiError> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("prive");
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = path.with_file_name(format!("{name}.{}.{sequence}.tmp", process::id()));

    let written = (|| -> std::io::Result<()> {
        let mut file = open_private(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(ApiError::internal(
            "config",
            format!("écriture de {} : {error}", temporary.display()),
        ));
    }

    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        ApiError::internal(
            "config",
            format!("installation de {} : {error}", path.display()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::write_private;
    use std::thread;

    #[test]
    fn concurrent_writes_never_collide_on_temp_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("state.json");
        let handles: Vec<_> = (0..16)
            .map(|index| {
                let target = target.clone();
                thread::spawn(move || {
                    for step in 0..10 {
                        let payload = format!("{{\"worker\":{index},\"step\":{step}}}");
                        write_private(&target, payload.as_bytes()).expect("écriture");
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("thread");
        }
        let final_content = std::fs::read_to_string(&target).expect("lecture");
        let parsed: serde_json::Value = serde_json::from_str(&final_content).expect("JSON valide");
        assert!(parsed.get("worker").is_some());
    }
}
