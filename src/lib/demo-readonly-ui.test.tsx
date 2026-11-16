import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.hoisted(() => {
  vi.stubEnv("VITE_MAIL_BACKEND", "demo");
  vi.stubEnv("VITE_DEMO_READONLY", "1");
});

import App from "@/App";

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
const rowIds = () => rows().map((row) => row.dataset.mailRow ?? "");
const selected = () => document.querySelector<HTMLElement>('[data-mail-row][aria-current="true"]');
const banner = () => document.querySelector<HTMLElement>("[data-demo-readonly]");

async function openDesktop() {
  window.history.replaceState(null, "", "?desktop");
  render(<App />);
  await waitFor(() => expect(document.querySelector("[data-desktop]")).toBeTruthy(), { timeout: 5000 });
  await waitFor(() => expect(rows().length).toBeGreaterThan(3));
  return rowIds();
}

async function select(index: number) {
  for (let step = 0; step <= index; step += 1) {
    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => expect(selected()).not.toBeNull());
  }
  return selected()?.dataset.mailRow ?? "";
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("démo lecture seule · coquille PC", () => {
  it("affiche le bandeau et masque le bouton de création", async () => {
    await openDesktop();

    expect(banner()?.textContent).toContain("Démo · données d'exemple");
    expect(screen.queryByRole("button", { name: "Nouveau message" })).toBeNull();
  });

  it("reste navigable : dossiers et vues", async () => {
    await openDesktop();

    fireEvent.click(screen.getByRole("button", { name: /Archives/ }));
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: /Réglages/ }));
    await waitFor(() => expect(document.querySelector("[data-desktop]")).toBeTruthy());
    expect(banner()).toBeTruthy();
  });

  it("masque les actions du lecteur et refuse la suppression au clavier", async () => {
    const ids = await openDesktop();
    await select(1);
    fireEvent.keyDown(window, { key: "Enter" });

    await waitFor(() => expect(document.querySelector("[data-desktop]")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Répondre" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Transférer" })).toBeNull();
    expect(screen.getAllByText("Démo · données d'exemple").length).toBeGreaterThan(0);

    fireEvent.keyDown(window, { key: "Delete" });
    fireEvent.keyDown(window, { key: "e", ctrlKey: true });
    fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });

    expect(rowIds()).toEqual(ids);
    await waitFor(() => expect(screen.getByText("Action indisponible dans la démo")).toBeTruthy());
  });

  it("garde la sélection et la lecture d'un message", async () => {
    await openDesktop();
    const id = await select(2);
    fireEvent.keyDown(window, { key: "Enter" });

    await waitFor(() => expect(document.querySelector("[data-desktop]")).toBeTruthy());
    expect(within(banner()!).getByText(/Démo · données d'exemple/)).toBeTruthy();
    expect(rows().some((row) => row.dataset.mailRow === id)).toBe(true);
  });

  it("ne garde que « Ouvrir » dans le menu contextuel", async () => {
    await openDesktop();
    const target = document.querySelector<HTMLElement>('[data-mail-row="perso:t-maquettes"]');
    expect(target).not.toBeNull();

    fireEvent.contextMenu(target!, { clientX: 100, clientY: 200 });

    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Ouvrir"]);
  });
});
