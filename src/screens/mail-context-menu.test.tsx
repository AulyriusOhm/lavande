import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "@/App";
import { haptic } from "@/lib/haptics";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");
vi.mock("@/lib/haptics", () => ({ haptic: vi.fn() }));

const hapticMock = vi.mocked(haptic);

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

const LONG_PRESS_MS = 500;

const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-mail-row]"));
const row = (id: string) => document.querySelector<HTMLElement>(`[data-mail-row="${id}"]`);
const rowButton = (id: string) => row(id)?.querySelector<HTMLElement>('[role="button"]') ?? null;
const menu = () => screen.queryByRole("menu");
const messageOpen = () => screen.queryByLabelText("Retour") !== null;

const MAQUETTES = "perso:t-maquettes";

async function openMobile() {
  window.history.replaceState(null, "", "?mobile");
  render(<App />);
  await waitFor(() => expect(rows().length).toBeGreaterThan(3), { timeout: 5000 });
}

async function hold(id: string) {
  const target = rowButton(id);
  expect(target).not.toBeNull();
  fireEvent.pointerDown(target!, { button: 0, clientX: 40, clientY: 300, pointerType: "touch" });
  await waitFor(() => expect(menu()).not.toBeNull(), { timeout: 3000 });
}

const longPressDone = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 300));
  });

beforeEach(() => {
  window.localStorage.clear();
});

describe("appui long mobile", () => {
  it("ouvre la feuille d'actions sans ouvrir le message", async () => {
    await openMobile();

    await hold(MAQUETTES);

    expect(menu()).not.toBeNull();
    expect(messageOpen()).toBe(false);
    expect(within(menu()!).getAllByRole("menuitem")[0]?.textContent).toBe("Ouvrir");
    expect(screen.getByRole("button", { name: "Annuler" })).toBeTruthy();
  });

  it("ne déplace pas le focus vers la feuille, l'arrière-plan ne défile pas", async () => {
    await openMobile();

    await hold(MAQUETTES);

    expect(menu()).not.toBeNull();
    expect(menu()!.contains(document.activeElement)).toBe(false);
  });

  it("n'ouvre pas le message au relâchement qui suit l'appui long", async () => {
    await openMobile();
    await hold(MAQUETTES);

    await act(async () => {
      fireEvent.pointerUp(rowButton(MAQUETTES)!);
      fireEvent.click(rowButton(MAQUETTES)!);
    });

    expect(messageOpen()).toBe(false);
    expect(menu()).not.toBeNull();
  });

  it("annule l'appui long dès que le doigt glisse", async () => {
    await openMobile();
    const target = rowButton(MAQUETTES)!;

    fireEvent.pointerDown(target, { button: 0, clientX: 40, clientY: 300, pointerType: "touch" });
    fireEvent.pointerMove(target, { clientX: 96, clientY: 302, pointerType: "touch" });
    await longPressDone();

    expect(menu()).toBeNull();
  });

  it("laisse le swipe et le clic de la ligne intacts", async () => {
    await openMobile();
    expect(document.querySelectorAll("[data-swipe]").length).toBeGreaterThan(3);

    const target = rowButton(MAQUETTES)!;
    fireEvent.pointerDown(target, { button: 0, clientX: 40, clientY: 300, pointerType: "touch" });
    fireEvent.pointerMove(target, { clientX: 130, clientY: 300, pointerType: "touch" });
    fireEvent.pointerUp(target, { clientX: 130, clientY: 300, pointerType: "touch" });
    await longPressDone();
    expect(menu()).toBeNull();

    fireEvent.click(target);

    await waitFor(() => expect(messageOpen()).toBe(true));
  });

  it("exécute une action puis referme la feuille", async () => {
    await openMobile();
    await hold(MAQUETTES);
    expect(hapticMock).toHaveBeenCalledWith("medium");

    fireEvent.click(within(menu()!).getByRole("menuitem", { name: "Archiver" }));

    await waitFor(() => expect(menu()).toBeNull());
    await waitFor(() => expect(screen.getByText("Message archivé")).toBeTruthy());
    expect(hapticMock).toHaveBeenCalledWith("light");
  });

  it("se ferme sur « Annuler »", async () => {
    await openMobile();
    await hold(MAQUETTES);

    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));

    await waitFor(() => expect(menu()).toBeNull());
  });
});
