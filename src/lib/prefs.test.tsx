import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { PrefsProvider, usePrefs } from "@/lib/prefs";
import { DEFAULT_SUMMARY } from "@/lib/summary";

const mount = () =>
  renderHook(() => usePrefs(), {
    wrapper: ({ children }: { children: ReactNode }) => <PrefsProvider>{children}</PrefsProvider>,
  });

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

beforeEach(() => {
  window.localStorage.clear();
});

describe("préférences · résumés", () => {
  it("démarre sur les valeurs par défaut du moteur", () => {
    const { result } = mount();
    expect(result.current.summary).toEqual(DEFAULT_SUMMARY);
  });

  it("relit une configuration complète", () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({
        summary: {
          enabled: false,
          llmConsent: true,
          morningStart: 7,
          middayStart: 13,
          eveningStart: 19,
          lookbackHours: 12,
        },
      }),
    );

    const { result } = mount();
    expect(result.current.summary).toEqual({
      enabled: false,
      llmConsent: true,
      morningStart: 7,
      middayStart: 13,
      eveningStart: 19,
      lookbackHours: 12,
    });
  });

  it("ignore les valeurs invalides", () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({
        summary: {
          enabled: "oui",
          llmConsent: 1,
          morningStart: 99,
          middayStart: "13",
          eveningStart: -4,
          lookbackHours: 0,
        },
      }),
    );

    const { result } = mount();
    expect(result.current.summary).toEqual(DEFAULT_SUMMARY);
  });

  it("accepte une configuration partielle et borne la fenêtre", () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ summary: { middayStart: 13, lookbackHours: 900 } }),
    );

    const { result } = mount();
    expect(result.current.summary.middayStart).toBe(13);
    expect(result.current.summary.morningStart).toBe(DEFAULT_SUMMARY.morningStart);
    expect(result.current.summary.lookbackHours).toBe(72);
  });

  it("met à jour partiellement et persiste le résultat", () => {
    const { result } = mount();

    act(() => {
      result.current.setSummary({ llmConsent: true, eveningStart: 20 });
    });

    expect(result.current.summary.llmConsent).toBe(true);
    expect(result.current.summary.eveningStart).toBe(20);
    expect(result.current.summary.morningStart).toBe(DEFAULT_SUMMARY.morningStart);
    expect(stored().summary).toMatchObject({ llmConsent: true, eveningStart: 20 });
  });
});

describe("préférences · suggestions de réponse IA", () => {
  it("active le LLM par défaut et relit un réglage désactivé", () => {
    expect(mount().result.current.aiReplyEnabled).toBe(true);

    window.localStorage.setItem("lavande.prefs", JSON.stringify({ aiReplyEnabled: false }));
    const { result } = mount();
    expect(result.current.aiReplyEnabled).toBe(false);
  });

  it("ignore une valeur non booléenne et persiste le changement", () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ aiReplyEnabled: "non" }));
    const { result } = mount();
    expect(result.current.aiReplyEnabled).toBe(true);

    act(() => result.current.setAiReplyEnabled(false));
    expect(result.current.aiReplyEnabled).toBe(false);
    expect(stored().aiReplyEnabled).toBe(false);
  });
});
