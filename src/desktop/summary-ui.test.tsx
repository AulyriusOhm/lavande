import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopInbox } from "@/desktop/inbox";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

function stubBackend() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ keys: [] }), text: async () => "{}" }) as unknown as Response),
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

beforeEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Boîte de réception · résumé périodique", () => {
  it("affiche le résumé de la plage courante et son origine", async () => {
    stubBackend();
    mount(<DesktopInbox onOpenSearch={() => {}} />);

    const card = await screen.findByTestId("morning-summary");
    expect(within(card).getByText(/^Résumé du (matin|midi|soir)$/)).toBeTruthy();
    expect(within(card).getByTestId("summary-source").textContent).toBe("local");
    expect(within(card).getByText(/période/)).toBeTruthy();
    expect(within(card).getByLabelText("Régénérer le résumé")).toBeTruthy();
  });

  it("affiche les pièces jointes des mails résumés", async () => {
    stubBackend();
    mount(<DesktopInbox onOpenSearch={() => {}} />);

    const card = await screen.findByTestId("morning-summary");

    await waitFor(() => expect(within(card).getByTestId("summary-attachments")).toBeTruthy());
    const chips = within(card).getByTestId("summary-attachments");
    expect(chips.textContent).toContain("inbox-v3.fig");
    expect(chips.textContent).toContain("4,2 Mo");
    expect(chips.querySelectorAll("span[title]").length).toBeGreaterThan(0);
  });

  it("retombe sur les compteurs quand les résumés sont désactivés", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ summary: { enabled: false } }));
    stubBackend();
    mount(<DesktopInbox onOpenSearch={() => {}} />);

    const card = await screen.findByTestId("morning-summary");
    expect(within(card).getByText("Résumé du matin")).toBeTruthy();
    expect(within(card).queryByTestId("summary-source")).toBeNull();
    expect(within(card).getByText(/conversations non lues/)).toBeTruthy();
  });
});

describe("Réglages · section Résumés", () => {
  it("liste les préférences de résumé et enregistre le consentement LLM", async () => {
    stubBackend();
    mount(<DesktopSettings />);

    expect(await screen.findByText("Résumés périodiques")).toBeTruthy();
    const consent = screen.getByText("Autoriser l'analyse de mes mails par le LLM").closest("button");
    expect(consent?.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(consent as HTMLButtonElement);

    await waitFor(() =>
      expect(
        (JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as { summary?: { llmConsent?: boolean } })
          .summary?.llmConsent,
      ).toBe(true),
    );

    fireEvent.change(screen.getByLabelText("Heure de début du résumé midi"), { target: { value: "13" } });
    await waitFor(() =>
      expect(
        (JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as { summary?: { middayStart?: number } })
          .summary?.middayStart,
      ).toBe(13),
    );
  });
});
