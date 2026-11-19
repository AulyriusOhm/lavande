import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DesktopPlanning } from "@/desktop/planning";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import type { TaskState } from "@/lib/tasks";
import { LOCAL_SCHEMA_VERSION, docKey, type Doc } from "@/lib/sync/merge";
import { createDevice, createMemoryStorage, emptyState, type SyncStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

function taskDoc(id: string, title: string, state: TaskState, assignee?: string): Doc {
  return {
    id,
    kind: "task",
    v: LOCAL_SCHEMA_VERSION,
    raw: {
      title,
      meta: "manuel",
      state,
      due: "demain",
      dueTone: "soon",
      ...(assignee ? { assignee } : {}),
    },
    fields: {},
    readOnly: false,
    updatedAt: new Date(0).toISOString(),
  };
}

function seededStorage(docs: Doc[]): SyncStorage {
  const base = emptyState(createDevice("test", "test"));
  return createMemoryStorage({
    ...base,
    docs: Object.fromEntries(docs.map((doc) => [docKey(doc.kind, doc.id), doc])),
  });
}

function mount(storage: SyncStorage) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={storage}>
          <MailStoreProvider>{children}</MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>
  );
  return render(<DesktopPlanning onNewTask={() => {}} onOpenSync={() => {}} />, { wrapper });
}

function cardOf(title: string): HTMLElement {
  const card = screen.getAllByTestId("task-card").find((entry) => entry.textContent?.includes(title));
  if (!card) throw new Error(`carte introuvable : ${title}`);
  return card;
}

function titles(): string[] {
  return screen.getAllByTestId("task-card").map((card) => card.textContent ?? "");
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ keys: [] }) }) as unknown as Response),
  );
});

describe("Kanban PC · puce d'assigné", () => {
  it("affiche le nom de l'assigné sur la carte", () => {
    mount(seededStorage([taskDoc("a", "Relancer Marc", "todo", "Stéphane")]));

    const chip = cardOf("Relancer Marc").querySelector('[data-testid="assignee-chip"]');
    expect(chip?.textContent).toBe("Stéphane");
    expect(chip?.className).toContain("bg-accent-soft");
    expect(chip?.className).toContain("text-accent-ink");
  });

  it("n'affiche aucune puce sur une tâche sans assigné", () => {
    mount(seededStorage([taskDoc("a", "Relancer Marc", "todo")]));

    expect(cardOf("Relancer Marc").querySelector('[data-testid="assignee-chip"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Tous" })).toBeNull();
  });
});

describe("Kanban PC · filtre par assigné", () => {
  function threeTasks() {
    return seededStorage([
      taskDoc("a", "Relancer Marc", "todo", "Stéphane"),
      taskDoc("b", "Préparer la rétro", "todo", "Léa"),
      taskDoc("c", "Trier les factures", "todo"),
    ]);
  }

  it("liste une puce par assigné présent, plus « Tous »", () => {
    mount(threeTasks());
    const row = screen.getByRole("button", { name: "Tous" }).parentElement!;

    expect(within(row).getByRole("button", { name: /Stéphane/ })).toBeTruthy();
    expect(within(row).getByRole("button", { name: /Léa/ })).toBeTruthy();
    expect(within(row).getAllByRole("button")).toHaveLength(3);
  });

  it("restreint les colonnes à l'assigné sélectionné", () => {
    mount(threeTasks());

    expect(titles()).toHaveLength(3);
    fireEvent.click(screen.getByTestId("assignee-filter-Stéphane"));

    expect(screen.getByTestId("assignee-filter-Stéphane").getAttribute("aria-pressed")).toBe("true");
    expect(titles()).toHaveLength(1);
    expect(titles()[0]).toContain("Relancer Marc");

    fireEvent.click(screen.getByRole("button", { name: "Tous" }));

    expect(titles()).toHaveLength(3);
  });
});

describe("Panneau tâche PC · assigné", () => {
  it("enregistre l'assigné saisi dans le panneau", () => {
    mount(seededStorage([taskDoc("a", "Relancer Marc", "todo")]));

    fireEvent.click(cardOf("Relancer Marc"));
    fireEvent.change(screen.getByLabelText("Assignée à"), { target: { value: "Stéphane" } });

    expect(cardOf("Relancer Marc").querySelector('[data-testid="assignee-chip"]')?.textContent).toBe("Stéphane");
    expect(screen.getByTestId("assignee-filter-Stéphane")).toBeTruthy();
  });

  it("préremplit le champ et permet de retirer l'assigné", () => {
    mount(seededStorage([taskDoc("a", "Relancer Marc", "todo", "Stéphane")]));

    fireEvent.click(cardOf("Relancer Marc"));
    const field = screen.getByLabelText("Assignée à") as HTMLInputElement;
    expect(field.value).toBe("Stéphane");

    fireEvent.change(field, { target: { value: "" } });

    expect(cardOf("Relancer Marc").querySelector('[data-testid="assignee-chip"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Tous" })).toBeNull();
  });
});
