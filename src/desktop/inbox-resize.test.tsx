import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "@/App";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

type ChangeListener = (event: { matches: boolean; media: string }) => void;

const ORIGINAL_MATCH_MEDIA = window.matchMedia;
const ORIGINAL_INNER_WIDTH = window.innerWidth;

function installViewport(width: number) {
  const listeners = new Map<string, Set<ChangeListener>>();

  const matches = (media: string) => {
    const max = /max-width:\s*(\d+)px/.exec(media);
    if (max) return width <= Number(max[1]);
    const min = /min-width:\s*(\d+)px/.exec(media);
    if (min) return width >= Number(min[1]);
    return false;
  };

  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (media: string) => ({
      media,
      get matches() {
        return matches(media);
      },
      onchange: null,
      addEventListener: (type: string, listener: ChangeListener) => {
        if (type !== "change") return;
        const registered = listeners.get(media) ?? new Set<ChangeListener>();
        registered.add(listener);
        listeners.set(media, registered);
      },
      removeEventListener: (type: string, listener: ChangeListener) => {
        listeners.get(media)?.delete(listener);
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-mail-row]"));
const inbox = () => screen.getByTestId("desktop-inbox");
const separators = () => screen.getAllByRole("separator");
const railSplitter = () => screen.getByRole("separator", { name: "Largeur du rail de dossiers" });
const listSplitter = () => screen.getByRole("separator", { name: "Largeur de la liste des mails" });
const width = (handle: HTMLElement) => Number(handle.getAttribute("aria-valuenow"));
const columns = () => inbox().style.gridTemplateColumns;
const storedPanes = () =>
  (JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as { inboxPanes?: unknown })
    .inboxPanes;

function drag(handle: HTMLElement, from: number, to: number) {
  act(() => {
    fireEvent.pointerDown(handle, { button: 0, clientX: from, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: to, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: to, pointerId: 1 });
  });
}

async function openDesktop(viewport = 1600) {
  installViewport(viewport);
  window.history.replaceState(null, "", "?desktop");
  render(<App />);
  await waitFor(() => expect(document.querySelector("[data-desktop]")).toBeTruthy(), { timeout: 5000 });
  await waitFor(() => expect(rows().length).toBeGreaterThan(2));
}

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: ORIGINAL_MATCH_MEDIA,
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: ORIGINAL_INNER_WIDTH,
  });
  window.localStorage.clear();
});

describe("Boîte PC · colonnes redimensionnables", () => {
  it("pose deux poignées verticales entre les trois colonnes", async () => {
    await openDesktop();

    expect(inbox().dataset.tier).toBe("wide");
    expect(separators()).toHaveLength(2);
    for (const handle of separators()) {
      expect(handle.getAttribute("aria-orientation")).toBe("vertical");
      expect(handle.tabIndex).toBe(0);
      expect(handle.className).toContain("cursor-col-resize");
    }
    expect(width(railSplitter())).toBe(248);
    expect(width(listSplitter())).toBe(420);
    expect(columns()).toBe("248px 8px 420px 8px minmax(0px, 1fr)");
  });

  it("élargit le rail en glissant, et ne persiste qu'au relâchement", async () => {
    await openDesktop();
    const handle = railSplitter();
    window.localStorage.clear();

    act(() => {
      fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 340, pointerId: 1 });
    });

    expect(width(handle)).toBe(288);
    expect(columns()).toBe("288px 8px 420px 8px minmax(0px, 1fr)");
    expect(storedPanes()).toBeUndefined();
    expect(inbox().className).toContain("select-none");

    act(() => {
      fireEvent.pointerUp(handle, { clientX: 340, pointerId: 1 });
    });

    expect(inbox().className).not.toContain("select-none");
    expect(storedPanes()).toEqual({ rail: 288, list: 420 });
  });

  it("élargit la liste en glissant et range le lecteur à droite", async () => {
    await openDesktop();
    const handle = listSplitter();

    drag(handle, 700, 800);

    expect(width(handle)).toBe(520);
    expect(columns()).toBe("248px 8px 520px 8px minmax(0px, 1fr)");
    expect(storedPanes()).toEqual({ rail: 248, list: 520 });
  });

  it("borne les deux colonnes à leurs minima et maxima", async () => {
    await openDesktop();

    drag(railSplitter(), 400, 2000);
    expect(width(railSplitter())).toBe(480);

    drag(railSplitter(), 400, -2000);
    expect(width(railSplitter())).toBe(160);

    drag(listSplitter(), 700, 3000);
    expect(width(listSplitter())).toBe(1000);

    drag(listSplitter(), 700, -3000);
    expect(width(listSplitter())).toBe(260);
  });

  it("ramène le rail à son minimum de 160 px", async () => {
    await openDesktop();
    const handle = railSplitter();

    expect(handle.getAttribute("aria-valuemin")).toBe("160");

    drag(handle, 400, -2000);
    expect(width(handle)).toBe(160);
    expect(columns()).toBe("160px 8px 420px 8px minmax(0px, 1fr)");
    expect(storedPanes()).toEqual({ rail: 160, list: 420 });
  });

  it("laisse la liste monter à 1000 px sur un écran ultralarge", async () => {
    await openDesktop(3440);
    const handle = listSplitter();

    expect(handle.getAttribute("aria-valuemax")).toBe("1000");

    drag(handle, 700, 3000);
    expect(width(handle)).toBe(1000);
    expect(columns()).toBe("248px 8px 1000px 8px minmax(0px, 1fr)");
    expect(storedPanes()).toEqual({ rail: 248, list: 1000 });
  });

  it("garde au moins 240 px au lecteur : la liste cède avant lui", async () => {
    await openDesktop(1100);
    const handle = listSplitter();

    expect(handle.getAttribute("aria-valuemax")).toBe("596");

    drag(handle, 700, 2000);
    expect(width(handle)).toBe(596);
    expect(columns()).toBe("248px 8px 596px 8px minmax(0px, 1fr)");
  });

  it("revient au défaut de la colonne au double-clic", async () => {
    await openDesktop();

    drag(railSplitter(), 300, 380);
    drag(listSplitter(), 700, 760);
    expect(storedPanes()).toEqual({ rail: 328, list: 480 });

    act(() => {
      fireEvent.doubleClick(railSplitter());
    });
    expect(width(railSplitter())).toBe(248);
    expect(width(listSplitter())).toBe(480);
    expect(storedPanes()).toEqual({ rail: 248, list: 480 });

    act(() => {
      fireEvent.doubleClick(listSplitter());
    });
    expect(width(listSplitter())).toBe(420);
    expect(storedPanes()).toEqual({ rail: 248, list: 420 });

    drag(listSplitter(), 700, 700);
    expect(width(listSplitter())).toBe(420);
    expect(storedPanes()).toEqual({ rail: 248, list: 420 });
  });

  it("bouge au clavier de 16 px, borné, et persiste aussitôt", async () => {
    await openDesktop();
    const handle = railSplitter();

    act(() => handle.focus());
    expect(document.activeElement).toBe(handle);

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(width(handle)).toBe(264);
    expect(storedPanes()).toEqual({ rail: 264, list: 420 });

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(width(handle)).toBe(248);

    for (let press = 0; press < 10; press += 1) fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(width(handle)).toBe(160);
  });

  it("relit les largeurs rangées au démarrage", async () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ inboxPanes: { rail: 300, list: 512 } }),
    );
    await openDesktop();

    expect(width(railSplitter())).toBe(300);
    expect(width(listSplitter())).toBe(512);
    expect(columns()).toBe("300px 8px 512px 8px minmax(0px, 1fr)");
  });

  it("ignore des largeurs illisibles et retombe sur les défauts", async () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ inboxPanes: { rail: "large", list: null } }),
    );
    await openDesktop();

    expect(width(railSplitter())).toBe(248);
    expect(width(listSplitter())).toBe(420);
  });

  it("ne pose aucune poignée hors du tier large", async () => {
    await openDesktop(900);

    expect(inbox().dataset.tier).toBe("medium");
    expect(screen.queryAllByRole("separator")).toHaveLength(0);
    expect(inbox().style.gridTemplateColumns).toBe("");
  });
});
