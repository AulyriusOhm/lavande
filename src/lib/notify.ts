import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { isTauriShell } from "@/lib/open-external";

const BASE_TITLE = "Lavande";

export async function notifyNewMail(sender: string, subject: string): Promise<void> {
  if (!isTauriShell() || document.hasFocus()) return;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) {
      sendNotification({ title: sender || "Nouveau message", body: subject || "" });
    }
  } catch {
    // notifications indisponibles : silencieux
  }
}

export function setUnreadBadge(count: number): void {
  const title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
  document.title = title;
  if (isTauriShell()) {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
      .catch(() => {});
  }
}