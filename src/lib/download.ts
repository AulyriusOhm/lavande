import { readBase64 } from "@/lib/draft";
import { isNativeShell } from "@/lib/native";
import { isTauriShell } from "@/lib/open-external";

/**
 * Enregistre un fichier reçu du démon, et rend son chemin quand il y en a un.
 *
 * Ni la webview de bureau ni celle d'Android n'ont de gestionnaire de
 * téléchargement : une ancre `download` n'écrit rien (ou ailleurs). Dans les
 * coquilles Tauri les octets repartent donc vers une commande native, seule à
 * connaître le fichier écrit ; dans une page web ordinaire l'ancre reste le
 * seul chemin et aucun chemin n'est rendu.
 */
export async function saveBlob(blob: Blob, filename: string): Promise<string | null> {
  if (isTauriShell()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const dataBase64 = await readBase64(blob);
    if (isNativeShell()) {
      const { path } = await invoke<{ path: string }>(
        "plugin:lavandeattachments|open_attachment",
        { name: filename, mime: blob.type, dataBase64 },
      );
      return path;
    }
    return invoke<string>("save_attachment", { name: filename, dataBase64 });
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return null;
}
