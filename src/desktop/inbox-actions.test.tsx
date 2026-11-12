import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "@/App";
import { MAILS } from "@/lib/mail";
import { threadsInFolder } from "@/lib/threads";

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
const rowIds = () => rows().map((row) => row.dataset.mailRow ?? "");
const selected = () => document.querySelector<HTMLElement>('[data-mail-row][aria-current="true"]');
const groupOf = (id: string) =>
  document.querySelector<HTMLElement>(`[data-mail-row="${id}"]`)?.parentElement ?? null;
const starLabel = (id: string) => {
  const group = groupOf(id);
  return group ? (within(group).queryByLabelText(/étoile/)?.getAttribute("aria-label") ?? null) : null;
};
const readLabel = (id: string) => {
  const group = groupOf(id);
  return group ? (within(group).queryByLabelText(/Marquer comme/)?.getAttribute("aria-label") ?? null) : null;
};
const composeTitle = () =>
  document.querySelector<HTMLElement>('[data-testid="desktop-compose"] h2')?.textContent ?? null;
const readerOpen = () => screen.queryByRole("button", { name: "Répondre" }) !== null;

const SINGLE = threadsInFolder(MAILS, "inbox").filter(
  (thread) => thread.messages.filter((message) => message.folder === "inbox").length === 1,
);

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

function singleIndex(ids: string[], rank: number) {
  const index = ids.indexOf(SINGLE[rank]?.id ?? "");
  expect(index).toBeGreaterThan(0);
  return index;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("boîte de réception · actions au clavier", () => {
  it("supprime le message sélectionné et avance la sélection", async () => {
    const ids = await openDesktop();
    const index = singleIndex(ids, 1);
    const target = await select(index);
    const next = ids[index + 1];

    fireEvent.keyDown(window, { key: "Delete" });

    await waitFor(() => expect(groupOf(target)).toBeNull());
    await waitFor(() => expect(selected()?.dataset.mailRow).toBe(next));
  });

  it("archive le message sélectionné", async () => {
    const ids = await openDesktop();
    const index = singleIndex(ids, 0);
    const target = await select(index);

    fireEvent.keyDown(window, { key: "e", ctrlKey: true });

    await waitFor(() => expect(groupOf(target)).toBeNull());
    await waitFor(() => expect(selected()?.dataset.mailRow).toBe(ids[index + 1]));
  });

  it("étoile puis bascule la lecture du message sélectionné", async () => {
    const ids = await openDesktop();
    const index = singleIndex(ids, 1);
    await select(index);
    const id = ids[index] ?? "";

    const starred = starLabel(id);
    fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(starLabel(id)).not.toBe(starred));

    const read = readLabel(id);
    fireEvent.keyDown(window, { key: "U", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(readLabel(id)).not.toBe(read));
  });

  it("répond puis transfère le message sélectionné", async () => {
    await openDesktop();
    await select(0);

    fireEvent.keyDown(window, { key: "R", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(composeTitle()).toBe("Répondre"));
  });

  it("transfère le message sélectionné", async () => {
    await openDesktop();
    await select(0);

    fireEvent.keyDown(window, { key: "F", ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(composeTitle()).toBe("Transférer"));
  });

  it("ne touche à rien sans message sélectionné", async () => {
    const ids = await openDesktop();

    fireEvent.keyDown(window, { key: "Delete" });
    fireEvent.keyDown(window, { key: "e", ctrlKey: true });
    fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });

    expect(rowIds()).toEqual(ids);
    expect(selected()).toBeNull();
    expect(composeTitle()).toBeNull();
  });

  it("ignore les actions depuis un champ de saisie", async () => {
    const ids = await openDesktop();
    await select(0);
    const id = ids[0] ?? "";
    const starred = starLabel(id);

    const field = document.createElement("input");
    document.body.append(field);
    field.focus();

    fireEvent.keyDown(field, { key: "Delete" });
    fireEvent.keyDown(field, { key: "S", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(field, { key: "e", ctrlKey: true });

    expect(rowIds()).toEqual(ids);
    expect(starLabel(id)).toBe(starred);
    field.remove();
  });

  it("agit aussi sur le message ouvert", async () => {
    const ids = await openDesktop();
    const index = singleIndex(ids, 1);
    const id = await select(index);

    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(readerOpen()).toBe(true));

    const starred = starLabel(id);
    fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(starLabel(id)).not.toBe(starred));

    fireEvent.keyDown(window, { key: "Delete" });

    await waitFor(() => expect(readerOpen()).toBe(false));
    await waitFor(() => expect(groupOf(id)).toBeNull());
    await waitFor(() => expect(selected()?.dataset.mailRow).toBe(ids[index + 1]));
  });

  it("liste les actions du message dans l'aide, même sans sélection", async () => {
    await openDesktop();

    fireEvent.keyDown(window, { key: "/", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Raccourcis clavier" });

    expect(within(dialog).getByText("Actions sur le message")).toBeTruthy();
    expect(within(dialog).getByText("Suppr")).toBeTruthy();
    expect(within(dialog).getByText("Suivre le message")).toBeTruthy();
    expect(within(dialog).getByText("Transférer")).toBeTruthy();
  });

  it("n'agit pas quand une couche est ouverte", async () => {
    const ids = await openDesktop();
    await select(0);
    const id = ids[0] ?? "";
    const starred = starLabel(id);

    fireEvent.keyDown(window, { key: "/", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Raccourcis clavier" })).toBeTruthy());

    fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "Delete" });

    expect(starLabel(id)).toBe(starred);
    expect(rowIds()).toEqual(ids);
  });
});
