import type { ComposeDraft } from "@/lib/draft";
import type { MailSource } from "@/lib/mail";

export type ComposeState = {
  draft: ComposeDraft | null;
  title: string;
  detached: boolean;
  /**
   * Brouillon serveur repris : supprimé seulement une fois la reprise
   * enregistrée ou envoyée, pour qu'un abandon laisse l'original en place.
   */
  draftSource?: MailSource | null;
};

export type ComposeMessage =
  | { kind: "state"; state: ComposeState }
  | { kind: "hello" }
  /** `title` suit une réorientation de brouillon (« Répondre à tous »). */
  | { kind: "edit"; draft: ComposeDraft; title?: string }
  | { kind: "send"; draft: ComposeDraft }
  | { kind: "sent" }
  | { kind: "send-failed"; message: string }
  | { kind: "focus" }
  | { kind: "closed" }
  | { kind: "dock" };

export type ComposeBus = {
  post: (message: ComposeMessage) => void;
  close: () => void;
};

const STORAGE_KEY = "lavande.compose.v1";
const CHANNEL = "lavande-compose";

export function isComposeWindow(): boolean {
  return typeof window !== "undefined" && window.location.hash === "#compose";
}

export function composeWindowUrl(): string {
  return `${window.location.origin}${window.location.pathname}?desktop#compose`;
}

function isDraft(value: unknown): value is ComposeDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Record<string, unknown>;
  return ["to", "cc", "cci", "subject", "body", "account"].every(
    (field) => typeof draft[field] === "string",
  );
}

/** Un stockage d'avant le suivi de reprise reste valide : la source est optionnelle. */
function isSource(value: unknown): value is MailSource {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.accountId === "string" &&
    typeof source.folderPath === "string" &&
    typeof source.uid === "number"
  );
}

export function loadPersistedCompose(): {
  draft: ComposeDraft;
  title: string;
  draftSource?: MailSource;
} | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { draft, title, draftSource } = parsed as {
      draft?: unknown;
      title?: unknown;
      draftSource?: unknown;
    };
    if (!isDraft(draft)) return null;
    const loaded = { draft, title: typeof title === "string" ? title : "Nouveau message" };
    return isSource(draftSource) ? { ...loaded, draftSource } : loaded;
  } catch {
    return null;
  }
}

export function persistCompose(
  draft: ComposeDraft | null,
  title: string,
  draftSource?: MailSource | null,
): void {
  try {
    if (draft) {
      const entry = draftSource ? { draft, title, draftSource } : { draft, title };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // stockage indisponible (navigation privée) : le brouillon reste en mémoire
  }
}

export function openComposeBus(onMessage: (message: ComposeMessage) => void): ComposeBus | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<ComposeMessage>) => onMessage(event.data);
  return {
    post: (message) => channel.postMessage(message),
    close: () => channel.close(),
  };
}
