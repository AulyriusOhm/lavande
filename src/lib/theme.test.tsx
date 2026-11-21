import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { ThemeProvider } from "./theme";

const STORAGE_KEY = "lavande.theme";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8)";
const ORIGINAL_MATCH_MEDIA = window.matchMedia;
const ORIGINAL_USER_AGENT = window.navigator.userAgent;

const tauri = vi.hoisted(() => {
  type Theme = "light" | "dark";
  type Handler = (event: { payload: Theme }) => void;
  const state = {
    theme: "light" as Theme,
    handlers: [] as Handler[],
    unlistened: 0,
  };
  return {
    state,
    api: {
      getCurrentWindow: () => ({
        theme: async () => state.theme,
        onThemeChanged: async (handler: Handler) => {
          state.handlers.push(handler);
          return () => {
            state.unlistened += 1;
          };
        },
      }),
    },
  };
});

vi.mock("@tauri-apps/api/window", () => tauri.api);

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function stubMatches(initial: boolean) {
  const query = { matches: initial, listeners: new Set<() => void>() };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (media: string) => ({
      media,
      get matches() {
        return query.matches;
      },
      addEventListener: (_type: string, listener: () => void) => query.listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => query.listeners.delete(listener),
    }),
  });
  return (matches: boolean) => {
    query.matches = matches;
    for (const listener of [...query.listeners]) listener();
  };
}

function stubUserAgent(value: string) {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value });
}

function stubTauriShell() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
}

function storeMode(mode: "light" | "dark" | "auto") {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode }));
}

function mount() {
  return render(
    <ThemeProvider>
      <span />
    </ThemeProvider>,
  );
}

function isDark() {
  return document.documentElement.classList.contains("dark");
}

describe("thème auto", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    tauri.state.theme = "light";
    tauri.state.handlers.length = 0;
    tauri.state.unlistened = 0;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({});
  });

  afterEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: ORIGINAL_MATCH_MEDIA,
    });
    stubUserAgent(ORIGINAL_USER_AGENT);
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("suit un système sombre", () => {
    stubMatches(true);
    storeMode("auto");
    mount();
    expect(isDark()).toBe(true);
  });

  it("suit un système clair", () => {
    stubMatches(false);
    storeMode("auto");
    mount();
    expect(isDark()).toBe(false);
  });

  it("réagit au changement du thème système", () => {
    const flip = stubMatches(false);
    storeMode("auto");
    mount();
    expect(isDark()).toBe(false);
    act(() => flip(true));
    expect(isDark()).toBe(true);
    act(() => flip(false));
    expect(isDark()).toBe(false);
  });

  it("n'écoute plus le système hors mode auto", () => {
    const flip = stubMatches(false);
    storeMode("light");
    mount();
    act(() => flip(true));
    expect(isDark()).toBe(false);
  });

  it("garde le mode clair manuel malgré un système sombre", () => {
    stubMatches(true);
    storeMode("light");
    mount();
    expect(isDark()).toBe(false);
  });

  it("garde le mode sombre manuel malgré un système clair", () => {
    stubMatches(false);
    storeMode("dark");
    mount();
    expect(isDark()).toBe(true);
  });

  it("retombe sur clair quand aucune source n'est disponible", () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: undefined });
    storeMode("auto");
    mount();
    expect(isDark()).toBe(false);
  });

  it("en coquille Tauri de bureau, suit l'API thème Tauri", async () => {
    stubMatches(false);
    stubTauriShell();
    tauri.state.theme = "dark";
    storeMode("auto");
    mount();
    await waitFor(() => expect(isDark()).toBe(true));
    await waitFor(() => expect(tauri.state.handlers).toHaveLength(1));
    act(() => tauri.state.handlers[0]!({ payload: "light" }));
    expect(isDark()).toBe(false);
  });

  it("en coquille Android, ignore l'API Tauri (toujours claire) et suit matchMedia", async () => {
    stubUserAgent(ANDROID_UA);
    stubTauriShell();
    const flip = stubMatches(true);
    tauri.state.theme = "light";
    storeMode("auto");
    mount();
    expect(isDark()).toBe(true);
    act(() => flip(false));
    expect(isDark()).toBe(false);
    expect(tauri.state.handlers).toHaveLength(0);
  });

  it("annonce le thème aux barres système en coquille Android", async () => {
    stubUserAgent(ANDROID_UA);
    stubTauriShell();
    stubMatches(false);
    storeMode("dark");
    mount();

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("plugin:lavandeuibars|set_bars_appearance", { dark: true }),
    );
  });

  it("suit les bascules système en mode auto pour les barres système", async () => {
    stubUserAgent(ANDROID_UA);
    stubTauriShell();
    const flip = stubMatches(false);
    storeMode("auto");
    mount();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenLastCalledWith("plugin:lavandeuibars|set_bars_appearance", {
        dark: false,
      }),
    );

    act(() => flip(true));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenLastCalledWith("plugin:lavandeuibars|set_bars_appearance", {
        dark: true,
      }),
    );
  });

  it("ne touche pas aux barres système dans le navigateur ni en coquille de bureau", async () => {
    stubMatches(false);
    storeMode("dark");
    mount();

    stubTauriShell();
    mount();

    expect(invokeMock).not.toHaveBeenCalled();
  });
});
