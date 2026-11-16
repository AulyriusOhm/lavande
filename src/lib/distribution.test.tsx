import { StrictMode, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, renderHook, screen } from "@testing-library/react";

// Verrou distribution : le flag est posé avant l'évaluation des modules, comme
// dans un build `VITE_DISTRIBUTION=1 npm run build`.
vi.hoisted(() => {
  vi.stubEnv("VITE_DISTRIBUTION", "1");
  vi.stubEnv("VITE_MAIL_BACKEND", "demo");
});

import { EVENTS, type CalendarEvent } from "@/lib/calendar";
import { DEFAULT_CALENDARS, loadCalendars } from "@/lib/calendars";
import { MAILS, RECENT_SEARCHES } from "@/lib/mail";
import { mailMode } from "@/lib/mail-backend";
import { PlanningProvider, usePlanning } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { createMemoryStorage } from "@/lib/sync/storage";
import { NewEventSheet } from "@/screens/new-event-sheet";
import { MAIL_SUGGESTIONS, TASKS } from "@/lib/tasks";

function mount() {
  return renderHook(() => usePlanning(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <PrefsProvider>
          <PlanningProvider storage={createMemoryStorage()}>{children}</PlanningProvider>
        </PrefsProvider>
      </StrictMode>
    ),
  });
}

describe("verrou distribution", () => {
  it("force le mode api même avec VITE_MAIL_BACKEND=demo", () => {
    expect(import.meta.env.VITE_MAIL_BACKEND).toBe("demo");
    expect(import.meta.env.VITE_DISTRIBUTION).toBe("1");
    expect(mailMode()).toBe("api");
  });

  it("purge les fixtures agenda, tâches et mails", () => {
    expect(EVENTS).toEqual([]);
    expect(TASKS).toEqual([]);
    expect(MAIL_SUGGESTIONS).toEqual([]);
    expect(MAILS).toEqual([]);
    expect(RECENT_SEARCHES).toEqual([]);
  });

  it("ne sème aucun calendrier de démonstration", () => {
    expect(DEFAULT_CALENDARS).toEqual([]);
    expect(loadCalendars()).toEqual([]);
  });

  it("ne sème ni tâches, ni suggestions, ni événements factices", () => {
    const { result } = mount();

    expect(result.current.tasks).toEqual([]);
    expect(result.current.suggestions).toEqual([]);
    expect(result.current.events).toEqual([]);
  });

  it("n'affiche aucune puce de calendrier et crée un rendez-vous sans calendrier", () => {
    const onCreate = vi.fn<(event: CalendarEvent) => void>();
    render(<NewEventSheet onClose={() => {}} onCreate={onCreate} />);

    expect(screen.queryByText("Calendrier")).toBeNull();
    for (const name of ["Perso", "Pro", "Gmail"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }

    fireEvent.change(screen.getByLabelText("Titre"), { target: { value: "Sans calendrier" } });
    fireEvent.click(screen.getByRole("button", { name: "Créer le rendez-vous" }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0][0].calendar).toBeUndefined();
  });
});
