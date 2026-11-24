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

const previews = (clamp: 1 | 2) =>
  document.querySelectorAll(`[data-testid="desktop-inbox"] p.line-clamp-${clamp}`).length;

const densityButton = () => screen.getByRole("button", { name: "Affichage compact" });

const rowOf = (threadId: string) =>
  document.querySelector<HTMLElement>(`[data-mail-row="${threadId}"]`)?.parentElement ?? null;

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
  it("bascule en compact depuis l'en-tête de la liste et resserre la troisième ligne", async () => {
    await openDesktop();
    expect(previews(2)).toBeGreaterThan(0);
    expect(previews(1)).toBe(0);
    expect(densityButton().getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(densityButton());

    await waitFor(() => expect(stored().mailDensity).toBe("compact"));
    expect(densityButton().getAttribute("aria-pressed")).toBe("true");
    expect(previews(2)).toBe(0);
    expect(previews(1)).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: /Boîte de réception/ }).className).toContain("text-[15px]");
    expect(
      document.querySelectorAll('[data-testid="desktop-inbox"] span[class*="size-[28px]"]').length,
    ).toBeGreaterThanOrEqual(2);

    fireEvent.click(densityButton());

    await waitFor(() => expect(stored().mailDensity).toBe("cozy"));
    expect(previews(2)).toBeGreaterThan(0);
  });

  it("affiche un avatar de 40 px avec empilement en confort, 28 px en compact", async () => {
    await openDesktop();

    const cozyStack = rowOf("perso:t-maquettes")!.querySelectorAll('span[class*="size-[34px]"]');
    expect(cozyStack.length).toBe(2);

    fireEvent.click(densityButton());
    await waitFor(() => expect(stored().mailDensity).toBe("compact"));

    const compactStack = rowOf("perso:t-maquettes")!.querySelectorAll('span[class*="size-[28px]"]');
    expect(compactStack.length).toBe(2);
  });

  it("n'affiche ni pastille de messages ni pastille de pièces jointes", async () => {
    await openDesktop();

    expect(screen.queryByText(/^\d+ messages$/)).toBeNull();
    expect(screen.queryByText(/pièce.*jointe/i)).toBeNull();
    expect(rowOf("perso:t-maquettes")!.textContent).not.toContain("messages");

    fireEvent.click(densityButton());
    await waitFor(() => expect(stored().mailDensity).toBe("compact"));
    expect(screen.queryByText(/^\d+ messages$/)).toBeNull();
    expect(screen.queryByText(/pièce.*jointe/i)).toBeNull();
  });

  it("n'agrège plus les participants : la ligne porte l'expéditeur seul", async () => {
    await openDesktop();

    const row = rowOf("perso:t-maquettes")!;
    expect(row.textContent).toContain("Marc Delaunay");
    expect(row.textContent).not.toContain("Camille Rousseau, Marc Delaunay");
    expect(row.querySelector("[aria-label]")?.getAttribute("aria-label")).not.toContain("messages");
  });

  it("garde l'ombre teintée sur une carte non lue en confort, la retire en compact", async () => {
    await openDesktop();

    const bodyOf = (threadId: string) =>
      rowOf(threadId)!.querySelector<HTMLElement>('div[class*="pointer-events-none"]')!;

    expect(rowOf("perso:t-maquettes")!.className).toContain(
      "shadow-[0_10px_30px_-24px_var(--accent)]",
    );
    expect(bodyOf("perso:t-maquettes").className).toContain("px-3.5");
    expect(bodyOf("perso:t-maquettes").className).toContain("py-3");

    fireEvent.click(densityButton());
    await waitFor(() => expect(stored().mailDensity).toBe("compact"));

    expect(rowOf("perso:t-maquettes")!.className).not.toContain(
      "shadow-[0_10px_30px_-24px_var(--accent)]",
    );
    expect(bodyOf("perso:t-maquettes").className).toContain("px-3");
    expect(bodyOf("perso:t-maquettes").className).toContain("py-2");
  });

  it("masque la troisième ligne quand l'aperçu est coupé", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ mailPreview: "none" }));
    await openDesktop();

    expect(previews(2)).toBe(0);
    expect(previews(1)).toBe(0);
    expect(
      document.querySelectorAll('[data-testid="desktop-inbox"] p.line-clamp-2, [data-testid="desktop-inbox"] p.line-clamp-1')
        .length,
    ).toBe(0);
  });
});
