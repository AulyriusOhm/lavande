import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopInbox } from "@/desktop/inbox";
import type { ApiAccount, ApiFolder, ApiMessage, ApiThread } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider } from "@/lib/store";
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
const PROJETS = "Projets";
/** Fil de la boîte de réception : le seul que la liste du dossier consulté contient. */
const INBOX_THREAD = "t1";
/** Fil du dossier analysé par l'IA : absent de la liste de la boîte de réception. */
const AI_THREAD = "t2";
const AI_SUBJECT = "Briefing de la rentrée";

const apiAccount: ApiAccount = {
  id: ACCOUNT,
  label: "Perso",
  email: "roman@test.fr",
  username: "roman@test.fr",
  imap: { host: "imap.test", port: 993, encryption: "tls" },
  smtp: { host: "smtp.test", port: 465, encryption: "tls" },
  folders: 2,
  ai_folders: [PROJETS],
};

const folderOf = (path: string, name: string, role: ApiFolder["role"]): ApiFolder => ({
  account_id: ACCOUNT,
  path,
  name,
  role,
  uidvalidity: 1,
  uidnext: 3,
  last_sync_at: null,
});

const FOLDERS: ApiFolder[] = [
  folderOf(INBOX, "Boîte de réception", "inbox"),
  folderOf(PROJETS, PROJETS, "other"),
];

const messageOf = (uid: number, thread: string, folderPath: string, subject: string): ApiMessage => ({
  account_id: ACCOUNT,
  folder_path: folderPath,
  uid,
  uidvalidity: 1,
  thread_id: thread,
  message_id: `<m${uid}@test.fr>`,
  in_reply_to: null,
  references: [],
  from: { name: "Camille", email: "camille@test.fr" },
  to: [{ name: null, email: "roman@test.fr" }],
  cc: [],
  subject,
  date: new Date(Date.now() - 3_600_000).toISOString(),
  flags: { unread: true, starred: false, answered: false },
  size: 512,
  pgp: "none",
  pgp_detail: null,
  preview: "Aperçu",
  body_text: "Le brief de rentrée est prêt, tu peux le relire.",
  body_html: null,
  attachments: [],
});

const threadOf = (id: string, message: ApiMessage): ApiThread => ({
  id,
  account_id: ACCOUNT,
  messages: [message],
  primary: message,
  count: 1,
  unread: 1,
  starred: false,
  encrypted: 0,
  attachments: 0,
  participants: ["camille@test.fr"],
  subject: message.subject,
  preview: message.preview,
});

const inboxMessage = messageOf(1, INBOX_THREAD, INBOX, "Rapport hebdomadaire");
const aiMessage = messageOf(1, AI_THREAD, PROJETS, AI_SUBJECT);
const INBOX_THREAD_DATA = threadOf(INBOX_THREAD, inboxMessage);
const AI_THREAD_DATA = threadOf(AI_THREAD, aiMessage);

const response = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: "",
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function mockBackend() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const { pathname, search } = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(pathname + search);
    if (path === "/api/accounts") return response([apiAccount]);
    if (path === `/api/accounts/${ACCOUNT}/folders`) return response(FOLDERS);
    if (path.endsWith("/folder-counts")) return response([]);
    if (path.endsWith("/pgp/keys")) return response({ keys: [] });
    if (path.includes(`/folders/${INBOX}/threads`)) return response([INBOX_THREAD_DATA]);
    if (path.includes(`/folders/${PROJETS}/threads`)) return response([AI_THREAD_DATA]);
    if (path.includes(`/messages/1`)) return response(aiMessage);
    return response([]);
  });
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

const subjectButton = (card: HTMLElement) =>
  within(card).getAllByRole("button", { name: AI_SUBJECT }).at(0) as HTMLButtonElement;

const row = (threadId: string) =>
  document.querySelector<HTMLElement>(`[data-mail-row="${ACCOUNT}:${threadId}"]`);

beforeEach(() => {
  window.innerWidth = 1600;
  window.localStorage.clear();
  window.localStorage.setItem("lavande.prefs", JSON.stringify({ aiTasks: { enabled: false } }));
  mockBackend();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
});

describe("Résumé du matin · ouverture d'un mail absent du dossier consulté", () => {
  it("ouvre le mail du dossier analysé par l'IA depuis l'objet du résumé", async () => {
    mount();

    const card = await screen.findByTestId("morning-summary");
    await waitFor(() => expect(subjectButton(card)).toBeTruthy());
    // Le mail du résumé n'est pas dans la liste : seul celui de la réception y est.
    await waitFor(() => expect(row(INBOX_THREAD)).not.toBeNull());
    expect(row(AI_THREAD)).toBeNull();

    fireEvent.click(subjectButton(card));

    expect(await screen.findByRole("heading", { name: AI_SUBJECT })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Répondre$/ })).toBeTruthy();
    expect(screen.queryByText(/Mail d'origine introuvable/)).toBeNull();
  });
});
