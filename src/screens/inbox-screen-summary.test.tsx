import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { InboxScreen } from "@/screens/inbox-screen";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { MAILS } from "@/lib/mail";
import type { MailNavigation } from "@/lib/app-shortcuts";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

function mount() {
  function Host() {
    const navigationRef = useRef<MailNavigation | null>(null);
    return (
      <InboxScreen
        mails={MAILS}
        account="all"
        folder="inbox"
        active
        navigationRef={navigationRef}
        onOpenAccounts={() => {}}
        onOpenFolders={() => {}}
        onOpen={() => {}}
        onToggleStar={() => {}}
        onSearch={() => {}}
        onMailAction={() => {}}
        onReply={() => {}}
      />
    );
  }
  return render(
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>
            <Host />
          </MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
  Element.prototype.scrollTo = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ keys: [] }) }) as unknown as Response),
  );
});

describe("Boîte de réception mobile · résumé périodique", () => {
  it("affiche les pièces jointes des mails résumés", async () => {
    mount();

    const chips = await screen.findByTestId("summary-attachments-mobile");

    expect(chips.textContent).toContain("inbox-v3.fig");
    expect(chips.textContent).toContain("4,2 Mo");
    expect(chips.textContent).toContain("specs-mobile.pdf");
  });

  it("garde le bouton de régénération comme seule relance manuelle", async () => {
    mount();

    const regenerate = await screen.findByLabelText("Régénérer le résumé");

    expect(regenerate.tagName).toBe("BUTTON");
    expect(screen.getAllByLabelText("Régénérer le résumé")).toHaveLength(1);
  });
});
