/**
 * Enregistre un fichier reçu du démon.
 *
 * L'ancre `download` sur une URL `blob:` est le seul chemin qui marche partout :
 * le navigateur ouvre son gestionnaire de téléchargement, et le webview des
 * coquilles Tauri (wry) laisse passer les téléchargements par défaut, comme un
 * navigateur. Les octets ont déjà été récupérés avec le jeton du démon : l'URL
 * ne porte donc aucun secret.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
