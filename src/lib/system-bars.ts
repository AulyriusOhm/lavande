/**
 * Barres système Android : le thème de l'app décide de l'apparence des icônes
 * système et du fond peint sous la WebView. Sans ce pont, elles suivaient le
 * mode nuit du téléphone, sans rapport avec le thème Lavande — icônes blanches
 * sur un haut d'écran clair, ou l'inverse.
 */
import { shellLayout } from "@/lib/native";

export async function applySystemBars(dark: boolean): Promise<void> {
  if (shellLayout() !== "native") return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("plugin:lavandeuibars|set_bars_appearance", { dark });
}
