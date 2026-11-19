import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopInbox } from "@/desktop/inbox";
import type { ApiAccount, ApiAttachment, ApiFolder, ApiMessage, ApiThread } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider } from "@/lib/store";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "api");

const { downloadAttachmentMock, revealItemInDirMock } = vi.hoisted(() => ({
  downloadAttachmentMock: vi.fn(),
  revealItemInDirMock: vi.fn(async () => {}),
}));

vi.mock("@/lib/attachments", () => ({ downloadAttachment: downloadAttachmentMock }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: revealItemInDirMock }));

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
  uidnext: 3,
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

const sentMessage = apiMessage({
  folder_path: SENT,
  uid: 2,
  message_id: "<m2@test.fr>",
  from: { name: "Roman", email: "roman@test.fr" },
  subject: "Re: Planning",
  date: "2026-01-06T10:00:00Z",
  preview: "Ma réponse",
  body_text: null,
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
    participants: ["Camille"],
    subject: primary.subject,
    preview: primary.preview,
  };
};

const reply = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as unknown as Response;

function mockBackend(inboxMessage: ApiMessage = apiMessage()) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(url.pathname) + url.search;
    calls.push(path);
    if (path === "/api/accounts") return reply([apiAccount]);
    if (path.endsWith("/pgp/keys")) return reply({ keys: [] });
    if (path.endsWith("/folder-counts")) return reply([]);
    if (path === `/api/accounts/${ACCOUNT}/folders`) {
      return reply([apiFolder(INBOX, "inbox"), apiFolder(SENT, "sent")]);
    }
    if (path.startsWith(`/api/accounts/${ACCOUNT}/folders/${INBOX}/threads`)) {
      return reply([apiThread([inboxMessage])]);
    }
    if (path.startsWith(`/api/accounts/${ACCOUNT}/folders/${SENT}/threads`)) return reply([]);
    if (path === `/api/accounts/${ACCOUNT}/threads/${THREAD}`) {
      return reply(apiThread([sentMessage, inboxMessage]));
    }
    if (path.startsWith(`/api/accounts/${ACCOUNT}/folders/${SENT}/messages/2`)) {
      return reply({ ...sentMessage, body_text: "Corps envoyé" });
    }
    return reply([]);
  });
  return calls;
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

beforeEach(() => {
  window.innerWidth = 1600;
  window.localStorage.clear();
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
});

describe("Lecteur PC · fil complet", () => {
  it("lit le corps d'un autre message du fil rangé dans un autre dossier", async () => {
    const calls = mockBackend();
    mount();

    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(`[data-mail-row="${ACCOUNT}:${THREAD}"]`);
      if (!found) throw new Error("fil absent de la liste");
      return found;
    });
    fireEvent.click(row);

    await screen.findByText("1 message suivant");
    expect(await screen.findByText("Corps envoyé")).toBeTruthy();
    expect(calls).toContain(`/api/accounts/${ACCOUNT}/threads/${THREAD}`);
    expect(calls).toContain(`/api/accounts/${ACCOUNT}/folders/${SENT}/messages/2?fetch_body=true`);
  });
});

describe("Lecteur PC · pièce jointe enregistrée", () => {
  const ATTACHMENT: ApiAttachment = {
    filename: "facture.pdf",
    mime: "application/pdf",
    size: 5,
    inline: false,
  };

  const downloadAttachmentChip = async () => {
    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(`[data-mail-row="${ACCOUNT}:${THREAD}"]`);
      if (!found) throw new Error("fil absent de la liste");
      return found;
    });
    fireEvent.click(row);
    fireEvent.click(await screen.findByLabelText("Télécharger facture.pdf (5 o)"));
  };

  beforeEach(() => {
    downloadAttachmentMock.mockReset();
    revealItemInDirMock.mockReset();
    mockBackend(apiMessage({ attachments: [ATTACHMENT] }));
  });

  it("ouvre le dossier du fichier enregistré", async () => {
    downloadAttachmentMock.mockResolvedValue({
      message: "« facture.pdf » enregistré dans /tmp/x/facture.pdf",
      path: "/tmp/x/facture.pdf",
    });
    mount();

    await downloadAttachmentChip();

    expect(
      await screen.findByText("« facture.pdf » enregistré dans /tmp/x/facture.pdf"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Ouvrir le dossier/ }));
    await waitFor(() => expect(revealItemInDirMock).toHaveBeenCalledWith("/tmp/x/facture.pdf"));
  });

  it("n'offre pas le dossier quand aucun chemin n'est rendu", async () => {
    downloadAttachmentMock.mockResolvedValue({ message: "« facture.pdf » téléchargé", path: null });
    mount();

    await downloadAttachmentChip();

    expect(await screen.findByText("« facture.pdf » téléchargé")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Ouvrir le dossier/ })).toBeNull();
  });
});

describe("Lecteur PC · marque répondu", () => {
  const openRow = async () => {
    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(`[data-mail-row="${ACCOUNT}:${THREAD}"]`);
      if (!found) throw new Error("fil absent de la liste");
      return found;
    });
    fireEvent.click(row);
    await screen.findByText("1 message suivant");
  };

  it("signale le mail auquel on a déjà répondu", async () => {
    mockBackend(apiMessage({ flags: { unread: false, starred: false, answered: true } }));
    mount();

    await openRow();

    expect(screen.getByText("Répondu")).toBeTruthy();
  });

  it("ne dit rien d'un mail sans réponse", async () => {
    mockBackend();
    mount();

    await openRow();

    expect(screen.queryByText("Répondu")).toBeNull();
  });
});

describe("Lecteur PC · destinataires du message", () => {
  const openThread = async () => {
    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(`[data-mail-row="${ACCOUNT}:${THREAD}"]`);
      if (!found) throw new Error("fil absent de la liste");
      return found;
    });
    fireEvent.click(row);
    return within(await screen.findByTestId("mail-recipients"));
  };

  it("affiche les destinataires À et Cc du message ouvert", async () => {
    mockBackend(
      apiMessage({
        to: [
          { name: null, email: "roman@test.fr" },
          { name: "Équipe", email: "equipe@test.fr" },
        ],
        cc: [{ name: "Marc", email: "marc@test.fr" }],
      }),
    );
    mount();

    const recipients = await openThread();
    expect(recipients.getByText("À")).toBeTruthy();
    expect(recipients.getByText("roman@test.fr, equipe@test.fr")).toBeTruthy();
    expect(recipients.getByText("Cc")).toBeTruthy();
    expect(recipients.getByText("marc@test.fr")).toBeTruthy();
  });

  it("n'affiche pas de ligne Cc quand le message n'a pas de copie", async () => {
    mockBackend();
    mount();

    const recipients = await openThread();
    expect(recipients.getByText("À")).toBeTruthy();
    expect(recipients.queryByText("Cc")).toBeNull();
  });
});
