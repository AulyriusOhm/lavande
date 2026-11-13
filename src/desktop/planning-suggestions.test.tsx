import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DesktopPlanning } from "@/desktop/planning";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { LOCAL_SCHEMA_VERSION, docKey, type Doc } from "@/lib/sync/merge";
import { createDevice, createMemoryStorage, emptyState, type SyncStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

function suggestionDoc(id: string, account: string, ai: boolean, due = "", mailId = `mail-${id}`): Doc {
  return {
    id,
    kind: "suggestion",
    v: LOCAL_SCHEMA_VERSION,
    raw: {
      status: "pending",
      mailId,
      account,
      from: "Camille",
      subject: "Maquettes v3",
      proposal: `Action ${id}`,
      due,
      dueTone: due ? "soon" : "none",
      tone: 0,
      description: "",
      ...(ai ? { ai: true } : {}),
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
  const { openMail } = useMailStore();
  return <span data-testid="open-mail">{openMail?.id ?? "aucun"}</span>;
}

function mount(storage: SyncStorage) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={storage}>
          <MailStoreProvider>{children}</MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>
  );
  return render(
    <>
      <Probe />
      <DesktopPlanning onNewTask={() => {}} onOpenSync={() => {}} />
    </>,
    { wrapper },
  );
}

function cardOf(proposal: string): HTMLElement {
  const card = screen.getAllByTestId("suggestion-card").find((entry) => entry.textContent?.includes(proposal));
  if (!card) throw new Error(`carte introuvable : ${proposal}`);
  return card;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ keys: [] }) }) as unknown as Response),
  );
});

describe("Planification desktop · origine des suggestions", () => {
  it("affiche l'icône IA et le libellé du compte source", async () => {
    mount(seededStorage([suggestionDoc("s-ia", "pro", true)]));

    const card = cardOf("Action s-ia");
    expect(card.querySelector('[data-testid="suggestion-ai"]')).not.toBeNull();
    expect(card.querySelector('[data-testid="suggestion-account"]')?.textContent).toBe("Studio");
    expect(card.textContent).toContain("Camille");
    expect(card.textContent).toContain("Maquettes v3");
  });

  it("n'affiche pas l'icône sur une suggestion non-IA et retombe sur l'id inconnu", async () => {
    mount(seededStorage([suggestionDoc("s-main", "boite-x", false)]));

    const card = cardOf("Action s-main");
    expect(card.querySelector('[data-testid="suggestion-ai"]')).toBeNull();
    expect(card.querySelector('[data-testid="suggestion-account"]')?.textContent).toBe("boite-x");
  });

  it("ne rend ni badge ni légende quand la suggestion n'a pas d'échéance", async () => {
    mount(seededStorage([suggestionDoc("s-vide", "perso", false)]));

    const card = cardOf("Action s-vide");
    expect(card.querySelector('[data-testid="suggestion-due"]')).toBeNull();
    expect(card.textContent).not.toContain("sans échéance");
    expect(card.textContent).not.toContain("échéance déduite");
  });

  it("affiche la date seule, sans légende, quand l'échéance est réelle", async () => {
    mount(seededStorage([suggestionDoc("s-date", "perso", false, "vendredi")]));

    const card = cardOf("Action s-date");
    expect(card.querySelector('[data-testid="suggestion-due"]')?.textContent).toBe("vendredi");
    expect(card.textContent).not.toContain("échéance déduite");
  });
});

describe("Planification desktop · mail d'origine d'une suggestion", () => {
  it("ouvre le mail source directement depuis la carte", () => {
    mount(seededStorage([suggestionDoc("s-carte", "perso", true, "", "1")]));

    fireEvent.click(within(cardOf("Action s-carte")).getByRole("button", { name: /Voir le mail d'origine/ }));

    expect(screen.getByTestId("open-mail").textContent).toBe("1");
  });

  it("n'affiche pas de lien sur la carte quand le mail source est introuvable", () => {
    mount(seededStorage([suggestionDoc("s-orphelin", "perso", true)]));

    expect(within(cardOf("Action s-orphelin")).queryByRole("button", { name: /Voir le mail d'origine/ })).toBeNull();
  });

  it("ouvre le mail source depuis le détail d'une suggestion", async () => {
    mount(seededStorage([suggestionDoc("s-mail", "perso", true, "", "1")]));

    fireEvent.click(cardOf("Action s-mail").querySelector("button")!);
    fireEvent.click(await screen.findByText("Ouvrir le mail"));

    expect(screen.getByTestId("open-mail").textContent).toBe("1");
    expect(screen.queryByText("Suggestion issue d'un mail")).toBeNull();
  });

  it("n'affiche pas de lien quand le mail source est introuvable", async () => {
    mount(seededStorage([suggestionDoc("s-absent", "perso", true)]));

    fireEvent.click(cardOf("Action s-absent").querySelector("button")!);

    expect(await screen.findByText("Suggestion issue d'un mail")).toBeTruthy();
    expect(screen.queryByText("Ouvrir le mail")).toBeNull();
    expect(screen.getByTestId("open-mail").textContent).toBe("aucun");
  });
});

describe("Kanban PC · reflow", () => {
  it("défile horizontalement au lieu d'écraser les cinq colonnes", () => {
    mount(seededStorage([]));
    const kanban = screen.getByTestId("column-todo").parentElement!;

    expect(kanban.className).toContain("overflow-x-auto");
    expect(kanban.className).toContain("grid-cols-[repeat(5,minmax(220px,1fr))]");
    expect(kanban.className).not.toContain("grid-cols-5");
  });
});

describe("Kanban PC · colonnes", () => {
  it("nomme chaque état et compte les tâches qu'il contient", () => {
    mount(seededStorage([]));

    expect(within(screen.getByRole("region", { name: "À faire" })).getAllByTestId("task-card")).toHaveLength(2);
    expect(within(screen.getByRole("region", { name: "Fait" })).getAllByTestId("task-card")).toHaveLength(3);
    expect(within(screen.getByRole("region", { name: "En cours" })).getAllByTestId("task-card")).toHaveLength(1);
  });

  it("déplace une tâche d'une colonne à l'autre par glisser-déposer", () => {
    mount(seededStorage([]));

    const title = "Importer la clé PGP de Léa";
    const card = within(screen.getByTestId("column-todo"))
      .getAllByTestId("task-card")
      .find((entry) => entry.textContent?.includes(title))!;
    const dataTransfer = { setData: () => {}, getData: () => "t6", effectAllowed: "none" };

    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(screen.getByTestId("column-doing"), { dataTransfer });
    fireEvent.drop(screen.getByTestId("column-doing"), { dataTransfer });

    expect(within(screen.getByTestId("column-doing")).getByText(title)).toBeTruthy();
    expect(within(screen.getByTestId("column-todo")).queryByText(title)).toBeNull();
  });
});
