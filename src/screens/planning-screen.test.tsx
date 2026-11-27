import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PlanningScreen } from "@/screens/planning-screen";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { MAIL_SUGGESTIONS, type MailSuggestion, type Task } from "@/lib/tasks";
import { useMailStore } from "@/lib/store";
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

function MailProbe() {
  const { openMail } = useMailStore();
  return <span data-testid="open-mail">{openMail?.id ?? "aucun"}</span>;
}

describe("Planification mobile · mail d'origine", () => {
  it("ouvre le mail source depuis la carte de suggestion", () => {
    const suggestion: MailSuggestion = { ...MAIL_SUGGESTIONS[0], ai: true, mailId: "1" };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PrefsProvider>
        <ThemeProvider>
          <PlanningProvider storage={createMemoryStorage()}>
            <MailStoreProvider>{children}</MailStoreProvider>
          </PlanningProvider>
        </ThemeProvider>
      </PrefsProvider>
    );
    render(
      <>
        <MailProbe />
        <PlanningScreen
          tasks={[]}
          setTasks={() => {}}
          suggestions={[suggestion]}
          onAddSuggestion={() => {}}
          onDismissSuggestion={() => {}}
          onOpenTask={() => {}}
          onOpenSuggestion={() => {}}
        />
      </>,
      { wrapper },
    );

    const button = screen.getByRole("button", { name: /Voir le mail d'origine/ });
    expect(button.className).toContain("min-h-11");
    fireEvent.click(button);

    expect(screen.getByTestId("open-mail").textContent).toBe("1");
  });

  it("n'affiche aucun lien quand le mail source est introuvable", () => {
    mount([{ ...MAIL_SUGGESTIONS[0], ai: true, mailId: "absent" }]);

    expect(screen.queryByRole("button", { name: /Voir le mail d'origine/ })).toBeNull();
  });
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

  it("affiche la date seule, sans légende, quand l'échéance est réelle", () => {
    const suggestion: MailSuggestion = { ...MAIL_SUGGESTIONS[0], due: "vendredi", dueTone: "soon" };
    mount([suggestion]);

    expect(screen.getByTestId("suggestion-due").textContent).toBe("vendredi");
    expect(screen.queryByText("échéance déduite")).toBeNull();
  });

  it("n'affiche ni puce date ni libellé quand la suggestion n'a pas d'échéance", () => {
    const suggestion: MailSuggestion = { ...MAIL_SUGGESTIONS[0], due: "", dueTone: "none" };
    mount([suggestion]);

    expect(screen.queryByTestId("suggestion-due")).toBeNull();
    expect(screen.queryByText("sans échéance")).toBeNull();
    expect(screen.queryByText("échéance déduite")).toBeNull();
  });


  it("garde le libellé du compte démo sans puce IA sur une suggestion manuelle", () => {
    mount([MAIL_SUGGESTIONS[2]]);

    expect(screen.queryByTestId("suggestion-ai")).toBeNull();
    expect(screen.getByTestId("suggestion-account").textContent).toBe("Studio");
  });
});

describe("planification · compteurs de filtres", () => {
  it("pose le compteur actif sur bg-ink/10", () => {
    mount(MAIL_SUGGESTIONS, []);
    const chip = screen.getByRole("button", { name: /^Tâches/ });

    expect(chip.getAttribute("aria-pressed")).toBe("true");
    const counter = chip.querySelector("span");
    expect(counter?.className).toContain("bg-ink/10");
    expect(counter?.className).not.toContain("bg-accent-contrast/25");
  });
});
