import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThreadRow } from "@/components/thread-row";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import { MAILS } from "@/lib/mail";
import { threadsInFolder } from "@/lib/threads";
import type { MailDensity } from "@/lib/prefs";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const THREAD = threadsInFolder(MAILS, "inbox")[0]!;
const PGP_THREAD = threadsInFolder(MAILS, "inbox").find((entry) => entry.primary.pgp !== "none")!;
const PREVIEW = THREAD.preview;

function renderRow(density?: MailDensity, thread = THREAD, showAccount = false) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>{children}</MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>
  );
  render(
    <ThreadRow
      thread={thread}
      density={density}
      showAccount={showAccount}
      onOpen={() => {}}
      onToggleStar={() => {}}
    />,
    { wrapper },
  );
}

function rowOf() {
  const row = document.querySelector<HTMLElement>('[role="button"][aria-label*=" — "]');
  if (!row) throw new Error("ligne de mail introuvable");
  return row;
}

describe("ligne de mail · densité", () => {
  it("garde l'aperçu et l'avatar large en mode confort", () => {
    renderRow("cozy");

    expect(screen.getByText(PREVIEW)).toBeTruthy();
    expect(rowOf().className).toContain("py-3");
    expect(rowOf().className).toContain("rounded-[22px]");
  });

  it("cache l'aperçu et resserre la ligne en mode compact", () => {
    renderRow("compact");

    expect(screen.queryByText(PREVIEW)).toBeNull();
    expect(rowOf().className).toContain("py-2");
    expect(rowOf().className).toContain("rounded-[22px]");
    expect(screen.getByText(THREAD.subject)).toBeTruthy();
  });

  it("garde les pastilles messages/pièces jointes en confort", () => {
    renderRow("cozy");
    expect(screen.getByText(/messages/)).toBeTruthy();
  });

  it("masque les pastilles messages/pièces jointes en compact", () => {
    renderRow("compact");
    expect(screen.queryByText(/messages/)).toBeNull();
    expect(screen.queryByText(/pièce.*jointe/)).toBeNull();
  });

  it("garde l'empilement d'avatars des conversations visible en compact", () => {
    renderRow("compact");

    const layers = rowOf().querySelectorAll('span[class*="size-[32px]"]');
    expect(layers.length).toBe(2);
  });

  it("réduit l'étiquette de compte sous l'avatar en compact", () => {
    renderRow("cozy", THREAD, true);
    expect(rowOf().querySelector("[data-account-chip]")!.className).toContain("text-[10.5px]");
  });

  it("étiquette de compte compacte en mode compact", () => {
    renderRow("compact", THREAD, true);
    expect(rowOf().querySelector("[data-account-chip]")!.className).toContain("text-[8px]");
  });

  it("en compact, le badge PGP rejoint la ligne du nom sans ligne vide", () => {
    renderRow("compact", PGP_THREAD);

    expect(rowOf().querySelector('div[class*="mt-1.5"]')).toBeNull();
    expect(rowOf().querySelector('span[title*="PGP"]')).toBeTruthy();
  });

  it("en confort, le badge PGP garde sa ligne dédiée", () => {
    renderRow("cozy", PGP_THREAD);

    expect(rowOf().querySelector('div[class*="mt-1.5"]')).toBeTruthy();
  });

  it("affiche le confort quand la densité n'est pas fournie", () => {
    renderRow();

    expect(screen.getByText(PREVIEW)).toBeTruthy();
  });
});
