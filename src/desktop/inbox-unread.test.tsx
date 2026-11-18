import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
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
const card = (row: HTMLElement) => row.parentElement as HTMLElement;
const isUnread = (row: HTMLElement) => (row.getAttribute("aria-label") ?? "").includes("· non lu");
const pastille = (row: HTMLElement) =>
  card(row).querySelector<HTMLElement>(".bg-accent.rounded-full.border-surface");

async function openDesktop() {
  installViewport(1600);
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

describe("Boîte PC · mails non lus en carte accentuée", () => {
  it("accentue la carte et pose une pastille sur l'avatar des seuls non-lus", async () => {
    await openDesktop();

    const unread = rows().filter(isUnread);
    const read = rows().filter((row) => !isUnread(row));
    expect(unread.length).toBeGreaterThan(0);
    expect(read.length).toBeGreaterThan(0);

    for (const row of unread) {
      expect(card(row).className).toContain("border-accent-ring/60");
      expect(card(row).className).toContain("bg-surface");
      expect(pastille(row)).toBeTruthy();
    }

    for (const row of read) {
      expect(card(row).className).not.toContain("border-accent-ring/60");
      expect(card(row).className).toContain("border-transparent");
      expect(pastille(row)).toBeNull();
    }
  });

  it("garde la carte accentuée pour la ligne sélectionnée", async () => {
    await openDesktop();

    const target = rows().find((row) => !isUnread(row)) as HTMLElement;
    act(() => {
      fireEvent.click(target);
    });

    await waitFor(() => expect(target.getAttribute("aria-current")).toBe("true"));
    const selected = target;

    expect(card(selected).className).toContain("bg-accent-soft");
    expect(card(selected).className).toContain("ring-accent-ring");
    expect(card(selected).className).toContain("border-transparent");
    expect(pastille(selected)).toBeNull();
  });
});
