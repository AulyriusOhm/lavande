import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopApp } from "@/desktop/desktop-shell";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { LOCAL_SCHEMA_VERSION, docKey, type Doc } from "@/lib/sync/merge";
import { createDevice, createMemoryStorage, emptyState, type SyncStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

function suggestionDoc(id: string, mailId: string): Doc {
  return {
    id,
    kind: "suggestion",
    v: LOCAL_SCHEMA_VERSION,
    raw: {
      status: "pending",
      mailId,
      account: "perso",
      from: "Camille",
      subject: "Maquettes v3",
      proposal: `Action ${id}`,
      due: "",
      dueTone: "none",
      tone: 0,
      description: "",
      ai: true,
    },
    fields: {},
    readOnly: false,
    updatedAt: new Date(0).toISOString(),
  };
}

function seededStorage(docs: Doc[]): SyncStorage {
  const base = emptyState(createDevice("test", "test"));
  return createMemoryStorage({
    ...base,
    docs: Object.fromEntries(docs.map((doc) => [docKey(doc.kind, doc.id), doc])),
  });
}

function Probe() {
  const { openMail, openMessage } = useMailStore();
  return (
    <>
      <span data-testid="open-mail">{openMail?.id ?? "aucun"}</span>
      <button type="button" onClick={() => openMessage("1")}>
        ouvrir-le-mail-1
      </button>
    </>
  );
}

function mount(docs: Doc[]) {
  window.location.hash = "#planning";
  const storage = seededStorage(docs);
  render(
    <>
      <Probe />
      <DesktopApp />
    </>,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <PrefsProvider>
          <ThemeProvider>
            <PlanningProvider storage={storage}>
              <MailStoreProvider>{children}</MailStoreProvider>
            </PlanningProvider>
          </ThemeProvider>
        </PrefsProvider>
      ),
    },
  );
}

const dockTab = (label: string): HTMLElement => {
  const tab = screen
    .getAllByRole("button")
    .find((button) => button.hasAttribute("aria-current") && button.textContent?.includes(label));
  if (!tab) throw new Error(`onglet introuvable : ${label}`);
  return tab;
};

const cardOf = (proposal: string): HTMLElement => {
  const card = screen.getAllByTestId("suggestion-card").find((entry) => entry.textContent?.includes(proposal));
  if (!card) throw new Error(`carte introuvable : ${proposal}`);
  return card;
};

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "?desktop");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ keys: [] }) }) as unknown as Response),
  );
});

afterEach(() => {
  window.location.hash = "";
});

describe("Planification desktop · ouvrir le mail lié", () => {
  it("revient à la boîte quand le mail lié est déjà le mail ouvert", async () => {
    mount([suggestionDoc("s-retour", "1")]);
    await waitFor(() => cardOf("Action s-retour"));

    fireEvent.click(screen.getByRole("button", { name: "ouvrir-le-mail-1" }));
    await waitFor(() => expect(dockTab("Boîte").getAttribute("aria-current")).toBe("true"));
    expect(screen.getByTestId("open-mail").textContent).toBe("1");

    fireEvent.click(dockTab("Planification"));
    await waitFor(() => expect(dockTab("Planification").getAttribute("aria-current")).toBe("true"));

    fireEvent.click(cardOf("Action s-retour").querySelector("button")!);
    fireEvent.click(await screen.findByText("Ouvrir le mail"));

    await waitFor(() => expect(dockTab("Boîte").getAttribute("aria-current")).toBe("true"));
    expect(screen.getByTestId("open-mail").textContent).toBe("1");
  });

  it("revient à la boîte quand aucun mail n'est encore ouvert", async () => {
    mount([suggestionDoc("s-neuf", "1")]);
    await waitFor(() => cardOf("Action s-neuf"));
    expect(screen.getByTestId("open-mail").textContent).toBe("aucun");

    fireEvent.click(cardOf("Action s-neuf").querySelector("button")!);
    fireEvent.click(await screen.findByText("Ouvrir le mail"));

    await waitFor(() => expect(dockTab("Boîte").getAttribute("aria-current")).toBe("true"));
    expect(screen.getByTestId("open-mail").textContent).toBe("1");
  });
});
