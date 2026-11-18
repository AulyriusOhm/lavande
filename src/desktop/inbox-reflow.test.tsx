import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "@/App";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

type ChangeListener = (event: { matches: boolean; media: string }) => void;

const ORIGINAL_MATCH_MEDIA = window.matchMedia;

function installViewport(width: number) {
  let current = width;
  const listeners = new Map<string, Set<ChangeListener>>();

  const matches = (media: string) => {
    const max = /max-width:\s*(\d+)px/.exec(media);
    if (max) return current <= Number(max[1]);
    const min = /min-width:\s*(\d+)px/.exec(media);
    if (min) return current >= Number(min[1]);
    return false;
  };

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

  return {
    resize(next: number) {
      current = next;
      act(() => {
        for (const [media, registered] of listeners) {
          for (const listener of registered) listener({ matches: matches(media), media });
        }
      });
    },
  };
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-mail-row]"));
const inbox = () => screen.getByTestId("desktop-inbox");
const scope = () => screen.queryByTestId("inbox-scope");
const foldersRail = () => screen.queryByRole("complementary");
const reader = () => screen.queryByRole("region", { name: "Panneau de lecture" });

async function openDesktop(width: number) {
  const viewport = installViewport(width);
  window.history.replaceState(null, "", "?desktop");
  render(<App />);
  await waitFor(() => expect(document.querySelector("[data-desktop]")).toBeTruthy(), { timeout: 5000 });
  await waitFor(() => expect(rows().length).toBeGreaterThan(2));
  return viewport;
}

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: ORIGINAL_MATCH_MEDIA,
  });
  window.localStorage.clear();
});

describe("Boîte PC · reflow aux points de rupture", () => {
  it("garde les trois colonnes au-dessus de 1100 px", async () => {
    await openDesktop(1440);

    expect(inbox().dataset.tier).toBe("wide");
    expect(inbox().style.gridTemplateColumns).toBe("248px 8px 420px 8px minmax(0px, 1fr)");
    expect(scope()).toBeNull();
    expect(foldersRail()).toBeTruthy();
  });

  it("passe à deux colonnes et range les dossiers dans un sélecteur entre 860 et 1100 px", async () => {
    await openDesktop(900);

    expect(inbox().dataset.tier).toBe("medium");
    expect(inbox().className).toContain("grid-cols-[minmax(0,360px)_minmax(0,1fr)]");
    expect(scope()).toBeTruthy();
    expect(screen.getByLabelText("Dossier")).toBeTruthy();
    expect(screen.getByLabelText("Compte")).toBeTruthy();
  });

  it("n'a plus de colonne à largeur nulle : le lecteur reste lisible en étroit", async () => {
    await openDesktop(760);

    expect(inbox().dataset.tier).toBe("narrow");
    expect(inbox().className).toContain("grid-cols-[minmax(0,1fr)]");
    expect(inbox().className).not.toContain("248px");
    expect(scope()).toBeTruthy();
  });

  it("ouvre le lecteur en plein écran sous 860 px, avec un retour vers la liste", async () => {
    await openDesktop(520);
    expect(reader()?.className).toContain("hidden");

    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Enter" });

    await waitFor(() => expect(reader()?.className).toContain("absolute inset-0"));
    expect(reader()?.className).not.toContain("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Revenir à la liste" }));
    await waitFor(() => expect(reader()?.className).toContain("hidden"));
  });

  it("suit le redimensionnement sans perdre la navigation au clavier", async () => {
    const viewport = await openDesktop(1440);
    const first = rows()[0]?.dataset.mailRow;

    for (const width of [1024, 900, 859, 640, 1100, 1280]) {
      viewport.resize(width);
      expect(inbox().dataset.tier, `largeur ${width}px`).toBe(
        width >= 1100 ? "wide" : width >= 860 ? "medium" : "narrow",
      );
      expect(rows().length, `largeur ${width}px`).toBeGreaterThan(2);
    }

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => expect(document.querySelector('[data-mail-row][aria-current="true"]')?.dataset.mailRow).toBe(first));
  });
});
