//! Écriture atomique de fichiers privés (0600) : temporaire puis renommage.

use std::fs;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::process;

use crate::error::ApiError;

/// `0o600` sur Unix ; sous Windows le fichier hérite des ACL du répertoire
/// parent, faute de durcissement explicite (chantier séparé).
fn open_private(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
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
    let temporary = path.with_file_name(format!("{name}.{}.tmp", process::id()));

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
