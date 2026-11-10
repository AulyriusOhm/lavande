export function isNativeShell(): boolean {
  if (new URLSearchParams(window.location.search).has("app")) return true;
  return "__TAURI_INTERNALS__" in window && /Android/i.test(navigator.userAgent);
}
