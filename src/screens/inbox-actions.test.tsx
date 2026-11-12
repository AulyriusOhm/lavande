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

if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-mail-row]"));
const rowIds = () => rows().map((row) => row.dataset.mailRow ?? "");
const selected = () => document.querySelector<HTMLElement>('[data-mail-row][aria-current="true"]');
const starLabel = (id: string) => {
  const row = document.querySelector<HTMLElement>(`[data-mail-row="${id}"]`);
  return row ? (within(row).queryByLabelText(/étoile/)?.getAttribute("aria-label") ?? null) : null;
};

const rowLabel = (id: string) => {
  const row = document.querySelector<HTMLElement>(`[data-mail-row="${id}"]`);
  return row?.querySelector<HTMLElement>('[role="button"]')?.getAttribute("aria-label") ?? null;
};

const SINGLE = threadsInFolder(MAILS, "inbox").filter(
  (thread) => thread.messages.filter((message) => message.folder === "inbox").length === 1,
);

async function openMobile() {
  window.history.replaceState(null, "", "?mobile");
  render(<App />);
  await waitFor(() => expect(rows().length).toBeGreaterThan(3), { timeout: 5000 });
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

describe("boîte de réception mobile · actions au clavier", () => {
  it("étoile le message sélectionné au clavier", async () => {
    const ids = await openMobile();
    const index = ids.indexOf(SINGLE[1]?.id ?? "");
    expect(index).toBeGreaterThan(0);
    await select(index);
    const id = ids[index] ?? "";

    const starred = starLabel(id);
    fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(starLabel(id)).not.toBe(starred));
  });

  it("n'agit pas sans sélection ni quand une couche est ouverte", async () => {
    const ids = await openMobile();
    const id = ids[0] ?? "";
    const starred = starLabel(id);

    fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });
    expect(starLabel(id)).toBe(starred);

    await select(0);
    fireEvent.keyDown(window, { key: "/", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Raccourcis clavier" })).toBeTruthy());

    const label = rowLabel(id);
    fireEvent.keyDown(window, { key: "U", ctrlKey: true, shiftKey: true });

    expect(rowLabel(id)).toBe(label);
    expect(starLabel(id)).toBe(starred);
  });
});
