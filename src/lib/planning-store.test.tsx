import { StrictMode, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { PlanningProvider, suggestionsInWindow, usePlanning } from "@/lib/planning-store";
import { MAIL_SUGGESTIONS, TASKS } from "@/lib/tasks";
import type { MailSuggestion, Task } from "@/lib/tasks";
import { createTask } from "@/screens/new-task-sheet";
import { LOCAL_SCHEMA_VERSION, docKey, promotedTaskId, suggestionId, type Doc } from "@/lib/sync/merge";
import { createDevice, createMemoryStorage, emptyState, type SyncStorage } from "@/lib/sync/storage";

function wrapperFor(storage: SyncStorage) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <PlanningProvider storage={storage}>{children}</PlanningProvider>;
  };
}

function mount(storage: SyncStorage) {
  return renderHook(() => usePlanning(), { wrapper: wrapperFor(storage) });
}

function readOnlyStorage(): SyncStorage {
  const base = emptyState(createDevice("test", "test"));
  const doc: Doc = {
    id: "ro1",
    kind: "task",
    v: LOCAL_SCHEMA_VERSION + 1,
    raw: { title: "Tâche verrouillée", meta: "manuel", state: "todo", due: "demain", dueTone: "soon" },
    fields: {},
    readOnly: true,
    updatedAt: new Date(0).toISOString(),
  };
  return createMemoryStorage({ ...base, docs: { [docKey("task", "ro1")]: doc } });
}

describe("PlanningProvider", () => {
  it("rend les fixtures au premier montage", () => {
    const { result } = mount(createMemoryStorage());

    expect(result.current.tasks.map((task) => task.id).sort()).toEqual(TASKS.map((task) => task.id).sort());
    expect(result.current.suggestions).toHaveLength(MAIL_SUGGESTIONS.length);
    expect(result.current.tasks.find((task) => task.id === "t10")?.title).toBe("Valider la v3 pour la démo client");
    expect(result.current.tasks.find((task) => task.id === "t10")?.description).toContain("Camille");
    expect(result.current.readOnlyIds.size).toBe(0);
    expect(result.current.sync.phase).toBe("unconfigured");
  });

  it("n'injecte les fixtures qu'une fois sous StrictMode", () => {
    const storage = createMemoryStorage();
    const { result } = renderHook(() => usePlanning(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <StrictMode>
          <PlanningProvider storage={storage}>{children}</PlanningProvider>
        </StrictMode>
      ),
    });

    expect(result.current.tasks.map((task) => task.id).sort()).toEqual(TASKS.map((task) => task.id).sort());
    expect(result.current.suggestions).toHaveLength(MAIL_SUGGESTIONS.length);
    expect(Object.keys(storage.read().docs).filter((key) => key.startsWith("task:"))).toHaveLength(TASKS.length);
    expect(Object.keys(storage.read().docs).filter((key) => key.startsWith("suggestion:"))).toHaveLength(MAIL_SUGGESTIONS.length);
    expect(storage.read().outbox).toHaveLength(0);
  });

  it("setTasks bascule un état et le persiste pour un nouveau provider", () => {
    const storage = createMemoryStorage();
    const first = mount(storage);

    act(() => {
      first.result.current.setTasks((current) =>
        current.map((task) => (task.id === "t10" ? { ...task, state: "review" as const } : task)),
      );
    });

    expect(first.result.current.tasks.find((task) => task.id === "t10")?.state).toBe("review");
    expect(storage.read().docs[docKey("task", "t10")]?.raw.state).toBe("review");
    first.unmount();

    const second = mount(storage);
    expect(second.result.current.tasks.find((task) => task.id === "t10")?.state).toBe("review");
  });

  it("conserve une tâche créée avec createTask après remontage", () => {
    const storage = createMemoryStorage();
    const first = mount(storage);
    const nouvelle: Task = {
      id: "t-nouvelle",
      title: "Préparer la rétro",
      meta: "manuel",
      state: "todo",
      due: "demain",
      dueTone: "soon",
      dueDate: "2030-01-02",
    };

    act(() => {
      first.result.current.setTasks((current) => createTask(current, nouvelle));
    });

    expect(first.result.current.tasks.some((task) => task.id === "t-nouvelle")).toBe(true);
    first.unmount();

    const second = mount(storage);
    const reloaded = second.result.current.tasks.find((task) => task.id === "t-nouvelle");
    expect(reloaded).toEqual(nouvelle);
  });

  it("promouvoir la même suggestion sur deux appareils donne une seule tâche de même id", () => {
    const left = mount(createMemoryStorage());
    const right = mount(createMemoryStorage());
    const suggestion = left.result.current.suggestions[0];
    const expectedTaskId = promotedTaskId(suggestionId(`${suggestion.account}:${suggestion.mailId}`, suggestion.proposal));

    act(() => {
      left.result.current.addSuggestion(suggestion);
      right.result.current.addSuggestion(suggestion);
    });

    const leftTask = left.result.current.tasks.filter((task) => task.id === expectedTaskId);
    const rightTask = right.result.current.tasks.filter((task) => task.id === expectedTaskId);

    expect(leftTask).toHaveLength(1);
    expect(rightTask).toHaveLength(1);
    expect(leftTask[0].id).toBe(rightTask[0].id);
    expect(leftTask[0].title).toBe(suggestion.proposal);
    expect(leftTask[0].meta).toBe(`mail · ${suggestion.from}`);
    expect(leftTask[0].mailId).toBe(suggestion.mailId);
    expect(left.result.current.suggestions.some((entry) => entry.id === suggestion.id)).toBe(false);
    expect(right.result.current.suggestions.some((entry) => entry.id === suggestion.id)).toBe(false);
  });

  it("dismissSuggestion retire la suggestion sans la faire réapparaître", () => {
    const storage = createMemoryStorage();
    const first = mount(storage);
    const suggestion = first.result.current.suggestions[0];

    act(() => {
      first.result.current.dismissSuggestion(suggestion);
    });

    expect(first.result.current.suggestions.some((entry) => entry.id === suggestion.id)).toBe(false);
    expect(storage.read().docs[docKey("suggestion", suggestion.id)]?.raw.status).toBe("dismissed");
    expect(storage.read().docs[docKey("suggestion", suggestion.id)]?.deletedAt).toBeUndefined();
    first.unmount();

    const second = mount(storage);
    expect(second.result.current.suggestions.some((entry) => entry.id === suggestion.id)).toBe(false);
    expect(second.result.current.suggestions).toHaveLength(MAIL_SUGGESTIONS.length - 1);
  });

  it("refuse de muter une tâche marquée readOnly", () => {
    const storage = readOnlyStorage();
    const { result } = mount(storage);

    expect(result.current.readOnlyIds.has("ro1")).toBe(true);
    expect(result.current.tasks.find((task) => task.id === "ro1")?.state).toBe("todo");

    act(() => {
      result.current.setTasks((current) =>
        current.map((task) => (task.id === "ro1" ? { ...task, state: "done" as const } : task)),
      );
    });

    expect(result.current.tasks.find((task) => task.id === "ro1")?.state).toBe("todo");
    expect(storage.read().docs[docKey("task", "ro1")]?.raw.state).toBe("todo");
    expect(storage.read().outbox).toHaveLength(0);
  });

  it("pose un tombstone quand setTasks supprime une tâche", () => {
    const storage = createMemoryStorage();
    const first = mount(storage);

    act(() => {
      first.result.current.setTasks((current) => current.filter((task) => task.id !== "t7"));
    });

    expect(first.result.current.tasks.some((task) => task.id === "t7")).toBe(false);
    expect(storage.read().docs[docKey("task", "t7")]?.deletedAt).toBeTypeOf("string");
    first.unmount();

    const second = mount(storage);
    expect(second.result.current.tasks.some((task) => task.id === "t7")).toBe(false);
  });
});

describe("suggestions · fenêtre temporelle", () => {
  const H = 3_600_000;
  const now = Date.now();
  const suggestion = (id: string, timestamp?: number): MailSuggestion => ({
    id,
    mailId: `mail-${id}`,
    account: "perso",
    from: "Camille",
    subject: "Maquettes",
    proposal: `Action ${id}`,
    due: "sans échéance",
    dueTone: "soft",
    tone: 0,
    description: "",
    ...(timestamp === undefined ? {} : { timestamp }),
  });

  it("garde les suggestions sans horodatage et écarte celles hors fenêtre", () => {
    const list = [suggestion("demo"), suggestion("recente", now - 2 * H), suggestion("vieille", now - 60 * H)];

    expect(suggestionsInWindow(list, 48, now).map((entry) => entry.id)).toEqual(["demo", "recente"]);
    expect(suggestionsInWindow(list, 1, now).map((entry) => entry.id)).toEqual(["demo"]);
    expect(suggestionsInWindow(list, 999, now).map((entry) => entry.id)).toEqual(["demo", "recente", "vieille"]);
  });

  it("persiste l'horodatage du mail source avec la suggestion", () => {
    const storage = createMemoryStorage();
    const first = mount(storage);
    const proposed = suggestion("ia-tache", now - H);

    act(() => {
      first.result.current.proposeSuggestion(proposed);
    });

    const stored = first.result.current.suggestions.find((entry) => entry.proposal === proposed.proposal);
    expect(stored?.timestamp).toBe(now - H);
    const raw = Object.values(storage.read().docs).find((doc) => doc.raw.proposal === proposed.proposal);
    expect(raw?.raw.timestamp).toBe(now - H);
    first.unmount();

    const second = mount(storage);
    expect(second.result.current.suggestions.find((entry) => entry.proposal === proposed.proposal)?.timestamp).toBe(
      now - H,
    );
  });
});
