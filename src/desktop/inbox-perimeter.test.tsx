import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopInbox } from "@/desktop/inbox";
import { DesktopSettings } from "@/desktop/settings";
import { AccountSwitchSheet } from "@/screens/inbox-screen";
import { ALL_ACCOUNTS } from "@/lib/accounts";
import type { ApiAccount, ApiFolder, ApiFolderRole, ApiMessage, ApiThread } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider } from "@/lib/store";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "api");

const PERSO = "perso";
const TRAVAIL = "travail";
const STUDIO = "studio";
const SUBJECT: Record<string, string> = { [PERSO]: "Sujet perso", [TRAVAIL]: "Sujet travail", [STUDIO]: "Sujet studio" };
const UNREAD: Record<string, number> = { [PERSO]: 2, [TRAVAIL]: 5, [STUDIO]: 1 };

const account = (id: string, label: string): ApiAccount => ({
  id,
  label,
  email: `${id}@lavande.mail`,
  username: id,
  imap: { host: "imap.lavande.mail", port: 993, encryption: "tls" },
  smtp: { host: "smtp.lavande.mail", port: 465, encryption: "tls" },
  folders: 2,
});

const ACCOUNTS = [account(PERSO, "Perso"), account(TRAVAIL, "Travail"), account(STUDIO, "Studio")];

const folder = (accountId: string, path: string, role: ApiFolderRole): ApiFolder => ({
  account_id: accountId,
  path,
  name: path,
  role,
  uidvalidity: 7,
  uidnext: 42,
  last_sync_at: null,
});

const FOLDERS: ApiFolder[] = [
  folder(PERSO, "INBOX", "inbox"),
  folder(PERSO, "Projets", "other"),
  folder(TRAVAIL, "INBOX", "inbox"),
  folder(TRAVAIL, "Compta", "other"),
  folder(STUDIO, "INBOX", "inbox"),
  folder(STUDIO, "Factures", "other"),
];

const apiMessage = (accountId: string): ApiMessage => ({
  account_id: accountId,
  folder_path: "INBOX",
  uid: 1,
  uidvalidity: 7,
  thread_id: `t-${accountId}`,
  message_id: `<${accountId}@lavande.mail>`,
  in_reply_to: null,
  references: [],
  from: { name: "Camille", email: `camille@${accountId}.test` },
  to: [{ name: null, email: `${accountId}@lavande.mail` }],
  cc: [],
  subject: SUBJECT[accountId],
  date: "2026-01-05T10:00:00Z",
  flags: { unread: true, starred: false, answered: false },
  size: 512,
  pgp: "none",
  preview: `Aperçu ${accountId}`,
  body_text: `Corps ${accountId}`,
  body_html: null,
  attachments: [],
});

const apiThread = (accountId: string): ApiThread => {
  const primary = apiMessage(accountId);
  return {
    id: primary.thread_id,
    account_id: accountId,
    messages: [primary],
    primary,
    count: 1,
    unread: 1,
    starred: false,
    encrypted: 0,
    attachments: 0,
    participants: [primary.from.email],
    subject: primary.subject,
    preview: primary.preview,
  };
};

const response = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }) as unknown as Response;

function stubBackend() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const path = decodeURIComponent(new URL(String(input), "http://localhost").pathname);
      if (path === "/api/accounts") return response(ACCOUNTS);
      if (path.endsWith("/folder-counts")) {
        const accountId = /\/api\/accounts\/([^/]+)\/folder-counts$/.exec(path)?.[1] ?? "";
        return response([{ path: "INBOX", total: 10, unread: UNREAD[accountId] ?? 0 }]);
      }
      if (path.endsWith("/pgp/keys")) return response({ keys: [] });
      const match = /\/api\/accounts\/([^/]+)\/folders(?:\/([^/]+)\/threads)?$/.exec(path);
      if (match) {
        const [, accountId, folderPath] = match;
        if (folderPath === undefined) return response(FOLDERS.filter((entry) => entry.account_id === accountId));
        return response([apiThread(accountId)]);
      }
      return response([]);
    }),
  );
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <PrefsProvider>
    <ThemeProvider>
      <PlanningProvider storage={createMemoryStorage()}>
        <MailStoreProvider>{children}</MailStoreProvider>
      </PlanningProvider>
    </ThemeProvider>
  </PrefsProvider>
);

const setPerimeters = (perimeters: Record<string, unknown>) =>
  window.localStorage.setItem("lavande.prefs", JSON.stringify({ perimeters }));

const rail = (label: RegExp) =>
  within(screen.getByTestId("desktop-inbox")).queryByRole("button", { name: label });

beforeEach(() => {
  window.innerWidth = 1600;
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
});

describe("boîte PC · périmètre mails", () => {
  it("retire le compte coupé du rail, des dossiers, des mails et des compteurs", async () => {
    setPerimeters({ [TRAVAIL]: { mails: false } });
    stubBackend();
    render(<DesktopInbox onOpenSearch={() => {}} />, { wrapper });

    await waitFor(() => expect(screen.getAllByText(SUBJECT[PERSO]).length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getAllByText(SUBJECT[STUDIO]).length).toBeGreaterThan(0));

    expect(screen.queryByText(SUBJECT[TRAVAIL])).toBeNull();
    expect(rail(/^Travail/)).toBeNull();
    expect(rail(/^Perso/)).toBeTruthy();
    expect(rail(/^Studio/)).toBeTruthy();

    const all = within(screen.getByTestId("desktop-inbox")).getByRole("button", {
      name: /^Tous les comptes/,
    });
    expect(all.textContent?.replace(/\s+/g, "")).toBe("Touslescomptes3");

    expect(screen.queryByText("Compta")).toBeNull();
    expect(screen.getByText("Factures")).toBeTruthy();
  });
});

describe("boîte PC · un seul compte visible", () => {
  it("bascule la sélection dessus et active son entrée du rail", async () => {
    setPerimeters({ [TRAVAIL]: { mails: false }, [STUDIO]: { mails: false } });
    stubBackend();
    render(<DesktopInbox onOpenSearch={() => {}} />, { wrapper });

    await waitFor(() => expect(rail(/^Perso/)).toBeTruthy());

    await waitFor(() => expect(rail(/^Perso/)?.getAttribute("aria-current")).toBe("true"));
    expect(rail(/^Tous les comptes/)).toBeNull();
    expect(rail(/^Travail/)).toBeNull();
    expect(rail(/^Studio/)).toBeNull();
  });
});

describe("liste des comptes mobile · périmètre mails", () => {
  it("n'offre pas le compte coupé", async () => {
    setPerimeters({ [TRAVAIL]: { mails: false } });
    stubBackend();
    render(<AccountSwitchSheet active={ALL_ACCOUNTS} onSelect={() => {}} onClose={() => {}} />, { wrapper });

    await waitFor(() => expect(screen.getByText("Perso")).toBeTruthy());

    expect(screen.getByText("Studio")).toBeTruthy();
    expect(screen.queryByText("Travail")).toBeNull();
  });
});

describe("réglages · périmètre mails", () => {
  it("garde le compte coupé réactivable et le rend à la boîte", async () => {
    setPerimeters({ [TRAVAIL]: { mails: false } });
    stubBackend();
    render(
      <>
        <DesktopSettings />
        <DesktopInbox onOpenSearch={() => {}} />
      </>,
      { wrapper },
    );

    await waitFor(() => expect(rail(/^Perso/)).toBeTruthy());
    expect(rail(/^Travail/)).toBeNull();
    expect(screen.queryAllByText("Travail").length).toBeGreaterThan(0);

    fireEvent.click(await screen.findByRole("button", { name: "Périmètre de synchronisation de Travail" }));
    const panel = () => within(screen.getByRole("group", { name: "Périmètre de synchronisation de Travail" }));
    const mails = () => panel().getAllByRole("switch", { name: /^Mails/ })[0];

    expect(mails().getAttribute("aria-checked")).toBe("false");
    fireEvent.click(mails());

    await waitFor(() => expect(rail(/^Travail/)).toBeTruthy());

    fireEvent.click(mails());

    await waitFor(() => expect(rail(/^Travail/)).toBeNull());
    expect(screen.queryAllByText("Travail").length).toBeGreaterThan(0);
  });
});
