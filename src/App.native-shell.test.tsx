import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import App from "@/App";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile";

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

afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

function renderNative() {
  window.history.replaceState(null, "", "?app");
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: ANDROID_UA });
  render(<App />);
  return document.querySelector<HTMLElement>(".native-shell");
}

describe("coquille native", () => {
  it("pose le contenu dans une feuille arrondie sous la bande de statut", () => {
    const shell = renderNative();

    expect(shell).not.toBeNull();
    const sheet = shell!.querySelector<HTMLElement>(".native-sheet");
    expect(sheet).not.toBeNull();
    expect(sheet!.parentElement).toBe(shell);
    expect(sheet!.className).toContain("overflow-hidden");
  });

  it("déclare la bande fondue et les coins hauts dans les deux thèmes", () => {
    const css = readFileSync(path.join(process.cwd(), "src/index.css"), "utf8");

    expect(css.split("--statusband-top:").length - 1).toBe(2);
    expect(css).toContain("background-size: 100% var(--native-top)");
    expect(css).toContain(
      "linear-gradient(to bottom, var(--statusband-top), color-mix(in oklab, var(--statusband-top) 45%, var(--canvas)))",
    );
    expect(css).toMatch(/\.native-sheet \{[^}]*border-radius: 18px 18px 0 0/);
  });
});
