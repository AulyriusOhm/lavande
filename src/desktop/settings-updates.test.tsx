import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;
const updates = () => (stored().updates ?? {}) as { autoCheck?: boolean; intervalHours?: number };

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

const toggle = () => screen.getByRole("switch", { name: /Vérification automatique/ });
const chip = (label: string) => screen.getByRole("button", { name: label });

describe("Réglages PC · vérification des mises à jour", () => {
  it("active la vérification automatique et propose 24 h par défaut", () => {
    renderSettings();

    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(chip("24 h").getAttribute("aria-pressed")).toBe("true");
    expect(chip("7 j")).toBeTruthy();
  });

  it("coupe la vérification et masque la fréquence", async () => {
    renderSettings();

    fireEvent.click(toggle());

    await waitFor(() => expect(updates().autoCheck).toBe(false));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("button", { name: "24 h" })).toBeNull();
    expect(screen.queryByText("Fréquence de vérification")).toBeNull();
  });

  it("change la fréquence et la persiste", async () => {
    renderSettings();

    fireEvent.click(chip("6 h"));

    await waitFor(() => expect(updates().intervalHours).toBe(6));
    expect(chip("6 h").getAttribute("aria-pressed")).toBe("true");
    expect(chip("24 h").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(chip("7 j"));
    await waitFor(() => expect(updates().intervalHours).toBe(168));
  });
});
