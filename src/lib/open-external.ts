/**
 * Ouvre une adresse hors de l'application.
 *
 * Dans la coquille Tauri, `window.open` ne fait rien : il faut passer par le
 * plugin `opener`, qui remet l'URL au navigateur du système (ou au navigateur
 * par défaut d'Android). Dans une page web ordinaire on garde `window.open`.
 */
export function isTauriShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function openExternal(url: string): void {
  if (isTauriShell()) {
    void import("@tauri-apps/plugin-opener")
      .then((plugin) => plugin.openUrl(url))
      .catch((error: unknown) => console.error("ouverture externe impossible", error));
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
