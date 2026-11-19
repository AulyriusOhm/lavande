use base64::Engine;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Même plafond que la composition : le démon et le webview échangent les
/// octets en base64, donc en mémoire à la fois encodés et décodés.
const MAX_BYTES: usize = 25 * 1024 * 1024;

/// Le base64 porte 4 caractères pour 3 octets : plafonner la chaîne évite de
/// décoder 100 Mo avant de savoir qu'on les refuse.
const MAX_BASE64_LEN: usize = MAX_BYTES / 3 * 4 + 4;

const FALLBACK_NAME: &str = "piece-jointe";

fn clean_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | ' ' | '(' | ')' => c,
            _ => '_',
        })
        .collect();
    let trimmed = cleaned.trim();
    let base = Path::new(trimmed).file_name().and_then(|n| n.to_str());
    match base {
        Some(name) if name.trim_matches('.').is_empty() => FALLBACK_NAME.to_string(),
        Some(name) => name.to_string(),
        None => FALLBACK_NAME.to_string(),
    }
}

fn free_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(FALLBACK_NAME);
    let extension = path.extension().and_then(|s| s.to_str());
    for index in 1.. {
        let next = match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let candidate = dir.join(next);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("un nom libre existe toujours")
}

/// Écrit une pièce jointe dans le dossier de téléchargements du poste.
///
/// La webview Tauri n'a pas de gestionnaire de téléchargement : une ancre
/// `download` n'écrit nulle part. Le front envoie donc les octets ici et
/// reçoit le chemin réel du fichier, seul moyen de l'annoncer puis de l'ouvrir.
#[tauri::command]
pub fn save_attachment(
    app: tauri::AppHandle,
    name: String,
    data_base64: String,
) -> Result<String, String> {
    if data_base64.len() > MAX_BASE64_LEN {
        return Err("pièce jointe trop lourde : 25 Mo maximum".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|error| format!("octets de la pièce jointe illisibles : {error}"))?;
    if bytes.len() > MAX_BYTES {
        return Err("pièce jointe trop lourde : 25 Mo maximum".to_string());
    }
    let dir = app
        .path()
        .download_dir()
        .map_err(|error| format!("dossier de téléchargements introuvable : {error}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("dossier de téléchargements inutilisable : {error}"))?;
    let path = free_path(&dir, &clean_name(&name));
    std::fs::write(&path, bytes).map_err(|error| format!("enregistrement impossible : {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::{clean_name, free_path, FALLBACK_NAME};
    use std::fs;

    #[test]
    fn garde_les_caracteres_surs() {
        assert_eq!(clean_name("facture mars (1).pdf"), "facture mars (1).pdf");
    }

    #[test]
    fn remplace_le_reste_et_desamorce_les_chemins() {
        assert_eq!(clean_name("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(clean_name("a/b:c*d?.pdf"), "a_b_c_d_.pdf");
        assert_eq!(clean_name("\u{e9}t\u{e9}.pdf"), "_t_.pdf");
    }

    #[test]
    fn retombe_sur_un_nom_par_defaut() {
        assert_eq!(clean_name(""), FALLBACK_NAME);
        assert_eq!(clean_name(".."), FALLBACK_NAME);
        assert_eq!(clean_name("   "), FALLBACK_NAME);
    }

    #[test]
    fn n_ecrase_jamais_un_fichier_existant() {
        let dir = std::env::temp_dir().join(format!("lavande-pj-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let first = free_path(&dir, "note.txt");
        fs::write(&first, b"a").unwrap();
        let second = free_path(&dir, "note.txt");
        fs::write(&second, b"b").unwrap();
        let third = free_path(&dir, "note.txt");
        assert_eq!(first.file_name().unwrap(), "note.txt");
        assert_eq!(second.file_name().unwrap(), "note (1).txt");
        assert_eq!(third.file_name().unwrap(), "note (2).txt");
        let sans_extension = free_path(&dir, "lisezmoi");
        fs::write(&sans_extension, b"c").unwrap();
        assert_eq!(
            free_path(&dir, "lisezmoi").file_name().unwrap(),
            "lisezmoi (1)"
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
