import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DesktopPlanning } from "@/desktop/planning";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { LOCAL_SCHEMA_VERSION, docKey, type Doc } from "@/lib/sync/merge";
import { createDevice, createMemoryStorage, emptyState, type SyncStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

function suggestionDoc(id: string, account: string, ai: boolean): Doc {
  return {
    id,
    kind: "suggestion",
    v: LOCAL_SCHEMA_VERSION,
    raw: {
      status: "pending",
      mailId: `mail-${id}`,
      account,
      from: "Camille",
      subject: "Maquettes v3",
      proposal: `Action ${id}`,
      due: "sans échéance",
      dueTone: "soft",
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
  return render(<DesktopPlanning onNewTask={() => {}} onOpenSync={() => {}} />, { wrapper });
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
});
