import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import { clearMcpLog, recordMcpAction, resetMcpRights } from "@/lib/mcp";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_MAIL_BACKEND", "local");
  window.localStorage.clear();
  clearMcpLog();
  resetMcpRights();
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

describe("Réglages · serveurs MCP", () => {
  it("affiche le journal réel des actions et plus aucune entrée factice", () => {
    recordMcpAction({
      tool: "mail.send",
      server: "lavande-mail",
      agent: "Agent de test",
      status: "refusé",
      detail: "Facture d'août · envoi refusé",
    });
    renderSettings();

    expect(screen.getByText("mail.send")).toBeTruthy();
    expect(screen.getByText("Facture d'août · envoi refusé")).toBeTruthy();
    expect(screen.getByText("Agent de test")).toBeTruthy();
    expect(screen.getAllByText("refusé").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Point maquettes/)).toBeNull();
    expect(screen.queryByText(/Assistant Lavande/)).toBeNull();
    expect(screen.queryByText("Aucune action journalisée.")).toBeNull();
  });

  it("affiche un état vide sans action", () => {
    renderSettings();

    expect(screen.getByText("Aucune action journalisée.")).toBeTruthy();
    expect(screen.queryByText(/Point maquettes/)).toBeNull();
  });

  it("persiste « toujours autoriser » pour un type d'action", () => {
    renderSettings();

    fireEvent.click(screen.getByRole("switch", { name: "Toujours autoriser · envoi" }));

    const prefs = JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as {
      mcpAlwaysAllow?: Record<string, boolean>;
    };
    expect(prefs.mcpAlwaysAllow).toEqual({ envoi: true });
    expect(screen.getByRole("switch", { name: "Toujours autoriser · envoi" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("réinitialise les autorisations par type", () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ mcpAlwaysAllow: { envoi: true, suppression: true } }),
    );
    renderSettings();

    expect(screen.getByRole("switch", { name: "Toujours autoriser · envoi" }).getAttribute("aria-checked")).toBe(
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Tout redemander" }));

    expect(screen.getByRole("switch", { name: "Toujours autoriser · envoi" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    const prefs = JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as {
      mcpAlwaysAllow?: Record<string, boolean>;
    };
    expect(prefs.mcpAlwaysAllow).toEqual({});
  });
});
