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
  it("pose le contenu dans une feuille opaque sous le haut uni", () => {
    const shell = renderNative();

    expect(shell).not.toBeNull();
    const sheet = shell!.querySelector<HTMLElement>(".native-sheet");
    expect(sheet).not.toBeNull();
    expect(sheet!.parentElement).toBe(shell);
    expect(sheet!.className).toContain("overflow-hidden");
  });

  it("peint le haut en canvas uni, sans bande ni coins", () => {
    const css = readFileSync(path.join(process.cwd(), "src/index.css"), "utf8");

    expect(css).not.toContain("--statusband");
    expect(css).toMatch(/\.native-shell \{[^}]*background-color: var\(--canvas\)/);
    expect(css).not.toContain(".native-shell::before");
    expect(css).not.toMatch(/\.native-sheet \{[^}]*border-radius/);
    expect(css).not.toContain("linear-gradient");
    expect(css).not.toContain("background-size");
    expect(css).toMatch(/\.native-sheet \{[^}]*background: var\(--canvas\)/);
  });
});
