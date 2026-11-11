import { describe, expect, it, vi } from "vitest";
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
const rowIds = () => rows().map((row) => row.dataset.mailRow);
const selected = () => document.querySelector<HTMLElement>('[data-mail-row][aria-current="true"]');
const readerOpen = () => screen.queryByRole("button", { name: "Répondre" }) !== null;
const help = () => screen.queryByRole("dialog", { name: "Raccourcis clavier" });

async function openDesktop() {
  window.history.replaceState(null, "", "?desktop");
  render(<App />);
  await waitFor(() => expect(document.querySelector("[data-desktop]")).toBeTruthy(), { timeout: 5000 });
  await waitFor(() => expect(rows().length).toBeGreaterThan(2));
  return rowIds();
}

describe("navigation · liste des mails au clavier", () => {
  it("descend et remonte la sélection avec les flèches", async () => {
    const [first, second, third] = await openDesktop();
    expect(selected()).toBeNull();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => expect(selected()?.dataset.mailRow).toBe(first));

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => expect(selected()?.dataset.mailRow).toBe(second));

    fireEvent.keyDown(window, { key: "ArrowUp" });
    await waitFor(() => expect(selected()?.dataset.mailRow).toBe(first));

    fireEvent.keyDown(window, { key: "ArrowUp" });
    await waitFor(() => expect(selected()?.dataset.mailRow).toBe(first));
    expect(third).toBeDefined();
  });

  it("alias vim j et k sur la même sélection", async () => {
    const [first, second] = await openDesktop();

    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(selected()?.dataset.mailRow).toBe(first));

    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(selected()?.dataset.mailRow).toBe(second));

    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(selected()?.dataset.mailRow).toBe(first));
  });

  it("ouvre le message sélectionné avec Entrée, le ferme avec Échap et rend le focus à la liste", async () => {
    const [first] = await openDesktop();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => expect(selected()?.dataset.mailRow).toBe(first));

    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(readerOpen()).toBe(true));
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Panneau de lecture" }));

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(readerOpen()).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(selected()));
    expect(selected()?.dataset.mailRow).toBe(first);
  });

  it("ouvre le premier message quand aucune sélection n'existe", async () => {
    const [first] = await openDesktop();

    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(readerOpen()).toBe(true));
    await waitFor(() => expect(selected()?.dataset.mailRow).toBe(first));
  });

  it("ne navigue pas quand un champ de saisie a le focus", async () => {
    await openDesktop();
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();

    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "j" });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(selected()).toBeNull();
    expect(readerOpen()).toBe(false);
    field.remove();
  });

  it("conserve les raccourcis existants et les liste dans l'aide", async () => {
    await openDesktop();
    const [first] = rowIds();

    fireEvent.keyDown(window, { key: "/", ctrlKey: true });
    await waitFor(() => expect(help()).toBeTruthy());
    const dialog = help() as HTMLElement;
    expect(within(dialog).getAllByText("Message suivant")).toHaveLength(2);
    expect(within(dialog).getAllByText("Message précédent")).toHaveLength(2);
    expect(within(dialog).getByText("Ouvrir le message")).toBeTruthy();
    expect(within(dialog).getAllByText("↓")).toHaveLength(1);
    expect(within(dialog).getByText("Entrée")).toBeTruthy();
    fireEvent.keyDown(window, { key: "/", ctrlKey: true });
    await waitFor(() => expect(help()).toBeNull());

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => expect(selected()?.dataset.mailRow).toBe(first));

    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    await waitFor(() => expect(window.location.hash).toBe("#calendar"));


    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    await waitFor(() => expect(window.location.hash).toBe("#inbox"));
    await waitFor(() => expect(rows().length).toBeGreaterThan(2));

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Recherche globale" })).toBeTruthy());
  });
});
