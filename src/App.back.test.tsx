import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { exit } from "@tauri-apps/plugin-process";
import App from "@/App";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const native = vi.hoisted(() => ({ handlers: [] as (() => void)[] }));

vi.mock("@tauri-apps/api/app", () => ({
  onBackButtonPress: (handler: () => void) => {
    native.handlers.push(handler);
    return Promise.resolve({ unregister: async () => {} });
  },
  getVersion: async () => "0.0.0-test",
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  exit: vi.fn(async () => {}),
  relaunch: vi.fn(async () => {}),
}));

const exitMock = vi.mocked(exit);

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (media: string) => ({
      media,
      matches: false,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-mail-row]"));
const rowButton = (id: string) =>
  document.querySelector<HTMLElement>(`[data-mail-row="${id}"]`)?.querySelector<HTMLElement>('[role="button"]') ??
  null;
const reader = () => screen.queryByLabelText("Retour");
const groupBack = () => screen.queryByRole("button", { name: "Retour aux réglages" });
const dockTab = (label: string) =>
  screen.getByRole("button", { name: label }).getAttribute("aria-current") === "true";

async function openNative() {
  window.history.replaceState(null, "", "?app");
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile",
  });
  render(<App />);
  await waitFor(() => expect(rows().length).toBeGreaterThan(3), { timeout: 5000 });
  await waitFor(() => expect(native.handlers.length).toBeGreaterThan(0));
}

const pressBack = () =>
  act(async () => {
    native.handlers[native.handlers.length - 1]?.();
    await Promise.resolve();
  });

beforeEach(() => {
  native.handlers.length = 0;
  window.localStorage.clear();
});

afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("bouton retour Android", () => {
  it("ferme le message ouvert sans quitter l'app", async () => {
    await openNative();

    fireEvent.click(rowButton(rows()[0].dataset.mailRow!)!);
    await waitFor(() => expect(reader()).not.toBeNull());

    await pressBack();

    await waitFor(() => expect(reader()).toBeNull());
    expect(exitMock).not.toHaveBeenCalled();
  });

  it("referme le détail des réglages sans quitter l'app", async () => {
    await openNative();

    fireEvent.click(screen.getByRole("button", { name: "Réglages" }));
    await waitFor(() => expect(dockTab("Réglages")).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: /^Apparence/ }));
    await waitFor(() => expect(groupBack()).not.toBeNull());

    await pressBack();

    await waitFor(() => expect(groupBack()).toBeNull());
    expect(exitMock).not.toHaveBeenCalled();
  });

  it("revient à la boîte de réception depuis un autre onglet", async () => {
    await openNative();

    fireEvent.click(screen.getByRole("button", { name: "Agenda" }));
    await waitFor(() => expect(dockTab("Agenda")).toBe(true));

    await pressBack();

    await waitFor(() => expect(dockTab("Boîte")).toBe(true));
    expect(exitMock).not.toHaveBeenCalled();
  });

  it("quitte l'app depuis la boîte de réception sans couche ouverte", async () => {
    await openNative();

    await pressBack();

    await waitFor(() => expect(exitMock).toHaveBeenCalledWith(0));
  });
});
