import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopInbox } from "@/desktop/inbox";
import type { ApiAccount, ApiFolder, ApiMessage, ApiThread } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

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
const SENT = "Sent";
const THREAD = "t1";

const apiAccount: ApiAccount = {
  id: ACCOUNT,
  label: "Perso",
  email: "roman@test.fr",
  username: "roman@test.fr",
  imap: { host: "imap.test", port: 993, encryption: "tls" },
  smtp: { host: "smtp.test", port: 465, encryption: "tls" },
  folders: 2,
};

const apiFolder = (path: string, role: ApiFolder["role"]): ApiFolder => ({
  account_id: ACCOUNT,
  path,
  name: path,
  role,
  uidvalidity: 1,
  uidnext: 9,
  last_sync_at: null,
});

const apiMessage = (overrides: Partial<ApiMessage> = {}): ApiMessage => ({
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
  body_text: "Corps reçu",
  body_html: null,
  attachments: [],
  ...overrides,
});

const FIRST = apiMessage({
  to: [
    { name: null, email: "roman@test.fr" },
    { name: null, email: "equipe@test.fr" },
  ],
});

const SENT_MESSAGE = apiMessage({
  folder_path: SENT,
  uid: 2,
  message_id: "<m2@test.fr>",
  from: { name: "Roman", email: "roman@test.fr" },
  to: [
    { name: null, email: "camille@test.fr" },
    { name: null, email: "marc@test.fr" },
  ],
  subject: "Re: Planning",
  date: "2026-01-06T10:00:00Z",
  preview: "Ma réponse",
  body_text: "Ma réponse",
});

const LAST = apiMessage({
  uid: 3,
  message_id: "<m3@test.fr>",
  from: { name: "Support", email: "support@test.fr" },
  date: "2026-01-07T10:00:00Z",
  preview: "Dernier mot",
  body_text: "Dernier mot",
  references: ["<m1@test.fr>", "<m2@test.fr>"],
});

const apiThread = (messages: ApiMessage[]): ApiThread => {
  const primary = messages[messages.length - 1] ?? apiMessage();
  return {
    id: THREAD,
    account_id: ACCOUNT,
    messages,
    primary,
    count: messages.length,
    unread: 0,
    starred: false,
    encrypted: 0,
    attachments: 0,
    participants: ["Camille", "Support"],
    subject: primary.subject,
    preview: primary.preview,
  };
};

const reply = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as unknown as Response;

function mockBackend() {
  /* Le démon rend le fil du plus récent au plus ancien. */
  const thread = apiThread([LAST, SENT_MESSAGE, FIRST]);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(url.pathname) + url.search;
    if (path === "/api/accounts") return reply([apiAccount]);
    if (path.endsWith("/pgp/keys")) return reply({ keys: [] });
    if (path.endsWith("/folder-counts")) return reply([]);
    if (path === `/api/accounts/${ACCOUNT}/folders`) {
      return reply([apiFolder(INBOX, "inbox"), apiFolder(SENT, "sent")]);
    }
    if (path.startsWith(`/api/accounts/${ACCOUNT}/folders/${INBOX}/threads`)) {
      return reply([apiThread([LAST])]);
    }
    if (path.startsWith(`/api/accounts/${ACCOUNT}/folders/${SENT}/threads`)) return reply([]);
    if (path === `/api/accounts/${ACCOUNT}/threads/${THREAD}`) return reply(thread);
    return reply([]);
  });
}

function Probe() {
  const { composeDraft } = useMailStore();
  return (
    <span data-testid="draft">
      {composeDraft
        ? `${composeDraft.to}|${composeDraft.cc}|${composeDraft.inReplyTo ?? ""}|${(
            composeDraft.references ?? []
          ).join(",")}|${composeDraft.replyTargetId ?? ""}`
        : "aucun"}
    </span>
  );
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
  render(
    <>
      <DesktopInbox onOpenSearch={() => {}} />
      <Probe />
    </>,
    { wrapper },
  );
}

const draftField = () => screen.getByTestId("draft").textContent;

async function openThread() {
  const row = await waitFor(() => {
    const found = document.querySelector<HTMLElement>(`[data-mail-row="${ACCOUNT}:${THREAD}"]`);
    if (!found) throw new Error("fil absent de la liste");
    return found;
  });
  fireEvent.click(row);
  await screen.findByText("2 messages antérieurs");
}

beforeEach(() => {
  window.innerWidth = 1600;
  window.localStorage.clear();
  vi.stubGlobal("EventSource", undefined);
  mockBackend();
  mount();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
});

describe("Lecteur PC · répondre à un message du fil", () => {
  it("ne range pas un message postérieur dans les antérieurs", async () => {
    await openThread();

    expect(screen.getByText("2 messages antérieurs")).toBeTruthy();
    expect(screen.queryByText(/message suivant/)).toBeNull();
  });

  it("répond au message visé, pas au dernier du fil", async () => {
    await openThread();

    fireEvent.click(screen.getByLabelText("Répondre au message de Camille"));

    expect(draftField()).toBe(
      `camille@test.fr||<m1@test.fr>|<m1@test.fr>|${ACCOUNT}:${INBOX}:1`,
    );
  });

  it("répond à tous les destinataires d'un message envoyé", async () => {
    await openThread();

    fireEvent.click(screen.getByLabelText("Répondre au message de Moi"));

    expect(draftField()).toBe(
      `camille@test.fr, marc@test.fr||<m2@test.fr>|<m2@test.fr>|${ACCOUNT}:${SENT}:2`,
    );
  });

  it("répond à tous depuis un message du fil en reprenant son Cc", async () => {
    await openThread();

    fireEvent.click(
      screen.getByLabelText("Répondre à tous les destinataires du message de Camille"),
    );

    expect(draftField()).toBe(
      `camille@test.fr, equipe@test.fr||<m1@test.fr>|<m1@test.fr>|${ACCOUNT}:${INBOX}:1`,
    );
  });

  it("range dans les suivants les messages postérieurs au message ouvert", async () => {
    await openThread();

    fireEvent.click(screen.getByLabelText("Ouvrir le message de Camille"));
    await screen.findByText("2 messages suivants");

    expect(screen.queryByText(/message antérieur/)).toBeNull();
  });
});
