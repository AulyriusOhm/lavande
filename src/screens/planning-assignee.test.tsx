import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PlanningScreen } from "@/screens/planning-screen";
import { TaskScreen } from "@/screens/task-screen";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import type { Task } from "@/lib/tasks";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const TASKS: Task[] = [
  { id: "a", title: "Relancer Marc", meta: "manuel", state: "todo", due: "demain", dueTone: "soon", assignee: "Stéphane" },
  { id: "b", title: "Préparer la rétro", meta: "manuel", state: "todo", due: "demain", dueTone: "soon", assignee: "Léa" },
  { id: "c", title: "Trier les factures", meta: "manuel", state: "doing", due: "vendredi", dueTone: "soft" },
];

function wrapper({ children }: { children: ReactNode }) {
  return (
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>{children}</MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>
  );
}

function mountPlanning(tasks: Task[]) {
  return render(
    <PlanningScreen
      tasks={tasks}
      setTasks={() => {}}
      suggestions={[]}
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

describe("Planification mobile · puce d'assigné", () => {
  it("affiche le nom de l'assigné sur les cartes qui en ont un", () => {
    mountPlanning(TASKS);

    const chips = screen.getAllByTestId("assignee-chip").map((chip) => chip.textContent);
    expect(chips).toEqual(["Stéphane", "Léa"]);
    expect(screen.getAllByTestId("assignee-chip")[0].className).toContain("bg-accent-soft");
  });

  it("n'affiche ni puce ni filtre quand aucune tâche n'est assignée", () => {
    mountPlanning([TASKS[2]]);

    expect(screen.queryByTestId("assignee-chip")).toBeNull();
    expect(screen.queryByTestId("assignee-filter-Stéphane")).toBeNull();
  });
});

describe("Planification mobile · filtre par assigné", () => {
  it("croise le filtre d'assigné avec le filtre d'état", () => {
    mountPlanning(TASKS);

    fireEvent.click(screen.getByTestId("assignee-filter-Stéphane"));
    expect(screen.getByTestId("assignee-filter-Stéphane").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Relancer Marc")).toBeTruthy();
    expect(screen.queryByText("Préparer la rétro")).toBeNull();
    expect(screen.queryByText("Trier les factures")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^En cours/ }));
    expect(screen.queryByText("Relancer Marc")).toBeNull();
    expect(screen.getByText("Aucune tâche dans ce filtre.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^À faire/ }));
    expect(screen.getByText("Relancer Marc")).toBeTruthy();
    expect(screen.queryByText("Préparer la rétro")).toBeNull();

    fireEvent.click(screen.getByTestId("assignee-filter-Stéphane"));
    expect(screen.getByText("Préparer la rétro")).toBeTruthy();
  });
});

describe("Édition mobile · assigné", () => {
  it("enregistre l'assigné saisi", () => {
    const edited: Task[] = [];
    render(
      <TaskScreen
        task={TASKS[2]}
        onClose={() => {}}
        onOpenMail={() => {}}
        onEdit={(task) => edited.push(task)}
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole("button", { name: "Modifier la tâche" }));
    fireEvent.change(screen.getByLabelText("Assignée à"), { target: { value: " Stéphane " } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    expect(edited).toHaveLength(1);
    expect(edited[0].assignee).toBe("Stéphane");
    expect(edited[0].title).toBe("Trier les factures");
  });

  it("retire l'assigné quand le champ est vidé", () => {
    const edited: Task[] = [];
    render(
      <TaskScreen
        task={TASKS[0]}
        onClose={() => {}}
        onOpenMail={() => {}}
        onEdit={(task) => edited.push(task)}
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole("button", { name: "Modifier la tâche" }));
    fireEvent.change(screen.getByLabelText("Assignée à"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    expect(edited[0].assignee).toBeUndefined();
  });
});
