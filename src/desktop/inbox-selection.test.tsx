import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "@/App";
import { MAILS } from "@/lib/mail";
import { threadsInFolder } from "@/lib/threads";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const SINGLE = threadsInFolder(MAILS, "inbox")
  .filter((thread) => thread.messages.filter((message) => message.folder === "inbox").length === 1)
  .map((thread) => thread.id);

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
const checked = () =>
  rows()
    .filter((row) => row.getAttribute("aria-pressed") === "true")
    .map((row) => row.dataset.mailRow ?? "");
const toolbar = () => screen.queryByRole("toolbar", { name: "Sélection multiple" });
const counter = () => toolbar()?.querySelector(".tabular-nums")?.textContent ?? null;
const barButton = (name: string) => within(toolbar() as HTMLElement).getByRole("button", { name });
const barLabels = () =>
  within(toolbar() as HTMLElement)
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));
const inbox = () => screen.getByTestId("desktop-inbox");
const readerOpen = () => screen.queryByRole("button", { name: "Répondre" }) !== null;

function folderButton(label: string) {
  const rail = inbox().querySelector("aside") as HTMLElement;
  const button = Array.from(rail.querySelectorAll<HTMLButtonElement>("button[aria-current]")).find(
    (entry) => entry.textContent?.startsWith(label),
  );
  if (!button) throw new Error(`Dossier introuvable : ${label}`);
  return button;
}

const countSettled = (value: number) =>
  waitFor(() => expect(counter()).toBe(String(value)), { timeout: 3000 });

async function openDesktop() {
  window.history.replaceState(null, "", "?desktop");
  render(<App />);
  await waitFor(() => expect(document.querySelector("[data-desktop]")).toBeTruthy(), { timeout: 5000 });
  await waitFor(() => expect(rows().length).toBeGreaterThan(3));
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("boîte de réception · sélection multiple", () => {
  it("bascule un fil au ctrl+clic et affiche la barre sans ouvrir le message", async () => {
    await openDesktop();
    const [first, second] = rowIds();

    fireEvent.click(rows()[0] as HTMLElement, { ctrlKey: true });
    await waitFor(() => expect(checked()).toEqual([first]));
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(counter()).toBe("1");
    expect(toolbar()?.textContent).toContain("sélectionné");
    expect(readerOpen()).toBe(false);

    fireEvent.click(rows()[1] as HTMLElement, { ctrlKey: true });
    await waitFor(() => expect(checked()).toEqual([first, second]));
    await countSettled(2);
    expect(toolbar()?.textContent).toContain("sélectionnés");

    fireEvent.click(rows()[0] as HTMLElement, { ctrlKey: true });
    await waitFor(() => expect(checked()).toEqual([second]));
    await countSettled(1);

    fireEvent.click(rows()[1] as HTMLElement, { ctrlKey: true });
    await waitFor(() => expect(toolbar()).toBeNull());
    expect(checked()).toEqual([]);
  });

  it("sélectionne la plage au shift+clic depuis l'ancre", async () => {
    await openDesktop();
    const ids = rowIds();

    fireEvent.click(rows()[0] as HTMLElement, { ctrlKey: true });
    fireEvent.click(rows()[3] as HTMLElement, { shiftKey: true });

    await waitFor(() => expect(checked()).toEqual(ids.slice(0, 4)));
    await countSettled(4);
  });

  it("sélectionne toute la liste au ctrl+A", async () => {
    await openDesktop();
    const ids = rowIds();

    fireEvent.keyDown(window, { key: "a", ctrlKey: true });

    await waitFor(() => expect(checked()).toEqual(ids));
    await countSettled(ids.length);
    expect(within(toolbar() as HTMLElement).queryByRole("button", { name: "Tout sélectionner" })).toBeNull();
  });

  it("remplit toute la liste depuis le bouton de la barre", async () => {
    await openDesktop();
    const ids = rowIds();

    fireEvent.click(rows()[0] as HTMLElement, { ctrlKey: true });
    await waitFor(() => expect(toolbar()).not.toBeNull());

    fireEvent.click(barButton("Tout sélectionner"));

    await waitFor(() => expect(checked()).toEqual(ids));
  });

  it("vide la sélection à Échap sans quitter la boîte", async () => {
    await openDesktop();

    fireEvent.click(rows()[0] as HTMLElement, { ctrlKey: true });
    await waitFor(() => expect(toolbar()).not.toBeNull());

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(toolbar()).toBeNull());
    expect(checked()).toEqual([]);
    expect(document.querySelector("[data-desktop]")).toBeTruthy();
  });

  it("vide la sélection au bouton Annuler de la barre", async () => {
    await openDesktop();

    fireEvent.click(rows()[0] as HTMLElement, { ctrlKey: true });
    await waitFor(() => expect(toolbar()).not.toBeNull());

    fireEvent.click(barButton("Annuler la sélection"));

    await waitFor(() => expect(toolbar()).toBeNull());
    expect(checked()).toEqual([]);
  });

  it("ouvre le message et vide la sélection au clic simple", async () => {
    await openDesktop();

    fireEvent.click(rows()[0] as HTMLElement, { ctrlKey: true });
    await waitFor(() => expect(toolbar()).not.toBeNull());

    fireEvent.click(rows()[2] as HTMLElement);

    await waitFor(() => expect(toolbar()).toBeNull());
    expect(checked()).toEqual([]);
    await waitFor(() => expect(readerOpen()).toBe(true));
  });

  it("vide la sélection au changement de dossier", async () => {
    await openDesktop();

    fireEvent.click(rows()[0] as HTMLElement, { ctrlKey: true });
    await waitFor(() => expect(toolbar()).not.toBeNull());

    fireEvent.click(folderButton("Archives"));

    await waitFor(() => expect(toolbar()).toBeNull());
    expect(checked()).toEqual([]);
  });

  it("adapte les actions de la barre au dossier courant", async () => {
    await openDesktop();

    fireEvent.click(rows()[0] as HTMLElement, { ctrlKey: true });
    await waitFor(() => expect(toolbar()).not.toBeNull());

    const labels = barLabels();
    expect(labels).toContain("Archiver");
    expect(labels).toContain("Corbeille");
    expect(labels).toContain("Tout sélectionner");
    expect(labels).toContain("Annuler la sélection");
    expect(labels.some((label) => label === "Marquer lu" || label === "Marquer non lu")).toBe(true);
    expect(labels.some((label) => label === "Étoiler" || label === "Retirer les étoiles")).toBe(true);

    fireEvent.click(barButton("Corbeille"));
    await waitFor(() => expect(toolbar()).toBeNull());

    fireEvent.click(folderButton("Corbeille"));
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));

    fireEvent.click(rows()[0] as HTMLElement, { ctrlKey: true });
    await waitFor(() => expect(toolbar()).not.toBeNull());

    const trashLabels = barLabels();
    expect(trashLabels).toContain("Restaurer");
    expect(trashLabels).toContain("Supprimer définitivement");
    expect(trashLabels).not.toContain("Archiver");
  });

  it("archive depuis la barre les fils sélectionnés puis vide la sélection", async () => {
    await openDesktop();
    fireEvent.click(screen.getByRole("button", { name: /^Perso/ }));
    await waitFor(() => expect(rowIds().every((id) => id.startsWith("perso:"))).toBe(true));
    fireEvent.click(folderButton("Boîte de réception"));
    await waitFor(() => expect(rowIds().filter((id) => SINGLE.includes(id)).length).toBeGreaterThan(1));

    const indexes = rowIds()
      .map((id, index) => (SINGLE.includes(id) ? index : -1))
      .filter((index) => index >= 0)
      .slice(0, 2);
    const targets = indexes.map((index) => rowIds()[index]);

    fireEvent.click(rows()[indexes[0] as number] as HTMLElement, { ctrlKey: true });
    fireEvent.click(rows()[indexes[1] as number] as HTMLElement, { ctrlKey: true });
    await waitFor(() => expect(checked()).toEqual(targets));
    await countSettled(2);

    fireEvent.click(barButton("Archiver"));

    await waitFor(() => expect(toolbar()).toBeNull());
    await waitFor(() => expect(rowIds()).not.toContain(targets[0]));
    expect(rowIds()).not.toContain(targets[1]);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("archivés"));
  });
});
