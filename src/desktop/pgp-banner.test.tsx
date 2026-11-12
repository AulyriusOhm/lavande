import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DesktopInbox } from "@/desktop/inbox";
import { MAILS } from "@/lib/mail";
import { threadsInFolder } from "@/lib/threads";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const BANNER = "Message chiffré · PGP désactivé pour ce compte";

const LOCKED = threadsInFolder(MAILS, "inbox").find((thread) => thread.primary.pgp === "encrypted");
if (!LOCKED) throw new Error("aucun fil chiffré dans les fixtures");
const LOCKED_THREAD = LOCKED.id;
const LOCKED_ACCOUNT = LOCKED.primary.account;

function stubBackend() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ keys: [] }),
          text: async () => "{}",
        }) as unknown as Response,
    ),
  );
}

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

function disablePgp(accountId = LOCKED_ACCOUNT) {
  window.localStorage.setItem(
    "lavande.prefs",
    JSON.stringify({ pgpAccounts: { [accountId]: { enabled: false, encrypt: true, sign: true } } }),
  );
}

function openEncryptedThread() {
  const row = document.querySelector<HTMLElement>(`[data-mail-row="${LOCKED_THREAD}"]`);
  if (!row) throw new Error("fil chiffré introuvable");
  fireEvent.click(row);
}

beforeEach(() => {
  window.localStorage.clear();
  stubBackend();
});

describe("Boîte de réception · bandeau PGP coupé", () => {
  it("explique le corps vide d'un message chiffré quand le compte a PGP désactivé", () => {
    disablePgp();
    mount(<DesktopInbox onOpenSearch={() => {}} />);

    openEncryptedThread();

    expect(screen.getByText(BANNER)).toBeTruthy();
    expect(
      screen.getByText("Active PGP pour ce compte dans les réglages pour le déchiffrer."),
    ).toBeTruthy();
  });

  it("ouvre les réglages depuis le bouton", () => {
    disablePgp();
    const onOpenPgp = vi.fn();
    mount(<DesktopInbox onOpenSearch={() => {}} onOpenPgp={onOpenPgp} />);

    openEncryptedThread();
    fireEvent.click(screen.getByText("Ouvrir les réglages"));

    expect(onOpenPgp).toHaveBeenCalledTimes(1);
  });

  it("n'affiche pas de bouton quand la navigation n'est pas câblée", () => {
    disablePgp();
    mount(<DesktopInbox onOpenSearch={() => {}} />);

    openEncryptedThread();

    expect(screen.getByText(BANNER)).toBeTruthy();
    expect(screen.queryByText("Ouvrir les réglages")).toBeNull();
  });

  it("disparaît quand le compte a PGP activé", () => {
    mount(<DesktopInbox onOpenSearch={() => {}} onOpenPgp={() => {}} />);

    openEncryptedThread();

    expect(screen.queryByText(BANNER)).toBeNull();
  });
});
