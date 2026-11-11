/**
 * Quelle coquille afficher. La maquette mobile dans un navigateur reste la vue
 * par défaut (`?desktop` la force), mais une app packagée n'a pas d'URL à
 * paramétrer : la coquille Tauri de bureau doit ouvrir la vue PC, celle
 * d'Android la vue plein écran.
 */
export type ShellLayout = "desktop" | "native" | "stage";

type ShellSignals = {
  search: string;
  tauri: boolean;
  userAgent: string;
};

export function resolveShell({ search, tauri, userAgent }: ShellSignals): ShellLayout {
  const parameters = new URLSearchParams(search);
  if (parameters.has("desktop")) return "desktop";
  if (!tauri) return parameters.has("app") ? "native" : "stage";
  return /Android/i.test(userAgent) ? "native" : "desktop";
}

export function shellLayout(): ShellLayout {
  return resolveShell({
    search: window.location.search,
    tauri: "__TAURI_INTERNALS__" in window,
    userAgent: navigator.userAgent,
  });
}

export function isNativeShell(): boolean {
  return shellLayout() === "native";
}
