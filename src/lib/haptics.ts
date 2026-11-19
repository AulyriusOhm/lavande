import { isNativeShell } from "@/lib/native";

const MS = { light: 8, medium: 18, success: [12, 40, 12], error: [24, 60, 24] };
export type HapticPattern = keyof typeof MS;

let last = 0;

export function haptic(pattern: HapticPattern = "light") {
  if (!isNativeShell()) return;
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  const now = Date.now();
  if (now - last < 80) return; // collapse les boucles d'actions groupées en un seul tick
  last = now;
  try {
    navigator.vibrate(MS[pattern]);
  } catch {
    /* vibreur indisponible : silence */
  }
}
