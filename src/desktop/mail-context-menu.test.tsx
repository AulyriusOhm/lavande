import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-mail-row]"));
const row = (id: string) => document.querySelector<HTMLElement>(`[data-mail-row="${id}"]`);
const groupOf = (id: string) => row(id)?.parentElement ?? null;
const menu = () => screen.queryByRole("menu");
const items = () => (menu() ? within(menu()!).getAllByRole("menuitem").map((item) => item.textContent) : []);
const readerText = () =>
  document.querySelector<HTMLElement>('[aria-label="Panneau de lecture"]')?.textContent ?? "";
const composeTitle = () =>
  document.querySelector<HTMLElement>('[data-testid="desktop-compose"] h2')?.textContent ?? null;
const readLabel = (id: string) => {
  const group = groupOf(id);
  return group ? (within(group).queryByLabelText(/Marquer comme/)?.getAttribute("aria-label") ?? null) : null;
};

const MAQUETTES = "perso:t-maquettes";

async function openDesktop() {
  window.history.replaceState(null, "", "?desktop");
  render(<App />);
  await waitFor(() => expect(document.querySelector("[data-desktop]")).toBeTruthy(), { timeout: 5000 });
  await waitFor(() => expect(rows().length).toBeGreaterThan(3));
}

function rightClick(id: string) {
  const target = row(id);
  expect(target).not.toBeNull();
  fireEvent.contextMenu(target!, { clientX: 120, clientY: 200 });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("menu contextuel PC", () => {
  it("s'ouvre au clic droit sans ouvrir le message ni sélectionner la ligne", async () => {
    await openDesktop();
    expect(readerText()).toContain("Sélectionne un message");

    rightClick(MAQUETTES);

    expect(menu()).not.toBeNull();
    expect(items()[0]).toBe("Ouvrir");
    expect(readerText()).toContain("Sélectionne un message");
    expect(document.querySelector('[data-mail-row][aria-current="true"]')).toBeNull();
    expect(document.activeElement?.textContent).toBe("Ouvrir");
  });

  it("place le panneau au curseur, dans le viewport", async () => {
    await openDesktop();

    rightClick(MAQUETTES);

    const panel = menu()!;
    expect(panel.style.left).toBe("120px");
    expect(panel.style.top).toBe("200px");
  });

  it("répond au message depuis le panneau", async () => {
    await openDesktop();
    rightClick(MAQUETTES);

    fireEvent.click(within(menu()!).getByRole("menuitem", { name: "Répondre" }));

    await waitFor(() => expect(composeTitle()).toBe("Répondre"));
    expect(menu()).toBeNull();
  });

  it("archive le message et referme le panneau", async () => {
    await openDesktop();
    rightClick(MAQUETTES);

    fireEvent.click(within(menu()!).getByRole("menuitem", { name: "Archiver" }));

    await waitFor(() => expect(screen.getByText("Message archivé")).toBeTruthy());
    expect(menu()).toBeNull();
  });

  it("bascule un message lu en non lu", async () => {
    await openDesktop();
    const id = rows()
      .map((entry) => entry.dataset.mailRow ?? "")
      .find((entry) => readLabel(entry) === "Marquer comme non lu");
    expect(id).toBeDefined();

    rightClick(id!);
    fireEvent.click(within(menu()!).getByRole("menuitem", { name: "Marquer non lu" }));

    await waitFor(() => expect(readLabel(id!)).toBe("Marquer comme lu"));
  });

  it("se ferme sur Échap", async () => {
    await openDesktop();
    rightClick(MAQUETTES);
    expect(menu()).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(menu()).toBeNull());
  });

  it("se ferme au défilement", async () => {
    await openDesktop();
    rightClick(MAQUETTES);
    expect(menu()).not.toBeNull();

    fireEvent.scroll(window);

    await waitFor(() => expect(menu()).toBeNull());
  });

  it("se ferme au clic extérieur", async () => {
    await openDesktop();
    rightClick(MAQUETTES);
    expect(menu()).not.toBeNull();

    fireEvent.pointerDown(document.body);

    await waitFor(() => expect(menu()).toBeNull());
  });
});
