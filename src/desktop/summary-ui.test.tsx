import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopInbox, MorningSummary } from "@/desktop/inbox";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { CustomCategory, MailDecision } from "@/lib/decision";
import { decisionDb } from "@/lib/decision-db";
import type { DecisionLookup } from "@/lib/triage";
import { MAILS } from "@/lib/mail";
import type { Mail } from "@/lib/mail";
import type { SummaryResult } from "@/lib/summary";
import { isoToday } from "@/lib/tasks";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

function stubBackend() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ keys: [] }), text: async () => "{}" }) as unknown as Response),
  );
}

function mount(children: ReactNode) {
  return render(
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>{children}</MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>,
  );
}

const byId = (id: string): Mail => {
  const mail = MAILS.find((entry) => entry.id === id);
  if (!mail) throw new Error(`mail de démo ${id} introuvable`);
  return mail;
};

const unreadMail = (id: string): Mail => ({ ...byId(id), unread: true });

/** Mails indexés par le briefing de test : tous non lus dans le Résumé. */
const BRIEFING_MAILS: Mail[] = ["3", "8", "1", "4", "2", "6", "7"].map(unreadMail);

const GENERATED_AT = new Date();
GENERATED_AT.setHours(8, 12, 0, 0);

const briefing = (overrides: Partial<SummaryResult> = {}): SummaryResult => ({
  period: { id: "morning", label: "Résumé du matin" },
  headline: "7 mails sur 24 h · 2 actions attendues, 2 pour info, 3 notifications.",
  groups: {
    actions: [
      { mailId: "3", reason: "Renvoyer l'avenant signé", due: isoToday(0) },
      { mailId: "8", reason: "Régler la facture OVH", due: "aucune" },
    ],
    infos: [{ mailId: "1", reason: "" }, { mailId: "4", reason: "" }],
    notifications: [{ mailId: "2", reason: "" }, { mailId: "6", reason: "" }, { mailId: "7", reason: "" }],
  },
  tasks: [],
  mailCount: 7,
  generatedAt: GENERATED_AT.getTime(),
  source: "llm",
  mailIds: BRIEFING_MAILS.map((mail) => mail.id),
  ...overrides,
});

function renderSummary(
  summary: SummaryResult,
  handlers: {
    loading?: boolean;
    mails?: Mail[];
    decisions?: DecisionLookup;
    customCategories?: CustomCategory[];
    onOpen?: (id: string) => void;
    onReply?: (mail: Mail) => void;
    onPropose?: (ref: { mailId: string; reason: string; due?: string }) => "added" | "existing";
    onProposeEvent?: (ref: { mailId: string; reason: string; due?: string }) => "added" | "existing";
    onDelete?: (mail: Mail) => void;
    onArchive?: (mail: Mail) => void;
    onMoveToFolder?: (mail: Mail, folderPath: string) => void;
  } = {},
) {
  return render(
    <MorningSummary
      open
      unread={12}
      attachments={2}
      encrypted={1}
      demo={false}
      summary={summary}
      mails={handlers.mails ?? BRIEFING_MAILS}
      loading={Boolean(handlers.loading)}
      decisions={handlers.decisions}
      customCategories={handlers.customCategories}
      onToggle={() => {}}
      onOpen={handlers.onOpen ?? (() => {})}
      onRefresh={() => {}}
      onReply={handlers.onReply ?? (() => {})}
      onPropose={handlers.onPropose ?? (() => "added")}
      onProposeEvent={handlers.onProposeEvent}
      onDelete={handlers.onDelete}
      onArchive={handlers.onArchive}
      onMoveToFolder={handlers.onMoveToFolder}
    />,
  );
}

beforeEach(async () => {
  window.localStorage.clear();
  await decisionDb().clearDecisions();
  await decisionDb().clearLlmExtractions();
  vi.unstubAllGlobals();
});

describe("Résumé du matin · briefing structuré", () => {
  it("affiche l'accroche, les groupes comptés et le pied de génération", async () => {
    stubBackend();
    mount(<DesktopInbox onOpenSearch={() => {}} />);

    const card = await screen.findByTestId("morning-summary");
    await waitFor(() => expect(within(card).getByTestId("summary-attachments")).toBeTruthy());

    expect(within(card).getByText(/^Résumé du (matin|midi|soir)$/)).toBeTruthy();
    expect(within(card).getByTestId("summary-source").textContent).toBe("local");
    expect(within(card).getByText(/sur la période/)).toBeTruthy();
    expect(within(card).getByText("Pour info")).toBeTruthy();
    expect(within(card).getByTestId("summary-footer").textContent).toMatch(/^Généré à \d{2}:\d{2}$/);
    expect(card.textContent).not.toContain("mails analysés");
  });

  it("n'affiche pas de chips pièces jointes dans le briefing", async () => {
    stubBackend();
    mount(<DesktopInbox onOpenSearch={() => {}} />);

    const card = await screen.findByTestId("morning-summary");
    await waitFor(() => expect(within(card).getByTestId("summary-attachments")).toBeTruthy());

    const groups = within(card).getByTestId("summary-attachments");
    expect(groups.className).not.toContain("overflow-y-auto");
    expect(groups.className).not.toMatch(/max-h-/);
    expect(groups.querySelectorAll("button[title]")).toHaveLength(0);
    expect(groups.textContent).not.toContain("inbox-v3.fig");
    expect(groups.textContent).not.toContain("specs-mobile.pdf");
  });

  it("rend les actions, les informations et les notifications repliées", () => {
    renderSummary(briefing());
    const card = screen.getByTestId("morning-summary");

    expect(within(card).getByText("À traiter")).toBeTruthy();
    expect(within(card).getByText("Pour info")).toBeTruthy();
    expect(within(card).getByText("Renvoyer l'avenant signé")).toBeTruthy();
    expect(within(card).getByText("Régler la facture OVH")).toBeTruthy();
    expect(within(card).getByRole("button", { name: /Notifications & listes · 3/ })).toBeTruthy();
    expect(within(card).queryByText("[lavande] Rust backend: 3 pull requests")).toBeNull();
    expect(within(card).getByTestId("summary-source").textContent).toBe("IA");
    expect(within(card).getByTestId("summary-footer").textContent).toBe("Généré à 08:12");
    expect(card.textContent).not.toContain("mis en cache");
    expect(card.textContent).not.toContain("7 mails analysés");
  });

  it("déplie puis replie les notifications et listes", () => {
    renderSummary(briefing());
    const card = screen.getByTestId("morning-summary");
    const fold = within(card).getByRole("button", { name: /Notifications & listes · 3/ });

    fireEvent.click(fold);
    expect(within(card).getByText("[lavande] Rust backend: 3 pull requests")).toBeTruthy();
    expect(within(card).getByText("Ta playlist « Focus lavande » a été mise à jour")).toBeTruthy();
    expect(fold.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(fold);
    expect(within(card).queryByText("[lavande] Rust backend: 3 pull requests")).toBeNull();
    expect(fold.getAttribute("aria-expanded")).toBe("false");
  });

  it("ouvre le mail depuis l'objet sans bouton « Voir le mail » redondant", () => {
    const onOpen = vi.fn();
    renderSummary(briefing(), { onOpen });
    const card = screen.getByTestId("morning-summary");

    fireEvent.click(within(card).getByRole("button", { name: "Devis signé — retour de ma part" }));
    expect(within(card).queryByRole("button", { name: "Voir le mail" })).toBeNull();

    expect(onOpen.mock.calls.map((call) => call[0])).toEqual(["3"]);
  });

  it("propose la ligne en planification et répond au mail", () => {
    const onPropose = vi.fn(() => "added" as const);
    const onReply = vi.fn();
    renderSummary(briefing(), { onPropose, onReply });
    const card = screen.getByTestId("morning-summary");

    fireEvent.click(within(card).getAllByRole("button", { name: "Planification" })[0]);
    fireEvent.click(within(card).getAllByRole("button", { name: "Répondre" })[1]);

    expect(onPropose).toHaveBeenCalledWith({ mailId: "3", reason: "Renvoyer l'avenant signé", due: isoToday(0) });
    expect(onReply).toHaveBeenCalledTimes(1);
    expect((onReply.mock.calls[0][0] as Mail).id).toBe("8");
  });

  it("confirme l'ajout en planification et n'ajoute qu'une suggestion", () => {
    const onPropose = vi.fn(() => "added" as const);
    renderSummary(briefing(), { onPropose });
    const card = screen.getByTestId("morning-summary");

    expect(within(card).getAllByRole("button", { name: "Planification" })).toHaveLength(2);

    fireEvent.click(within(card).getAllByRole("button", { name: "Planification" })[0]);

    const done = within(card).getByRole("button", { name: "Ajouté" }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    expect(within(card).getAllByRole("button", { name: "Planification" })).toHaveLength(1);
    expect(onPropose).toHaveBeenCalledTimes(1);
  });

  it("signale une suggestion déjà proposée sans la dupliquer", () => {
    const onPropose = vi.fn(() => "existing" as const);
    renderSummary(briefing(), { onPropose });
    const card = screen.getByTestId("morning-summary");

    fireEvent.click(within(card).getAllByRole("button", { name: "Planification" })[0]);

    const done = within(card).getByRole("button", { name: "Déjà proposé" }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    expect(within(card).queryByRole("button", { name: "Ajouté" })).toBeNull();
    expect(within(card).getAllByRole("button", { name: "Planification" })).toHaveLength(1);
  });

  it("ignore les lignes dont le mail a disparu de la boîte", () => {
    renderSummary(
      briefing({
        groups: {
          actions: [
            { mailId: "3", reason: "Renvoyer l'avenant signé", due: "aucune" },
            { mailId: "disparu", reason: "Mail effacé", due: "aucune" },
          ],
          infos: [{ mailId: "1", reason: "" }],
          notifications: [],
        },
      }),
    );
    const card = screen.getByTestId("morning-summary");

    expect(within(card).getByText("Renvoyer l'avenant signé")).toBeTruthy();
    expect(within(card).queryByText("Mail effacé")).toBeNull();
    expect(within(card).getByText("À traiter").parentElement?.textContent).toContain("1");
    expect(within(card).queryByRole("button", { name: /Notifications & listes/ })).toBeNull();
  });

  it("retombe sur les compteurs quand les résumés sont désactivés", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ summary: { enabled: false } }));
    stubBackend();
    mount(<DesktopInbox onOpenSearch={() => {}} />);

    const card = await screen.findByTestId("morning-summary");
    expect(within(card).getByText("Résumé du matin")).toBeTruthy();
    expect(within(card).queryByTestId("summary-source")).toBeNull();
    expect(within(card).getByText(/conversations non lues/)).toBeTruthy();
  });

  it("affiche les libellés Hybride / Décision et l'animation discrète sans masquer les groupes progressifs", () => {
    const { rerender } = renderSummary(briefing({ source: "decision" }), { loading: true });
    const card = screen.getByTestId("morning-summary");

    expect(within(card).getByTestId("summary-source").textContent).toBe("Décision");
    expect(within(card).getByTestId("summary-loading").textContent).toContain("Enrichissement…");
    expect(within(card).getByTestId("summary-footer").textContent).toBe("Mise à jour…");
    // Les groupes Système 1 restent affichés pendant la génération LLM
    expect(within(card).getByText("Renvoyer l'avenant signé")).toBeTruthy();

    rerender(
      <MorningSummary
        open
        unread={12}
        attachments={2}
        encrypted={1}
        demo={false}
        summary={briefing({ source: "hybrid" })}
        mails={BRIEFING_MAILS}
        loading={false}
        onToggle={() => {}}
        onOpen={() => {}}
        onRefresh={() => {}}
        onReply={() => {}}
        onPropose={() => "added"}
      />,
    );
    expect(within(card).getByTestId("summary-source").textContent).toBe("Hybride");
    expect(within(card).queryByTestId("summary-loading")).toBeNull();
    expect(within(card).getByTestId("summary-footer").textContent).toBe("Généré à 08:12");
  });

  it("affiche la pastille Urgent et le raccourci + Agenda selon les signaux Système 1", () => {
    const decisions = new Map<string, MailDecision>([
      [
        "3",
        {
          accountId: "perso",
          folderPath: "INBOX",
          uid: 3,
          contentHash: "h3",
          schemaVersion: 1,
          model: "mammoth-1",
          category: "important",
          categoryConf: 0.9,
          categoryProbs: {},
          urgency: 2.4,
          needsReply: 0.8,
          hasTask: 0.2,
          hasEvent: 0.85,
          security: "safe",
          securityConf: 0.99,
          cleanupScore: 0.05,
          decidedAt: 1_731_000_000,
          source: "local",
        },
      ],
    ]);
    const onProposeEvent = vi.fn(() => "added" as const);
    renderSummary(briefing({ source: "hybrid" }), { decisions, onProposeEvent });
    const card = screen.getByTestId("morning-summary");

    expect(within(card).getByText("Urgent")).toBeTruthy();
    const agendaBtn = within(card).getByRole("button", { name: "+ Agenda" });
    fireEvent.click(agendaBtn);

    expect(onProposeEvent).toHaveBeenCalledWith({
      mailId: "3",
      reason: "Renvoyer l'avenant signé",
      due: isoToday(0),
    });
    const done = within(card).getByRole("button", { name: "Ajouté" }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    expect(within(card).queryByRole("button", { name: "+ Agenda" })).toBeNull();
  });

  it("affiche le code TOTP avec Copier / Supprimer et masque les doublons visuels en mode Décision", () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const totpMail: Mail = {
      ...byId("3"),
      id: "demo-totp-live",
      name: "GitHub Security",
      subject: "Votre code de vérification GitHub",
    };
    const onDelete = vi.fn();
    const decisions: Record<string, MailDecision> = {
      "demo-totp-live": {
        accountId: "perso",
        folderPath: "INBOX",
        uid: 0,
        contentHash: "h-totp",
        schemaVersion: 1,
        model: "mammoth-1",
        category: "auth_totp",
        categoryConf: 0.99,
        categoryProbs: { auth_totp: 0.99 },
        urgency: 1.5,
        needsReply: 0.01,
        hasTask: 0,
        hasEvent: 0,
        security: "safe",
        securityConf: 0.99,
        cleanupScore: 0.98,
        totpCode: "482917",
        totpService: "GitHub",
        decidedAt: 1_731_000_000,
        source: "synced",
      },
    };
    renderSummary(
      briefing({
        source: "decision",
        headline: "1 mail : 1 à traiter.",
        groups: {
          actions: [{ mailId: "demo-totp-live", reason: "Code GitHub : 482917" }],
          infos: [],
          notifications: [],
        },
      }),
      { mails: [totpMail], decisions, onDelete },
    );
    const card = screen.getByTestId("morning-summary");

    // Pas de compteur redondant dans l'en-tête ni d'accroche robotique en mode Décision
    expect(card.textContent).not.toContain("12 non lus");
    expect(within(card).queryByText("1 mail : 1 à traiter.")).toBeNull();

    expect(within(card).getByText("Code · GitHub")).toBeTruthy();
    expect(within(card).getByTestId("summary-totp-code").textContent).toBe("482 917");
    expect(within(card).queryByRole("button", { name: "Planification" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Répondre" })).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "Copier" }));
    expect(writeText).toHaveBeenCalledWith("482917");
    expect(within(card).getByRole("button", { name: "Copié !" })).toBeTruthy();

    fireEvent.click(within(card).getByRole("button", { name: "Supprimer" }));
    expect(onDelete).toHaveBeenCalledWith(totpMail);
  });

  it("affiche la carte Phishing avec étiquette Suspect · Phishing et Supprimer uniquement", () => {
    const phishMail: Mail = {
      ...byId("1"),
      id: "demo-phish-1",
      name: "Service Bancaire Urgent",
      subject: "Action immédiate : carte bloquée",
    };
    const onDelete = vi.fn();
    const decisions: Record<string, MailDecision> = {
      "demo-phish-1": {
        accountId: "perso",
        folderPath: "INBOX",
        uid: 0,
        contentHash: "h-phish",
        schemaVersion: 1,
        model: "mammoth-1",
        category: "important",
        categoryConf: 0.7,
        categoryProbs: { important: 0.7 },
        urgency: 1.2,
        needsReply: 0.1,
        hasTask: 0,
        hasEvent: 0,
        security: "phishing",
        securityConf: 0.96,
        cleanupScore: 0.85,
        decidedAt: 1_731_000_000,
        source: "synced",
      },
    };
    renderSummary(
      briefing({
        source: "decision",
        groups: {
          actions: [{ mailId: "demo-phish-1", reason: "Hameçonnage détecté · Ne cliquez sur aucun lien" }],
          infos: [],
          notifications: [],
        },
      }),
      { mails: [phishMail], decisions, onDelete },
    );
    const card = screen.getByTestId("morning-summary");

    expect(within(card).getByText("Suspect · Phishing")).toBeTruthy();
    expect(within(card).getByText("Hameçonnage détecté · Ne cliquez sur aucun lien")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Répondre" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Planification" })).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "Supprimer" }));
    expect(onDelete).toHaveBeenCalledWith(phishMail);
  });

  it("affiche la catégorie custom Factures et les boutons Ranger dans Factures / Archiver / Supprimer", () => {
    const facturesCategory: CustomCategory = {
      id: "factures",
      name: "Factures",
      description: "Factures et abonnements",
      color: "emerald",
      excludeFromPriority: false,
      allowNotifications: true,
      cleanupEligible: false,
    };
    const onMoveToFolder = vi.fn();
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    const decisions: Record<string, MailDecision> = {
      "8": {
        accountId: "pro",
        folderPath: "INBOX",
        uid: 110,
        contentHash: "h-8",
        schemaVersion: 1,
        model: "mammoth-1",
        category: "custom:factures",
        categoryConf: 0.95,
        categoryProbs: { "custom:factures": 0.95 },
        urgency: 0.9,
        needsReply: 0.05,
        hasTask: 0.1,
        hasEvent: 0,
        security: "safe",
        securityConf: 0.99,
        cleanupScore: 0.08,
        suggestedFolder: "Factures",
        suggestedFolderConf: 0.94,
        decidedAt: 1_731_000_000,
        source: "synced",
      },
    };

    renderSummary(
      briefing({
        source: "decision",
        groups: {
          actions: [],
          infos: [{ mailId: "8", reason: "" }],
          notifications: [],
        },
      }),
      {
        decisions,
        customCategories: [facturesCategory],
        onMoveToFolder,
        onArchive,
        onDelete,
      },
    );
    const card = screen.getByTestId("morning-summary");

    expect(within(card).getByText("Factures")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Ranger dans Factures" }));
    expect(onMoveToFolder).toHaveBeenCalledWith(unreadMail("8"), "Factures");

    fireEvent.click(within(card).getByRole("button", { name: "Archiver" }));
    expect(onArchive).toHaveBeenCalledWith(unreadMail("8"));

    fireEvent.click(within(card).getByRole("button", { name: "Supprimer" }));
    expect(onDelete).toHaveBeenCalledWith(unreadMail("8"));
  });

  it("affiche Vérification & accès tout en haut (code TOTP et lien de vérification) et masque les mails lus", () => {
    const linkMail: Mail = {
      ...unreadMail("1"),
      id: "auth-link-1",
      name: "Linear",
      subject: "Confirmez votre connexion",
      preview: "Cliquez sur https://linear.app/verify?token=abc pour vous connecter",
      body: [
        "Se désabonner : https://linear.app/unsubscribe",
        "Confirmer : https://linear.app/verify?token=abc",
      ],
    };
    const readMail: Mail = { ...byId("3"), unread: false };
    const decisions: Record<string, MailDecision> = {
      "auth-link-1": {
        accountId: "perso",
        folderPath: "INBOX",
        uid: 0,
        contentHash: "h-link",
        schemaVersion: 1,
        model: "mammoth-1",
        category: "auth_totp",
        categoryConf: 0.98,
        categoryProbs: { auth_totp: 0.98 },
        urgency: 1.5,
        needsReply: 0,
        hasTask: 0,
        hasEvent: 0,
        security: "safe",
        securityConf: 0.99,
        cleanupScore: 0.9,
        totpService: "Linear",
        decidedAt: 1_731_000_000,
        source: "synced",
      },
    };
    const { rerender } = renderSummary(
      briefing({
        source: "decision",
        groups: {
          actions: [
            { mailId: "auth-link-1", reason: "Vérification Linear" },
            { mailId: "3", reason: "Mail déjà lu" },
          ],
          infos: [],
          notifications: [],
        },
      }),
      { mails: [linkMail, readMail], decisions },
    );
    const card = screen.getByTestId("morning-summary");
    expect(within(card).getByText("Vérification & accès")).toBeTruthy();
    expect(within(card).getByText("Accès · Linear")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Ouvrir le lien" })).toBeTruthy();
    // Le mail lu (unread: false) n'apparaît pas dans le Résumé
    expect(within(card).queryByText("Mail déjà lu")).toBeNull();

    // Si tous les mails du Résumé passent à unread: false, le message zen apparaît
    rerender(
      <MorningSummary
        open
        unread={0}
        attachments={0}
        encrypted={0}
        demo={false}
        summary={briefing({
          source: "decision",
          groups: {
            actions: [{ mailId: "3", reason: "Mail déjà lu" }],
            infos: [],
            notifications: [],
          },
        })}
        mails={[readMail]}
        loading={false}
        onToggle={() => {}}
        onOpen={() => {}}
        onRefresh={() => {}}
        onReply={() => {}}
        onPropose={() => "added"}
      />,
    );
    expect(screen.getByText("Tout a été lu sur la période.")).toBeTruthy();
  });
});

describe("Réglages · section Résumés", () => {
  it("liste les préférences de résumé et enregistre le consentement LLM", async () => {
    stubBackend();
    mount(<DesktopSettings />);

    expect(await screen.findByText("Résumés périodiques")).toBeTruthy();
    const consent = screen.getByText("Autoriser l'analyse de mes mails par le LLM").closest("button");
    expect(consent?.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(consent as HTMLButtonElement);

    await waitFor(() =>
      expect(
        (JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as { summary?: { llmConsent?: boolean } })
          .summary?.llmConsent,
      ).toBe(true),
    );

    fireEvent.change(screen.getByLabelText("Heure de début du résumé midi"), { target: { value: "13" } });
    await waitFor(() =>
      expect(
        (JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as { summary?: { middayStart?: number } })
          .summary?.middayStart,
      ).toBe(13),
    );
  });
});
