import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import { MAILS } from "@/lib/mail";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const REF = { mailId: "3", reason: "Relancer le service achats", due: "aucune" };

function mount() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>{children}</MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>
  );
  return renderHook(() => useMailStore(), { wrapper });
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ keys: [] }), text: async () => "{}" }) as unknown as Response),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("store · proposition d'une action du résumé", () => {
  it("retourne « added » puis « existing » pour la même action", async () => {
    const { result } = mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.mails.some((mail) => mail.id === REF.mailId)).toBe(true);
    expect(MAILS.some((mail) => mail.id === REF.mailId && mail.folder === "inbox")).toBe(true);

    let first: "added" | "existing" | null = null;
    act(() => {
      first = result.current.proposeSummaryAction(REF);
    });
    expect(first).toBe("added");
    expect(result.current.suggestions.some((entry) => entry.proposal === REF.reason)).toBe(true);

    let second: "added" | "existing" | null = null;
    act(() => {
      second = result.current.proposeSummaryAction(REF);
    });
    expect(second).toBe("existing");
    expect(result.current.suggestions.filter((entry) => entry.proposal === REF.reason)).toHaveLength(1);
  });
});
