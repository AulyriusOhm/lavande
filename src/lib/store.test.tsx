import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { PlanningProvider } from "@/lib/planning-store";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { PrefsProvider } from "@/lib/prefs";
import { MAIL_SUGGESTIONS, TASKS } from "@/lib/tasks";
import { promotedTaskId } from "@/lib/sync/merge";
import { createMemoryStorage } from "@/lib/sync/storage";

// Ce fichier teste les tâches et suggestions semées : il tourne en mode démo.
vi.stubEnv("VITE_MAIL_BACKEND", "demo");

function mount() {
  const storage = createMemoryStorage();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <PlanningProvider storage={storage}>
        <MailStoreProvider>{children}</MailStoreProvider>
      </PlanningProvider>
    </PrefsProvider>
  );
  return { storage, ...renderHook(() => useMailStore(), { wrapper }) };
}

describe("MailStoreProvider branché sur la planification", () => {
  it("expose les tâches et suggestions amorcées par le provider", () => {
    const { result } = mount();

    expect(result.current.tasks.map((task) => task.id).sort()).toEqual(TASKS.map((task) => task.id).sort());
    expect(result.current.suggestions).toHaveLength(MAIL_SUGGESTIONS.length);
    expect(result.current.suggestions.every((suggestion) => suggestion.id.startsWith("sg:"))).toBe(true);
  });

  it("propage setTasks jusqu'aux tâches exposées par le store", () => {
    const { result } = mount();

    act(() => {
      result.current.setTasks((current) =>
        current.map((task) => (task.id === "t10" ? { ...task, state: "review" as const } : task)),
      );
    });

    expect(result.current.tasks.find((task) => task.id === "t10")?.state).toBe("review");
    expect(result.current.tasks).toHaveLength(TASKS.length);
  });

  it("ajoute une tâche par promotion de suggestion et retire la suggestion", () => {
    const { result } = mount();
    const suggestion = result.current.suggestions[0];
    const taskId = promotedTaskId(suggestion.id);

    act(() => {
      result.current.addSuggestion(suggestion);
    });

    const created = result.current.tasks.find((task) => task.id === taskId);
    expect(created?.title).toBe(suggestion.proposal);
    expect(created?.mailId).toBe(suggestion.mailId);
    expect(result.current.suggestions.some((entry) => entry.id === suggestion.id)).toBe(false);
    expect(result.current.suggestions).toHaveLength(MAIL_SUGGESTIONS.length - 1);
    expect(result.current.notices.at(-1)?.message).toBe("Tâche ajoutée à la planification");
  });

  it("annule une promotion depuis la notification", () => {
    const { result } = mount();
    const suggestion = result.current.suggestions[0];
    const taskId = promotedTaskId(suggestion.id);

    act(() => {
      result.current.addSuggestion(suggestion);
    });

    const notice = result.current.notices.at(-1);
    expect(notice?.actionLabel).toBe("Annuler");

    act(() => {
      notice?.onAction?.();
    });

    expect(result.current.tasks.some((task) => task.id === taskId)).toBe(false);
    expect(result.current.suggestions.some((entry) => entry.id === suggestion.id)).toBe(true);
    expect(result.current.suggestions).toHaveLength(MAIL_SUGGESTIONS.length);
  });

  it("masque une suggestion sans toucher aux tâches", () => {
    const { result } = mount();
    const suggestion = result.current.suggestions[0];

    act(() => {
      result.current.dismissSuggestion(suggestion);
    });

    expect(result.current.suggestions.some((entry) => entry.id === suggestion.id)).toBe(false);
    expect(result.current.suggestions).toHaveLength(MAIL_SUGGESTIONS.length - 1);
    expect(result.current.tasks).toHaveLength(TASKS.length);
    expect(result.current.notices.at(-1)?.message).toBe("Suggestion masquée");
  });
});
