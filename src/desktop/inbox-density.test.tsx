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

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

const previews = () =>
  document.querySelectorAll('[data-testid="desktop-inbox"] p.line-clamp-3').length;

const densityButton = () => screen.getByRole("button", { name: "Affichage compact" });

async function openDesktop() {
  window.history.replaceState(null, "", "?desktop");
  render(<App />);
  await waitFor(() => expect(document.querySelectorAll("[data-mail-row]").length).toBeGreaterThan(3), {
    timeout: 5000,
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("boîte de réception PC · densité", () => {
  it("bascule en compact depuis l'en-tête de la liste et masque les aperçus", async () => {
    await openDesktop();
    expect(previews()).toBeGreaterThan(0);
    expect(densityButton().getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(densityButton());

    await waitFor(() => expect(stored().mailDensity).toBe("compact"));
    expect(densityButton().getAttribute("aria-pressed")).toBe("true");
    expect(previews()).toBe(0);
    expect(screen.queryByText(/^\d+ messages$/)).toBeNull();
    expect(
      document.querySelectorAll('[data-testid="desktop-inbox"] span[class*="size-[28px]"]').length,
    ).toBeGreaterThanOrEqual(2);

    fireEvent.click(densityButton());

    await waitFor(() => expect(stored().mailDensity).toBe("cozy"));
    expect(previews()).toBeGreaterThan(0);
  });
});
