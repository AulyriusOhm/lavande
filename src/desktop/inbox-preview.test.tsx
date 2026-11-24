import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { DesktopInbox } from "@/desktop/inbox";
import type { ApiAccount, ApiFolder, ApiMailDecision, ApiMessage, ApiThread } from "@/lib/api";
import { DEFAULT_DECISION, NEURALWATT_ENDPOINT, type MailDecision } from "@/lib/decision";
import { decisionDb } from "@/lib/decision-db";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider } from "@/lib/store";
import { createMemoryStorage } from "@/lib/sync/storage";
import { ThemeProvider } from "@/lib/theme";

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (media: string) => ({
      media,
      matches: false,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const ACCOUNT = "perso";
const INBOX = "INBOX";

const response = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    statusText: "",
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function mount(children: ReactNode) {
  return render(
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>{children}</MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>,
  );
}

const apiAccount: ApiAccount = {
  id: ACCOUNT,
  label: "Perso",
  email: "roman@test.fr",
  username: "roman@test.fr",
  imap: { host: "imap.test", port: 993, encryption: "tls" },
  smtp: { host: "smtp.test", port: 465, encryption: "tls" },
  folders: 1,
};

const apiFolders: ApiFolder[] = [
  {
    account_id: ACCOUNT,
    path: INBOX,
    name: INBOX,
    role: "inbox",
    uidvalidity: 1,
    uidnext: 10,
    last_sync_at: null,
  },
];

const NOW = Date.now();

function makeApiThread(uid: number, from: string, subject: string): ApiThread {
  const msg: ApiMessage = {
    account_id: ACCOUNT,
    folder_path: INBOX,
    uid,
    uidvalidity: 1,
    thread_id: `t-${uid}`,
    message_id: `<m${uid}@test.fr>`,
    in_reply_to: null,
    references: [],
    from: { name: from, email: `${from.toLowerCase()}@test.fr` },
    to: [{ name: null, email: "roman@test.fr" }],
    cc: [],
    subject,
    date: new Date(NOW - uid * 60_000).toISOString(),
    flags: { unread: true, starred: false, answered: false },
    size: 512,
    pgp: "none",
    preview: `Aperçu ${subject}`,
    body_text: `Corps ${uid}`,
    body_html: null,
    attachments: [],
  };
  return {
    id: msg.thread_id,
    account_id: ACCOUNT,
    messages: [msg],
    primary: msg,
    count: 1,
    unread: 1,
    starred: false,
    encrypted: 0,
    attachments: 0,
    participants: [msg.from.email],
    subject,
    preview: msg.preview,
  };
}

function makeDecision(uid: number, overrides: Partial<MailDecision> = {}): MailDecision {
  return {
    accountId: ACCOUNT,
    folderPath: INBOX,
    uid,
    messageId: `<m${uid}@test.fr>`,
    contentHash: `h-${uid}`,
    schemaVersion: 1,
    model: "mammoth-1",
    category: "important",
    categoryConf: 0.92,
    categoryProbs: { important: 0.92 },
    urgency: 1.0,
    needsReply: 0.2,
    hasTask: 0.1,
    hasEvent: 0.0,
    security: "safe",
    securityConf: 0.99,
    cleanupScore: 0.05,
    decidedAt: NOW,
    source: "synced",
    ...overrides,
  };
}

function makeApiDecision(uid: number, overrides: Partial<ApiMailDecision> = {}): ApiMailDecision {
  return {
    account_id: ACCOUNT,
    folder_path: INBOX,
    uid,
    message_id: `<m${uid}@test.fr>`,
    content_hash: `h-${uid}`,
    schema_version: 1,
    model: "mammoth-1",
    category: "important",
    category_conf: 0.92,
    category_probs: { important: 0.92 },
    urgency: 1.0,
    needs_reply: 0.2,
    has_task: 0.1,
    has_event: 0.0,
    security: "safe",
    security_conf: 0.99,
    cleanup_score: 0.05,
    decided_at: Math.floor(NOW / 1000),
    source: "local",
    ...overrides,
  };
}

const rowCardText = (threadId: string) =>
  document.querySelector<HTMLElement>(`[data-mail-row="${threadId}"]`)?.parentElement?.textContent ?? "";

const threads = [
  makeApiThread(1, "Camille", "Maquettes mobiles"),
  makeApiThread(2, "GitHub", "Code 482917"),
  makeApiThread(3, "Banque", "Compte bloqué"),
];

function stubBackend(options: { triage?: () => Promise<Response> } = {}) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(url.pathname);
    if (path.endsWith("/pgp/keys")) return response({ keys: [] });
    if (path.endsWith("/folder-counts")) return response([]);
    if (path === "/api/accounts") return response([apiAccount]);
    if (path === `/api/accounts/${ACCOUNT}/folders`) return response(apiFolders);
    if (path.startsWith(`/api/accounts/${ACCOUNT}/folders/${INBOX}/threads`)) return response(threads);
    if (path.startsWith(`/api/accounts/${ACCOUNT}/threads/`)) {
      const tid = path.split("/").pop();
      return response(threads.find((entry) => entry.id === tid) ?? threads[0]);
    }
    if (path.endsWith("/api/ai/decisions/triage")) {
      if (options.triage) return options.triage();
      const body = JSON.parse(String(init?.body ?? "{}")) as { targets?: { uid: number }[] };
      return response({
        results: (body.targets ?? []).map((target) => ({
          decision: makeApiDecision(target.uid),
          cached: false,
        })),
        errors: [],
      });
    }
    return response([]);
  });
}

async function seed(mails: { uid: number; decision: MailDecision }[]) {
  await decisionDb().putDecisions(mails.map((entry) => entry.decision));
}

beforeEach(async () => {
  window.innerWidth = 1600;
  window.localStorage.clear();
  await decisionDb().clearDecisions();
  await decisionDb().clearLlmExtractions();
  vi.stubGlobal("EventSource", undefined);
  Element.prototype.scrollTo = () => {};
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Boîte PC · troisième ligne de la liste", () => {
  it("affiche la description du modèle en mode IA (signaux)", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ mailPreview: "ai" }));
    await seed([
      { uid: 1, decision: makeDecision(1, { urgency: 2.2, needsReply: 0.9, hasTask: 0.8 }) },
      { uid: 2, decision: makeDecision(2, { category: "auth_totp", totpCode: "482917", totpService: "GitHub" }) },
      { uid: 3, decision: makeDecision(3, { security: "phishing", securityConf: 0.97 }) },
    ]);
    stubBackend();

    mount(<DesktopInbox onOpenSearch={() => {}} />);
    await waitFor(() => expect(document.querySelector(`[data-mail-row="${ACCOUNT}:t-1"]`)).toBeTruthy());

    expect(rowCardText(`${ACCOUNT}:t-1`)).toContain("Urgent · Réponse attendue · Tâche détectée");
    expect(rowCardText(`${ACCOUNT}:t-1`)).not.toContain("Aperçu Maquettes mobiles");
    expect(rowCardText(`${ACCOUNT}:t-2`)).toContain("Code GitHub : 482917");
    expect(rowCardText(`${ACCOUNT}:t-3`)).toContain("Hameçonnage détecté");
  });

  it("préfère la phrase du modèle en style Phrase et retombe sur les signaux sans phrase", async () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ mailPreview: "ai", mailPreviewStyle: "phrase" }),
    );
    await seed([
      {
        uid: 1,
        decision: makeDecision(1, {
          needsReply: 0.9,
          description: "Avenant signé : confirmer le lancement de la phase 2 lundi.",
        }),
      },
      { uid: 2, decision: makeDecision(2, { category: "info" }) },
      { uid: 3, decision: makeDecision(3, { category: "promo" }) },
    ]);
    stubBackend();

    mount(<DesktopInbox onOpenSearch={() => {}} />);
    await waitFor(() => expect(document.querySelector(`[data-mail-row="${ACCOUNT}:t-1"]`)).toBeTruthy());

    expect(rowCardText(`${ACCOUNT}:t-1`)).toContain(
      "Avenant signé : confirmer le lancement de la phase 2 lundi.",
    );
    expect(rowCardText(`${ACCOUNT}:t-2`)).toContain("Information");
    expect(rowCardText(`${ACCOUNT}:t-3`)).toContain("Publicité / offre");
  });

  it("affiche l'extrait en mode Extrait et rien en mode Aucun", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ mailPreview: "excerpt" }));
    await seed([
      { uid: 1, decision: makeDecision(1, { urgency: 2.2 }) },
      { uid: 2, decision: makeDecision(2) },
      { uid: 3, decision: makeDecision(3) },
    ]);
    stubBackend();

    const first = mount(<DesktopInbox onOpenSearch={() => {}} />);
    await waitFor(() => expect(document.querySelector(`[data-mail-row="${ACCOUNT}:t-1"]`)).toBeTruthy());
    expect(rowCardText(`${ACCOUNT}:t-1`)).toContain("Aperçu Maquettes mobiles");
    expect(rowCardText(`${ACCOUNT}:t-1`)).not.toContain("Réponse attendue");
    first.unmount();

    window.localStorage.setItem("lavande.prefs", JSON.stringify({ mailPreview: "none" }));
    mount(<DesktopInbox onOpenSearch={() => {}} />);
    await waitFor(() => expect(document.querySelector(`[data-mail-row="${ACCOUNT}:t-1"]`)).toBeTruthy());
    expect(rowCardText(`${ACCOUNT}:t-1`)).not.toContain("Aperçu Maquettes mobiles");
    expect(rowCardText(`${ACCOUNT}:t-1`)).not.toContain("Réponse attendue");
  });

  it("annonce l'analyse en cours pour un mail envoyé au modèle sans décision", async () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({
        mailPreview: "ai",
        decision: { ...DEFAULT_DECISION, enabled: true, endpoint: NEURALWATT_ENDPOINT, model: "mammoth-1", apiKey: "nw" },
      }),
    );
    await seed([
      { uid: 1, decision: makeDecision(1) },
      { uid: 3, decision: makeDecision(3) },
    ]);
    stubBackend({ triage: () => new Promise<Response>(() => {}) });

    mount(<DesktopInbox onOpenSearch={() => {}} />);
    await waitFor(() => expect(screen.getByText("Analyse en cours…")).toBeTruthy());
    expect(rowCardText(`${ACCOUNT}:t-2`)).toContain("Analyse en cours…");
    expect(rowCardText(`${ACCOUNT}:t-1`)).not.toContain("Analyse en cours…");
  });

  it("retombe sur l'extrait quand aucun modèle n'est configuré", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ mailPreview: "ai" }));
    stubBackend();

    mount(<DesktopInbox onOpenSearch={() => {}} />);
    await waitFor(() => expect(document.querySelector(`[data-mail-row="${ACCOUNT}:t-1"]`)).toBeTruthy());

    expect(rowCardText(`${ACCOUNT}:t-1`)).toContain("Aperçu Maquettes mobiles");
  });
});
