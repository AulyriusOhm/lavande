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

const clampTwo = () => document.querySelectorAll("[data-mail-row] p.line-clamp-2").length;
const clampOne = () => document.querySelectorAll("[data-mail-row] p.line-clamp-1").length;

const densityButton = () => screen.getAllByRole("button", { name: "Affichage compact" })[0]!;

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
  it("bascule en compact depuis l'en-tête et resserre la troisième ligne", async () => {
    await openMobile();
    expect(clampTwo()).toBeGreaterThan(0);
    expect(clampOne()).toBe(0);
    expect(densityButton().getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(densityButton());

    await waitFor(() => expect(stored().mailDensity).toBe("compact"));
    expect(densityButton().getAttribute("aria-pressed")).toBe("true");
    expect(clampTwo()).toBe(0);
    expect(clampOne()).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: /réception/ }).className).toContain("text-[18px]");
  });

  it("garde le toggle dans la barre vitrée une fois l'en-tête replié", async () => {
    await openMobile();
    const toggles = screen.getAllByRole("button", { name: "Affichage compact" });
    expect(toggles.length).toBe(2);

    fireEvent.click(toggles[1]!);

    await waitFor(() => expect(stored().mailDensity).toBe("compact"));
  });

  it("relit la densité enregistrée à l'ouverture", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ mailDensity: "compact" }));

    await openMobile();

    expect(densityButton().getAttribute("aria-pressed")).toBe("true");
    expect(clampTwo()).toBe(0);
    expect(clampOne()).toBeGreaterThan(0);
  });

  it("n'affiche aucune troisième ligne quand l'aperçu est coupé", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ mailPreview: "none" }));

    await openMobile();

    expect(clampTwo()).toBe(0);
    expect(clampOne()).toBe(0);
    expect(document.querySelector('[data-mail-row] p.text-ink-muted')).toBeNull();
  });
});
