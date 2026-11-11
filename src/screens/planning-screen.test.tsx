import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PlanningScreen } from "@/screens/planning-screen";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { MAIL_SUGGESTIONS, type MailSuggestion, type Task } from "@/lib/tasks";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

function mount(suggestions: MailSuggestion[], tasks: Task[] = []) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>{children}</MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>
  );
  return render(
    <PlanningScreen
      tasks={tasks}
      setTasks={() => {}}
      suggestions={suggestions}
      onAddSuggestion={() => {}}
      onDismissSuggestion={() => {}}
      onOpenTask={() => {}}
      onOpenSuggestion={() => {}}
    />,
    { wrapper },
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

describe("Planification mobile · origine des suggestions", () => {
  it("affiche la puce IA et le compte réel de la suggestion", () => {
    const suggestion: MailSuggestion = { ...MAIL_SUGGESTIONS[0], ai: true, account: "alpha" };
    mount([suggestion]);

    expect(screen.getByTestId("suggestion-ai")).toBeTruthy();
    expect(screen.getByTestId("suggestion-account").textContent).toBe("alpha");
    expect(screen.getByText(suggestion.proposal)).toBeTruthy();
    expect(screen.getByText(suggestion.subject)).toBeTruthy();
  });

  it("garde le libellé du compte démo sans puce IA sur une suggestion manuelle", () => {
    mount([MAIL_SUGGESTIONS[2]]);

    expect(screen.queryByTestId("suggestion-ai")).toBeNull();
    expect(screen.getByTestId("suggestion-account").textContent).toBe("Studio");
  });
});
