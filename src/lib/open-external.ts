import { useEffect } from "react";

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

/**
 * Détourne les liens http(s) rendus dans le document de l'application vers le
 * navigateur du système : une ancre absolue ferait sinon naviguer la webview
 * elle-même, sans retour possible. Les ancres internes (`#…`), `mailto:`, `tel:`
 * et les liens relatifs de l'application restent au routeur.
 */
export function useExternalLinks(): void {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (typeof target?.closest !== "function") return;
      const anchor = target.closest("a[href]");
      if (!anchor || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href")?.trim();
      if (!href || !/^(https?:)?\/\//i.test(href)) return;
      let url: URL;
      try {
        url = new URL(href, document.baseURI);
      } catch {
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      event.preventDefault();
      openExternal(url.href);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
}
