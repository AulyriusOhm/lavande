import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopInbox } from "@/desktop/inbox";
import type { ApiAccount, ApiFolder, ApiMessage, ApiThread } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider } from "@/lib/store";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import { isoToday } from "@/lib/tasks";

vi.stubEnv("VITE_MAIL_BACKEND", "api");

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
const THREAD = "t1";
const MAIL_ID = `${ACCOUNT}:${THREAD}`;
const LLM = { endpoint: "https://llm.test/v1", apiKey: "sk-test", model: "modele" };
const DUE = isoToday(3);

const apiAccount: ApiAccount = {
  id: ACCOUNT,
  label: "Perso",
  email: "roman@test.fr",
  username: "roman@test.fr",
  imap: { host: "imap.test", port: 993, encryption: "tls" },
  smtp: { host: "smtp.test", port: 465, encryption: "tls" },
  folders: 1,
};

const apiFolder: ApiFolder = {
  account_id: ACCOUNT,
  path: INBOX,
  name: INBOX,
  role: "inbox",
  uidvalidity: 1,
  uidnext: 3,
  last_sync_at: null,
};

const apiMessage: ApiMessage = {
  account_id: ACCOUNT,
  folder_path: INBOX,
  uid: 1,
  uidvalidity: 1,
  thread_id: THREAD,
  message_id: "<m1@test.fr>",
  in_reply_to: null,
  references: [],
  from: { name: "Camille", email: "camille@test.fr" },
  to: [{ name: null, email: "roman@test.fr" }],
  cc: [],
  subject: "Planning",
  date: "2026-01-05T10:00:00Z",
  flags: { unread: false, starred: false, answered: false },
  size: 512,
  pgp: "none",
  preview: "Aperçu",
  body_text: "Peux-tu envoyer le compte rendu de la réunion ?",
  body_html: null,
  attachments: [],
};

const apiThread: ApiThread = {
  id: THREAD,
  account_id: ACCOUNT,
  messages: [apiMessage],
  primary: apiMessage,
  count: 1,
  unread: 0,
  starred: false,
  encrypted: 0,
  attachments: 0,
  participants: ["camille@test.fr"],
  subject: apiMessage.subject,
  preview: apiMessage.preview,
};

const reply = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as unknown as Response;

const ANALYSIS = {
  taches: [
    {
      titre: "Envoyer le compte rendu",
      echeance: DUE,
      de: "Camille",
      mailId: `${ACCOUNT}:${INBOX}:1`,
      assigne: "Camille",
    },
  ],
  evenements: [],
};

function mockBackend() {
  const llmCalls: { system: string; user: string }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(url.pathname);
    if (path.endsWith("/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: { role?: string; content?: string }[];
      };
      llmCalls.push({
        system: body.messages?.[0]?.content ?? "",
        user: body.messages?.[1]?.content ?? "",
      });
      return reply({ choices: [{ message: { content: JSON.stringify(ANALYSIS) } }] });
    }
    if (path.endsWith("/pgp/keys")) return reply({ keys: [] });
    if (path.endsWith("/folder-counts")) return reply([]);
    if (path === "/api/accounts") return reply([apiAccount]);
    if (path === `/api/accounts/${ACCOUNT}/folders`) return reply([apiFolder]);
    if (path.startsWith(`/api/accounts/${ACCOUNT}/folders/${INBOX}/threads`)) return reply([apiThread]);
    if (path === `/api/accounts/${ACCOUNT}/threads/${THREAD}`) return reply(apiThread);
    return reply([]);
  });
  return llmCalls;
}

function mount() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>{children}</MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>
  );
  return render(<DesktopInbox onOpenSearch={() => {}} />, { wrapper });
}

async function openMail() {
  const row = await waitFor(() => {
    const found = document.querySelector<HTMLElement>(`[data-mail-row="${MAIL_ID}"]`);
    if (!found) throw new Error("fil absent de la liste");
    return found;
  });
  fireEvent.click(row);
  await screen.findByText("Transférer");
}

beforeEach(() => {
  window.innerWidth = 1600;
  window.localStorage.clear();
  window.localStorage.setItem(
    "lavande.prefs",
    JSON.stringify({ llm: LLM, summary: { enabled: false }, aiTasks: { enabled: false } }),
  );
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Lecteur PC · analyse à la demande", () => {
  it("propose le bouton Analyse à côté de Répondre et Transférer", async () => {
    mockBackend();
    mount();
    await openMail();

    expect(screen.getByText("Répondre")).toBeTruthy();
    expect(screen.getByText("Analyse")).toBeTruthy();
  });

  it("ouvre le panneau d'analyse au clic et affiche les tâches détectées", async () => {
    const llmCalls = mockBackend();
    mount();
    await openMail();

    expect(screen.queryByTestId("analyse-panel")).toBeNull();
    fireEvent.click(screen.getByText("Analyse"));

    await screen.findByTestId("analyse-panel");
    expect(await screen.findByText("Envoyer le compte rendu")).toBeTruthy();
    expect(screen.getByText("Tâches détectées · 1")).toBeTruthy();
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].user).toContain("compte rendu");
  });

  it("ferme le panneau sans quitter le lecteur", async () => {
    mockBackend();
    mount();
    await openMail();

    fireEvent.click(screen.getByText("Analyse"));
    await screen.findByTestId("analyse-panel");

    fireEvent.click(screen.getByLabelText("Fermer l'analyse"));

    await waitFor(() => expect(screen.queryByTestId("analyse-panel")).toBeNull());
    expect(screen.getByText("Transférer")).toBeTruthy();
  });
});
