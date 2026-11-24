import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThreadRow } from "@/components/thread-row";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import { MAILS } from "@/lib/mail";
import { threadsInFolder } from "@/lib/threads";
import type { MailDensity, MailPreview, MailPreviewStyle } from "@/lib/prefs";
import type { MailDecision } from "@/lib/decision";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const THREAD = threadsInFolder(MAILS, "inbox")[0]!;
const PGP_THREAD = threadsInFolder(MAILS, "inbox").find((entry) => entry.primary.pgp !== "none")!;
const PREVIEW = THREAD.preview;
const OTHER_PARTICIPANT = THREAD.participants.find((name) => name !== THREAD.primary.name)!;
const AGGREGATED_NAME = THREAD.participants.slice(0, 2).join(", ");

const DECISION: MailDecision = {
  accountId: THREAD.primary.account,
  folderPath: "INBOX",
  uid: 42,
  contentHash: "hash-test",
  schemaVersion: 1,
  model: "mammoth-1",
  category: "important",
  categoryConf: 0.96,
  categoryProbs: { important: 0.96 },
  urgency: 2.3,
  needsReply: 0.9,
  hasTask: 0.88,
  hasEvent: 0,
  security: "safe",
  securityConf: 0.98,
  cleanupScore: 0.02,
  decidedAt: 1,
  source: "local",
};

const PHISHING: MailDecision = { ...DECISION, security: "phishing", securityConf: 0.99 };
const PHRASE = "Avenant signé : confirmer le lancement de la phase 2 lundi.";

function enableDecisionLayer() {
  window.localStorage.setItem(
    "lavande.prefs",
    JSON.stringify({
      decision: {
        enabled: true,
        endpoint: "https://decision.test/v1/systemone",
        model: "mammoth-1",
        apiKey: "nw-test",
        authHeader: "bearer",
      },
    }),
  );
}

type RowOptions = {
  density?: MailDensity;
  preview?: MailPreview;
  previewStyle?: MailPreviewStyle;
  decision?: MailDecision | null;
  decisionPending?: boolean;
  thread?: typeof THREAD;
  showAccount?: boolean;
};

function renderRow(options: RowOptions = {}) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>{children}</MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>
  );
  render(
    <ThreadRow
      thread={options.thread ?? THREAD}
      density={options.density}
      preview={options.preview}
      previewStyle={options.previewStyle}
      decision={options.decision}
      decisionPending={options.decisionPending}
      showAccount={options.showAccount}
      onOpen={() => {}}
      onToggleStar={() => {}}
    />,
    { wrapper },
  );
}

function rowOf() {
  const row = document.querySelector<HTMLElement>('[role="button"][aria-label*=" — "]');
  if (!row) throw new Error("ligne de mail introuvable");
  return row;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("ligne de mail · densité", () => {
  it("garde l'aperçu et l'avatar large en mode confort", () => {
    renderRow({ density: "cozy", preview: "excerpt" });

    expect(screen.getByText(PREVIEW)).toBeTruthy();
    expect(rowOf().className).toContain("py-3");
    expect(rowOf().className).toContain("rounded-[22px]");
    expect(rowOf().querySelector("p.line-clamp-2")).toBeTruthy();
  });

  it("garde la troisième ligne en compact, sur une seule ligne", () => {
    renderRow({ density: "compact", preview: "excerpt" });

    expect(screen.getByText(PREVIEW)).toBeTruthy();
    expect(rowOf().className).toContain("py-2");
    expect(rowOf().className).toContain("rounded-[22px]");
    expect(rowOf().querySelector("p.line-clamp-1")).toBeTruthy();
    expect(rowOf().querySelector("p.line-clamp-2")).toBeNull();
    expect(screen.getByText(THREAD.subject)).toBeTruthy();
  });

  it("n'affiche plus de pastilles messages ou pièces jointes, dans aucune densité", () => {
    renderRow({ density: "cozy", preview: "excerpt" });
    expect(screen.queryByText(/messages/)).toBeNull();
    expect(screen.queryByText(/pièce.*jointe/)).toBeNull();

    renderRow({ density: "compact", preview: "excerpt" });
    expect(screen.queryByText(/messages/)).toBeNull();
    expect(screen.queryByText(/pièce.*jointe/)).toBeNull();
  });

  it("n'affiche que l'expéditeur du dernier message, sans agréger les participants", () => {
    renderRow({ density: "cozy", preview: "excerpt" });

    expect(screen.getAllByText(THREAD.primary.name).length).toBeGreaterThan(0);
    expect(screen.queryByText(AGGREGATED_NAME)).toBeNull();
    expect(screen.queryByText(new RegExp(OTHER_PARTICIPANT))).toBeNull();
  });

  it("garde l'empilement d'avatars des conversations visible en compact", () => {
    renderRow({ density: "compact", preview: "excerpt" });

    expect(rowOf().querySelectorAll('span[class*="size-[32px]"]').length).toBe(2);
  });

  it("garde l'empilement d'avatars des conversations en confort", () => {
    renderRow({ density: "cozy", preview: "excerpt" });

    expect(rowOf().querySelectorAll('span[class*="size-[42px]"]').length).toBe(2);
  });

  it("n'affiche aucune troisième ligne quand l'aperçu est coupé", () => {
    renderRow({ density: "cozy", preview: "none" });

    expect(screen.queryByText(PREVIEW)).toBeNull();
    expect(screen.getByText(THREAD.subject)).toBeTruthy();
  });

  it("réduit l'étiquette de compte sous l'avatar en compact", () => {
    renderRow({ density: "cozy", preview: "excerpt", showAccount: true });
    expect(rowOf().querySelector("[data-account-chip]")!.className).toContain("text-[10.5px]");
  });

  it("étiquette de compte compacte en mode compact", () => {
    renderRow({ density: "compact", preview: "excerpt", showAccount: true });
    expect(rowOf().querySelector("[data-account-chip]")!.className).toContain("text-[8px]");
  });

  it("en compact, le badge PGP rejoint la ligne du nom sans ligne vide", () => {
    renderRow({ density: "compact", preview: "excerpt", thread: PGP_THREAD });

    expect(rowOf().querySelector('div[class*="mt-1.5"]')).toBeNull();
    expect(rowOf().querySelector('span[title*="PGP"]')).toBeTruthy();
  });

  it("en confort, le badge PGP garde sa ligne dédiée", () => {
    renderRow({ density: "cozy", preview: "excerpt", thread: PGP_THREAD });

    expect(rowOf().querySelector('div[class*="mt-1.5"]')).toBeTruthy();
  });
});

describe("ligne de mail · description du modèle", () => {
  it("garde l'aperçu du message quand le modèle de décision n'est pas configuré", () => {
    renderRow({ density: "cozy", preview: "ai", decision: DECISION });

    expect(screen.getByText(PREVIEW)).toBeTruthy();
    expect(screen.getByText("Urgent")).toBeTruthy();
    expect(rowOf().querySelector(".lucide-sparkles")).toBeNull();
  });

  it("remplace l'aperçu par la description en signaux", () => {
    enableDecisionLayer();
    renderRow({ density: "cozy", preview: "ai", decision: DECISION });

    expect(screen.getByText("Urgent · Réponse attendue · Tâche détectée")).toBeTruthy();
    expect(screen.queryByText(PREVIEW)).toBeNull();
    expect(rowOf().querySelector(".lucide-sparkles")).toBeTruthy();
  });

  it("préfère la phrase du modèle en style phrase", () => {
    enableDecisionLayer();
    renderRow({
      density: "cozy",
      preview: "ai",
      previewStyle: "phrase",
      decision: { ...DECISION, description: PHRASE },
    });

    expect(screen.getByText(PHRASE)).toBeTruthy();
  });

  it("garde l'alerte sécurité en tête et en rose", () => {
    enableDecisionLayer();
    renderRow({ density: "cozy", preview: "ai", decision: PHISHING });

    const line = screen.getByText(/Hameçonnage détecté/);
    expect(line.className).toContain("text-rose-700");
  });

  it("ne garde que le badge Suspect quand la description porte les signaux", () => {
    enableDecisionLayer();
    renderRow({ density: "cozy", preview: "ai", decision: PHISHING });

    expect(screen.getByText("Suspect")).toBeTruthy();
    expect(screen.queryByText("Urgent")).toBeNull();
    expect(screen.queryByText("À répondre")).toBeNull();
  });

  it("garde tous les badges quand la troisième ligne est l'extrait", () => {
    enableDecisionLayer();
    renderRow({ density: "cozy", preview: "excerpt", decision: DECISION });

    expect(screen.getByText("Urgent")).toBeTruthy();
    expect(screen.getByText("À répondre")).toBeTruthy();
  });

  it("annonce l'analyse en cours tant que la décision n'est pas revenue", () => {
    enableDecisionLayer();
    renderRow({ density: "cozy", preview: "ai", decisionPending: true });

    expect(screen.getByText("Analyse en cours…")).toBeTruthy();
    expect(screen.queryByText(PREVIEW)).toBeNull();
  });

  it("retombe sur l'extrait quand le mail n'est pas dans la file d'analyse", () => {
    enableDecisionLayer();
    renderRow({ density: "cozy", preview: "ai", decisionPending: false });

    expect(screen.getByText(PREVIEW)).toBeTruthy();
  });

  it("garde la description sur une ligne en compact", () => {
    enableDecisionLayer();
    renderRow({ density: "compact", preview: "ai", decision: DECISION });

    const line = screen.getByText("Urgent · Réponse attendue · Tâche détectée");
    expect(line.className).toContain("line-clamp-1");
  });

  it("affiche l'extrait quand la densité n'est pas fournie", () => {
    renderRow({ preview: "excerpt" });

    expect(screen.getByText(PREVIEW)).toBeTruthy();
  });
});
