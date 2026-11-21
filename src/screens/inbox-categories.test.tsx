import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { InboxScreen } from "@/screens/inbox-screen";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { DEFAULT_DECISION, type CustomCategory, type MailDecision } from "@/lib/decision";
import { decisionDb } from "@/lib/decision-db";
import type { Mail } from "@/lib/mail";
import type { MailNavigation } from "@/lib/app-shortcuts";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const NOW = Date.now();

function makeMail(uid: number, overrides: Partial<Mail> = {}): Mail {
  return {
    id: `perso:INBOX:${uid}`,
    account: "perso",
    folder: "inbox",
    source: { accountId: "perso", folderPath: "INBOX", uid },
    messageId: `<m${uid}@test.fr>`,
    name: `Expéditeur ${uid}`,
    email: `sender${uid}@test.fr`,
    subject: `Sujet ${uid}`,
    preview: `Aperçu ${uid}`,
    body: [`Corps ${uid}`],
    time: "10:00",
    timestamp: NOW - uid * 60_000,
    unread: true,
    starred: false,
    pgp: "none",
    tone: 0,
    ...overrides,
  };
}

function makeDecision(uid: number, overrides: Partial<MailDecision> = {}): MailDecision {
  return {
    accountId: "perso",
    folderPath: "INBOX",
    uid,
    messageId: `<m${uid}@test.fr>`,
    contentHash: `h-${uid}`,
    schemaVersion: 1,
    model: "mammoth-1",
    category: "important",
    categoryConf: 0.92,
    categoryProbs: { important: 0.92 },
    urgency: 1.0,
    needsReply: 0.2,
    hasTask: 0.2,
    hasEvent: 0.1,
    security: "safe",
    securityConf: 0.99,
    cleanupScore: 0.05,
    decidedAt: NOW,
    source: "synced",
    ...overrides,
  };
}

const CUSTOM_FACTURES: CustomCategory = {
  id: "factures",
  name: "Factures",
  description: "Factures, devis et abonnements",
  color: "emerald",
  excludeFromPriority: true,
  allowNotifications: true,
  cleanupEligible: false,
};

function mount(mails: Mail[], onOpenCleanup?: () => void) {
  function Host() {
    const navRef = useRef<MailNavigation | null>(null);
    return (
      <InboxScreen
        mails={mails}
        account="all"
        folder="inbox"
        active
        navigationRef={navRef}
        onOpenAccounts={() => {}}
        onOpenFolders={() => {}}
        onOpen={() => {}}
        onToggleStar={() => {}}
        onSearch={() => {}}
        onMailAction={() => {}}
        onReply={() => {}}
        onOpenCleanup={onOpenCleanup}
      />
    );
  }
  return render(
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>
            <Host />
          </MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>,
  );
}

beforeEach(async () => {
  window.localStorage.clear();
  await decisionDb().clearDecisions();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
  Element.prototype.scrollTo = () => {};
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const visibleSubjects = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-mail-row]")).map(
    (row) => row.textContent ?? "",
  );

describe("InboxScreen · catégories intelligentes et custom", () => {
  it("masque les puces intelligentes sans modèle ni décisions et reste sur Tous", async () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ decision: { ...DEFAULT_DECISION, defaultInboxFilter: "priority" } }),
    );
    mount([makeMail(1, { subject: "Message humain" })]);

    await waitFor(() => expect(screen.getByText("Message humain")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /^Prioritaire/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Catégorie/ })).toBeNull();
  });

  it("active les puces via décisions héritées (même sans clé API), filtre et affiche les pastilles", async () => {
    const mails = [
      makeMail(1, { subject: "Devis urgent", answered: false }),
      makeMail(2, { subject: "Code GitHub 482917" }),
      makeMail(3, { subject: "Promo printemps" }),
      makeMail(4, { subject: "Alerte serveur" }),
      makeMail(5, { subject: "Facture avril" }),
      makeMail(6, { subject: "Lien suspect banque" }),
    ];

    await decisionDb().putDecisions([
      makeDecision(1, { category: "important", urgency: 2.3, needsReply: 0.88 }),
      makeDecision(2, { category: "auth_totp", totpCode: "482917", totpService: "GitHub" }),
      makeDecision(3, { category: "promo", cleanupScore: 0.94 }),
      makeDecision(4, { category: "notification", cleanupScore: 0.85 }),
      makeDecision(5, { category: "custom:factures" }),
      makeDecision(6, { category: "important", security: "phishing", securityConf: 0.93 }),
    ]);

    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({
        decision: {
          ...DEFAULT_DECISION,
          enabled: false,
          customCategories: [CUSTOM_FACTURES],
        },
      }),
    );

    const onOpenCleanup = vi.fn();
    mount(mails, onOpenCleanup);

    await waitFor(() => expect(screen.getByRole("button", { name: /^Prioritaire/ })).toBeTruthy());

    // Pastilles sur les lignes
    const row1 = document.querySelector<HTMLElement>('[data-mail-row="perso:perso:INBOX:1"]')!;
    expect(within(row1).getByText("Urgent")).toBeTruthy();
    expect(within(row1).getByText("À répondre")).toBeTruthy();
    const row5 = document.querySelector<HTMLElement>('[data-mail-row="perso:perso:INBOX:5"]')!;
    expect(within(row5).getByText("Factures")).toBeTruthy();
    const row6 = document.querySelector<HTMLElement>('[data-mail-row="perso:perso:INBOX:6"]')!;
    expect(within(row6).getByText("Suspect")).toBeTruthy();

    // Prioritaire exclut promo, auth_totp, notification et custom excludeFromPriority
    fireEvent.click(screen.getByRole("button", { name: /^Prioritaire/ }));
    expect(visibleSubjects().some((t) => t.includes("Devis urgent"))).toBe(true);
    expect(visibleSubjects().some((t) => t.includes("Lien suspect banque"))).toBe(true);
    expect(visibleSubjects().some((t) => t.includes("Promo printemps"))).toBe(false);
    expect(visibleSubjects().some((t) => t.includes("Code GitHub"))).toBe(false);
    expect(visibleSubjects().some((t) => t.includes("Alerte serveur"))).toBe(false);
    expect(visibleSubjects().some((t) => t.includes("Facture avril"))).toBe(false);

    // À répondre
    fireEvent.click(screen.getByRole("button", { name: /^À répondre/ }));
    expect(visibleSubjects()).toHaveLength(1);
    expect(visibleSubjects()[0]).toContain("Devis urgent");

    // Codes & Auth
    fireEvent.click(screen.getByRole("button", { name: /^Codes & Auth/ }));
    expect(visibleSubjects()).toHaveLength(1);
    expect(visibleSubjects()[0]).toContain("Code GitHub 482917");

    // Pub & Promos
    fireEvent.click(screen.getByRole("button", { name: /^Pub & Promos/ }));
    expect(visibleSubjects()).toHaveLength(1);
    expect(visibleSubjects()[0]).toContain("Promo printemps");

    // Catégorie custom Factures
    fireEvent.click(screen.getByRole("button", { name: /^Factures/ }));
    expect(visibleSubjects()).toHaveLength(1);
    expect(visibleSubjects()[0]).toContain("Facture avril");

    // Bouton Nettoyage avec compteur
    const cleanupBtn = screen.getByRole("button", { name: /Nettoyage/ });
    expect(cleanupBtn.textContent).toContain("2");
    fireEvent.click(cleanupBtn);
    expect(onOpenCleanup).toHaveBeenCalledTimes(1);
  });

  it("applique le filtre par défaut configuré et permet d'ajouter une catégorie custom", async () => {
    await decisionDb().putDecisions([
      makeDecision(1, { category: "important" }),
      makeDecision(2, { category: "promo" }),
    ]);

    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({
        decision: { ...DEFAULT_DECISION, defaultInboxFilter: "priority" },
      }),
    );

    mount([makeMail(1, { subject: "Important" }), makeMail(2, { subject: "Pub ignorée" })]);

    await waitFor(() => expect(visibleSubjects()).toHaveLength(1));
    expect(visibleSubjects()[0]).toContain("Important");

    fireEvent.click(screen.getByRole("button", { name: /Catégorie/ }));
    expect(screen.getByRole("dialog", { name: "Catégories personnalisées" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Nom de la catégorie"), { target: { value: "Colis" } });
    fireEvent.change(screen.getByLabelText("Description de la catégorie"), {
      target: { value: "Suivi de livraison et transporteurs" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Créer la catégorie/i }));

    expect(screen.getByRole("button", { name: /Retrier les mails récents/i })).toBeTruthy();
    const prefs = JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as {
      decision?: { customCategories?: CustomCategory[] };
    };
    expect(prefs.decision?.customCategories?.[0]?.id).toBe("colis");
  });
});
