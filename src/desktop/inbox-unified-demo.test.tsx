import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopInbox } from "@/desktop/inbox";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider } from "@/lib/store";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

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

const mailRows = () => document.querySelectorAll("[data-mail-row]").length;

beforeEach(() => {
  window.innerWidth = 1600;
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("VITE_MAIL_BACKEND", "demo");
});

describe("boîte PC · boîte unifiée en démo", () => {
  it("garde l'atterrissage sur la réception et offre la boîte unifiée en tête", async () => {
    render(<DesktopInbox onOpenSearch={() => {}} />, { wrapper });

    await waitFor(() => expect(rail(/^Boîte de réception/)).toBeTruthy());

    expect(rail(/^Boîte de réception/)?.getAttribute("aria-current")).toBe("true");
    expect(folderRows()[0]).toBe("unified");
    expect(rail(/^Boîte unifiée/)).toBeTruthy();
  });

  it("liste les conversations de tous les dossiers, spam exclu", async () => {
    render(<DesktopInbox onOpenSearch={() => {}} />, { wrapper });
    await waitFor(() => expect(rail(/^Boîte unifiée/)).toBeTruthy());

    fireEvent.click(rail(/^Boîte unifiée/)!);

    await waitFor(() => expect(rail(/^Boîte unifiée/)?.getAttribute("aria-current")).toBe("true"));
    await waitFor(() => expect(mailRows()).toBeGreaterThan(3));

    expect(screen.getAllByText("Devis signé — retour de ma part").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Archive — brief v2 (validé)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Retours sur les maquettes v3").length).toBeGreaterThan(0);
    expect(screen.queryByText("Félicitations ! Vous avez gagné 2 500 000 €")).toBeNull();
  });
});
