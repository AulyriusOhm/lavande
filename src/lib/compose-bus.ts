import type { ComposeDraft } from "@/lib/draft";

export type ComposeState = {
  draft: ComposeDraft | null;
  title: string;
  detached: boolean;
};

export type ComposeMessage =
  | { kind: "state"; state: ComposeState }
  | { kind: "hello" }
  | { kind: "edit"; draft: ComposeDraft }
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

export function loadPersistedCompose(): { draft: ComposeDraft; title: string } | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { draft, title } = parsed as { draft?: unknown; title?: unknown };
    if (!isDraft(draft)) return null;
    return { draft, title: typeof title === "string" ? title : "Nouveau message" };
  } catch {
    return null;
  }
}

export function persistCompose(draft: ComposeDraft | null, title: string): void {
  try {
    if (draft) window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ draft, title }));
    else window.localStorage.removeItem(STORAGE_KEY);
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
