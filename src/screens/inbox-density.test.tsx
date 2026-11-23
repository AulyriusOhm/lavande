import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "@/App";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

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

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

const previews = () => document.querySelectorAll('[data-mail-row] p.line-clamp-2').length;

const densityButton = () => screen.getByRole("button", { name: "Affichage compact" });

async function openMobile() {
  window.history.replaceState(null, "", "?mobile");
  render(<App />);
  await waitFor(() => expect(document.querySelectorAll("[data-mail-row]").length).toBeGreaterThan(3), {
    timeout: 5000,
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("boîte de réception mobile · densité", () => {
  it("bascule en compact depuis l'en-tête et masque les aperçus", async () => {
    await openMobile();
    expect(previews()).toBeGreaterThan(0);
    expect(densityButton().getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(densityButton());

    await waitFor(() => expect(stored().mailDensity).toBe("compact"));
    expect(densityButton().getAttribute("aria-pressed")).toBe("true");
    expect(previews()).toBe(0);
  });

  it("relit la densité enregistrée à l'ouverture", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ mailDensity: "compact" }));

    await openMobile();

    expect(densityButton().getAttribute("aria-pressed")).toBe("true");
    expect(previews()).toBe(0);
  });
});
