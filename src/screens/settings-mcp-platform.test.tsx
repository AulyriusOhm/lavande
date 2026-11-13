import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SettingsScreen } from "@/screens/settings-screen";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_MAIL_BACKEND", "demo");
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function mount() {
  return render(
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>
            <SettingsScreen
              mails={[]}
              account="all"
              onOpenAccounts={() => {}}
              onOpenPgp={() => {}}
              onOpenMcp={() => {}}
            />
          </MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>,
  );
}

describe("Réglages mobile · gate MCP par plateforme", () => {
  it("sans flag : l'entrée MCP ouvre les serveurs et l'assistant", () => {
    mount();

    fireEvent.click(screen.getByRole("button", { name: /^MCP/ }));

    expect(screen.getByText("Serveurs MCP")).toBeTruthy();
    expect(screen.getByText("Assistant")).toBeTruthy();
  });

  it("sous VITE_PLATFORM=android : aucune entrée MCP", () => {
    vi.stubEnv("VITE_PLATFORM", "android");
    mount();

    expect(screen.queryByRole("button", { name: /^MCP/ })).toBeNull();
    expect(screen.queryByText("Serveurs MCP")).toBeNull();
    expect(screen.queryByText("Assistant")).toBeNull();
    expect(screen.getByRole("button", { name: /^IA/ })).toBeTruthy();
  });
});
