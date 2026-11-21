import {
  Importance,
  createChannel,
  isPermissionGranted,
  requestPermission,
  sendNotification,
  channels,
} from "@tauri-apps/plugin-notification";
import { isNativeShell } from "@/lib/native";
import { isTauriShell } from "@/lib/open-external";

const BASE_TITLE = "Lavande";

type NotifyKind = "mail" | "calendar" | "totp";

const CHANNELS: Record<NotifyKind, { id: string; name: string; description: string }> = {
  mail: {
    id: "mails",
    name: "Nouveaux mails",
    description: "Un message arrive dans la boîte de réception d'un compte",
  },
  calendar: {
    id: "calendrier",
    name: "Rappels d'agenda",
    description: "Un rendez-vous du calendrier commence bientôt",
  },
  totp: {
    id: "totp",
    name: "Codes de vérification",
    description: "Un code de vérification ou 2FA vient d'arriver",
  },
};

let ready: Promise<boolean> | null = null;

// Sans identifiant, le système réutilise la même notification et un second mail
// écrase le premier : un compteur neuf par envoi les empile.
let sequence = 0;

function nextId(): number {
  sequence = (sequence + 1) % 1_000_000;
  return sequence;
}

async function prepare(): Promise<boolean> {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (!granted) return false;
  if (!isNativeShell()) return true;
  const known = new Set((await channels()).map((channel) => channel.id));
  for (const channel of Object.values(CHANNELS)) {
    if (known.has(channel.id)) continue;
    await createChannel({ ...channel, importance: Importance.High });
  }
  return true;
}

/** Demande la permission au moment d'un geste utilisateur et prépare les canaux Android. */
export function requestNotifications(): Promise<boolean> {
  if (!isTauriShell()) return Promise.resolve(false);
  ready = prepare().catch(() => false);
  return ready;
}

async function allowed(): Promise<boolean> {
  if (ready) return ready;
  ready = prepare().catch(() => false);
  return ready;
}

async function notify(kind: NotifyKind, title: string, body: string): Promise<void> {
  if (!isTauriShell() || document.hasFocus()) return;
  try {
    if (!(await allowed())) return;
    const id = nextId();
    sendNotification(
      isNativeShell() ? { id, title, body, channelId: CHANNELS[kind].id } : { id, title, body },
    );
  } catch {
    // notifications indisponibles : silencieux
  }
}

export async function notifyNewMail(sender: string, subject: string): Promise<void> {
  await notify("mail", sender || "Nouveau message", subject);
}

export function notifyCalendarEvent(title: string, startsAt: string): void {
  void notify("calendar", title || "Rendez-vous", startsAt);
}

export async function notifyTotpCode(service: string, code: string): Promise<void> {
  const target = service.trim() || "de vérification";
  await notify("totp", `Code ${target} : ${code}`, "Code de vérification détecté");
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
