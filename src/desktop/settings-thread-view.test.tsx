import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 204, text: async () => "", json: async () => ({}) }) as unknown as Response),
  );
});

function renderSettings() {
  return render(
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>
            <DesktopSettings />
          </MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>,
  );
}

function openSection(label: string) {
  const nav = screen.getByRole("navigation", { name: "Sections des réglages" });
  fireEvent.click(within(nav).getByRole("button", { name: label }));
}

describe("Réglages PC · affichage des conversations", () => {
  it("choisit bien rangé par défaut et bascule vers la citation classique", async () => {
    renderSettings();
    openSection("Apparence");

    const tidy = screen.getByRole("button", { name: "Bien rangé" });
    const inline = screen.getByRole("button", { name: "Tout dans le même mail" });
    expect(tidy.getAttribute("aria-pressed")).toBe("true");
    expect(inline.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Le fil repliable dans la rédaction")).toBeTruthy();

    fireEvent.click(inline);

    await waitFor(() => expect(stored().threadView).toBe("inline"));
    expect(inline.getAttribute("aria-pressed")).toBe("true");
    expect(tidy.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("La citation classique, repliable")).toBeTruthy();

    fireEvent.click(tidy);
    await waitFor(() => expect(stored().threadView).toBe("tidy"));
  });
});
