import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopInbox } from "@/desktop/inbox";
import { MailboxSheet } from "@/screens/inbox-screen";
import { ALL_ACCOUNTS } from "@/lib/accounts";
import type { ApiAccount, ApiFolder, ApiFolderRole, ApiMessage, ApiThread } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider } from "@/lib/store";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "api");

const PERSO = "perso";
const PRO = "pro";

const account = (id: string, label: string): ApiAccount => ({
  id,
  label,
  email: `${id}@lavande.mail`,
  username: id,
  imap: { host: "imap.lavande.mail", port: 993, encryption: "tls" },
  smtp: { host: "smtp.lavande.mail", port: 465, encryption: "tls" },
  folders: 4,
});

const ACCOUNTS = [account(PERSO, "Perso"), account(PRO, "Pro")];

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
  folder(PERSO, "Sent", "sent"),
  folder(PERSO, "Projets", "other"),
  folder(PERSO, "Archive", "archive"),
  folder(PERSO, "Corbeille", "trash"),
  folder(PERSO, "Spam", "spam"),
  folder(PRO, "INBOX", "inbox"),
  folder(PRO, "Envoyés", "sent"),
  folder(PRO, "Archive", "archive"),
  folder(PRO, "Corbeille", "trash"),
  folder(PRO, "Spam", "spam"),
];

const SUBJECTS: Record<string, string> = {
  [`${PERSO}:INBOX`]: "Réception perso",
  [`${PERSO}:Sent`]: "Envoi perso",
  [`${PERSO}:Projets`]: "Projets perso",
  [`${PERSO}:Archive`]: "Archive perso",
  [`${PERSO}:Corbeille`]: "Corbeille perso",
  [`${PERSO}:Spam`]: "Spam perso",
  [`${PRO}:INBOX`]: "Réception pro",
  [`${PRO}:Envoyés`]: "Envoi pro",
  [`${PRO}:Archive`]: "Archive pro",
  [`${PRO}:Corbeille`]: "Corbeille pro",
  [`${PRO}:Spam`]: "Spam pro",
};

const message = (accountId: string, folderPath: string, uid: number): ApiMessage => ({
  account_id: accountId,
  folder_path: folderPath,
  uid,
  uidvalidity: 7,
  thread_id: `t-${accountId}-${folderPath}`,
  message_id: `<${accountId}-${folderPath}@lavande.mail>`,
  in_reply_to: null,
  references: [],
  from: { name: "Camille", email: `camille@${accountId}.test` },
  to: [{ name: null, email: `${accountId}@lavande.mail` }],
  cc: [],
  subject: SUBJECTS[`${accountId}:${folderPath}`] ?? "Sans sujet",
  date: "2026-01-05T10:00:00Z",
  flags: { unread: true, starred: false, answered: false },
  size: 512,
  pgp: "none",
  preview: `Aperçu ${folderPath}`,
  body_text: `Corps ${folderPath}`,
  body_html: null,
  attachments: [],
});

const thread = (accountId: string, folderPath: string, uid: number): ApiThread => {
  const primary = message(accountId, folderPath, uid);
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

const calls: { threads: string[]; moves: { accountId: string; body: unknown }[] } = {
  threads: [],
  moves: [],
};

function stubBackend() {
  calls.threads = [];
  calls.moves = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const path = decodeURIComponent(new URL(String(input), "http://localhost").pathname);
      if (path === "/api/accounts") return response(ACCOUNTS);
      if (path.endsWith("/folder-counts")) {
        const accountId = /\/api\/accounts\/([^/]+)\/folder-counts$/.exec(path)?.[1] ?? "";
        return response(
          FOLDERS.filter((entry) => entry.account_id === accountId).map((entry) => ({
            path: entry.path,
            total: 2,
            unread: 1,
          })),
        );
      }
      if (path.endsWith("/pgp/keys")) return response({ keys: [] });
      if (path.endsWith("/sync")) return response({ reports: [] });
      if (path.endsWith("/move")) {
        calls.moves.push({
          accountId: /\/api\/accounts\/([^/]+)\/move$/.exec(path)?.[1] ?? "",
          body: JSON.parse(String(init?.body ?? "{}")),
        });
        return response({});
      }
      const match = /\/api\/accounts\/([^/]+)\/folders(?:\/([^/]+)\/threads)?$/.exec(path);
      if (match) {
        const [, accountId, folderPath] = match;
        if (folderPath === undefined) {
          return response(FOLDERS.filter((entry) => entry.account_id === accountId));
        }
        calls.threads.push(`${accountId}:${folderPath}`);
        return response([thread(accountId, folderPath, 1)]);
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

const rail = (label: RegExp) =>
  within(screen.getByTestId("desktop-inbox")).queryByRole("button", { name: label });

const folderRows = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-folder-row]")).map((row) =>
    row.getAttribute("data-folder-row"),
  );

const mailRows = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-mail-row]")).map(
    (row) => row.getAttribute("data-mail-row") ?? "",
  );

beforeEach(() => {
  window.innerWidth = 1600;
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
});

describe("boîte PC · boîte unifiée", () => {
  it("ouvre « Tous les comptes » sur la boîte unifiée, en tête du rail", async () => {
    stubBackend();
    render(<DesktopInbox onOpenSearch={() => {}} />, { wrapper });

    await waitFor(() => expect(rail(/^Boîte unifiée/)).toBeTruthy());

    expect(folderRows()[0]).toBe("unified");
    expect(rail(/^Boîte unifiée/)?.getAttribute("aria-current")).toBe("true");
    expect(screen.getAllByText("Boîte unifiée").length).toBeGreaterThan(0);
  });

  it("mélange les dossiers de tous les comptes, sans corbeille ni spam", async () => {
    stubBackend();
    render(<DesktopInbox onOpenSearch={() => {}} />, { wrapper });

    await waitFor(() => expect(mailRows().length).toBe(7));

    expect(mailRows().sort()).toEqual(
      [
        `${PERSO}:t-${PERSO}-INBOX`,
        `${PERSO}:t-${PERSO}-Sent`,
        `${PERSO}:t-${PERSO}-Projets`,
        `${PERSO}:t-${PERSO}-Archive`,
        `${PRO}:t-${PRO}-INBOX`,
        `${PRO}:t-${PRO}-Envoyés`,
        `${PRO}:t-${PRO}-Archive`,
      ].sort(),
    );
    expect(new Set(calls.threads)).toEqual(
      new Set([
        `${PERSO}:INBOX`,
        `${PERSO}:Sent`,
        `${PERSO}:Projets`,
        `${PERSO}:Archive`,
        `${PRO}:INBOX`,
        `${PRO}:Envoyés`,
        `${PRO}:Archive`,
      ]),
    );
    expect(screen.queryByText("Corbeille perso")).toBeNull();
    expect(screen.queryByText("Spam perso")).toBeNull();
    expect(screen.queryByText("Corbeille pro")).toBeNull();
    expect(screen.queryByText("Spam pro")).toBeNull();
  });

  it("garde la boîte unifiée en repassant sur tous les comptes", async () => {
    stubBackend();
    render(<DesktopInbox onOpenSearch={() => {}} />, { wrapper });

    await waitFor(() => expect(rail(/^Perso/)).toBeTruthy());
    fireEvent.click(rail(/^Perso/)!);

    await waitFor(() => expect(rail(/^Perso/)?.getAttribute("aria-current")).toBe("true"));
    expect(folderRows()).not.toContain("unified");

    fireEvent.click(rail(/^Tous les comptes/)!);

    await waitFor(() => expect(rail(/^Boîte unifiée/)?.getAttribute("aria-current")).toBe("true"));
    expect(folderRows()[0]).toBe("unified");
  });

  it("archive depuis la boîte unifiée sur le compte et le dossier du message", async () => {
    stubBackend();
    render(<DesktopInbox onOpenSearch={() => {}} />, { wrapper });

    await waitFor(() => expect(mailRows()).toContain(`${PRO}:t-${PRO}-Envoyés`));

    const row = document.querySelector<HTMLElement>(`[data-mail-row="${PRO}:t-${PRO}-Envoyés"]`);
    const group = row?.parentElement ?? null;
    expect(group).toBeTruthy();
    fireEvent.click(within(group as HTMLElement).getByLabelText("Archiver"));

    await waitFor(() => expect(calls.moves).toHaveLength(1));
    expect(calls.moves[0]).toEqual({
      accountId: PRO,
      body: { from_path: "Envoyés", uid: 1, to_path: "Archive" },
    });
  });
});

describe("feuille des dossiers mobile · boîte unifiée", () => {
  it("met la boîte unifiée en tête de la feuille", async () => {
    stubBackend();
    render(<MailboxSheet folder="unified" onSelect={() => {}} onClose={() => {}} />, { wrapper });

    await waitFor(() => expect(screen.getByText("Boîte unifiée")).toBeTruthy());
    expect(folderRows()[0]).toBe("unified");
    expect(screen.getByText("Boîte unifiée").closest("[data-folder-row]")).toBeTruthy();
    expect(folderRows()).toContain("inbox");
  });
});
