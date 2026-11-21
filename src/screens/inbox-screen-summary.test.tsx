import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { InboxScreen } from "@/screens/inbox-screen";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { MAILS } from "@/lib/mail";
import type { Mail } from "@/lib/mail";
import { DEFAULT_SUMMARY, currentPeriod, summaryScope, summarySignature, writeSummaryCache } from "@/lib/summary";
import type { SummaryResult } from "@/lib/summary";
import { isoToday } from "@/lib/tasks";
import type { MailNavigation } from "@/lib/app-shortcuts";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { MailDecision } from "@/lib/decision";
import { decisionDb } from "@/lib/decision-db";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const BY_ID = new Map(MAILS.map((mail) => [mail.id, mail]));
const mailOf = (id: string): Mail => {
  const mail = BY_ID.get(id);
  if (!mail) throw new Error(`mail de démo ${id} introuvable`);
  return mail;
};

const GENERATED_AT = new Date();
GENERATED_AT.setHours(8, 12, 0, 0);

/** Résumé du modèle placé dans le cache : l'écran mobile n'appelle jamais le réseau en démo. */
function seedSummary(
  headline: string,
  groups: SummaryResult["groups"],
  source: SummaryResult["source"] = "llm",
) {
  const inputs = MAILS.filter((mail) => mail.folder === "inbox").flatMap((mail) =>
    typeof mail.timestamp === "number"
      ? [
          {
            id: mail.id,
            from: mail.name,
            subject: mail.subject,
            snippet: mail.preview,
            timestamp: mail.timestamp,
          },
        ]
      : [],
  );
  const result: SummaryResult = {
    period: currentPeriod(DEFAULT_SUMMARY),
    headline,
    groups,
    tasks: [],
    mailCount: inputs.length,
    generatedAt: GENERATED_AT.getTime(),
    source,
    mailIds: inputs.map((input) => input.id),
  };
  writeSummaryCache(
    window.localStorage,
    summaryScope(null),
    result.period.id,
    summarySignature(inputs),
    result,
  );
}

function mount(spies: {
  onOpen?: (mail: Mail) => void;
  onReply?: (mail: Mail) => void;
  onMailAction?: (kind: "delete" | "archive" | "read", mail: Mail) => void;
} = {}) {
  function Host() {
    const navigationRef = useRef<MailNavigation | null>(null);
    const { suggestions, mails } = useMailStore();
    return (
      <>
        <output data-testid="suggestions">{suggestions.map((entry) => entry.proposal).join("|")}</output>
        <InboxScreen
          mails={mails.length > 0 ? mails : MAILS}
          account="all"
          folder="inbox"
          active
          navigationRef={navigationRef}
          onOpenAccounts={() => {}}
          onOpenFolders={() => {}}
          onOpen={spies.onOpen ?? (() => {})}
          onToggleStar={() => {}}
          onSearch={() => {}}
          onMailAction={spies.onMailAction ?? (() => {})}
          onReply={spies.onReply ?? (() => {})}
        />
      </>
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
  vi.stubEnv("VITE_MAIL_BACKEND", "demo");
  window.localStorage.clear();
  await decisionDb().clearDecisions();
  await decisionDb().clearLlmExtractions();
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ keys: [] }) }) as unknown as Response),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Boîte de réception mobile · résumé périodique", () => {
  it("affiche l'accroche et les informations sans chips pièces jointes", async () => {
    mount();

    const body = await screen.findByTestId("summary-attachments-mobile");

    expect(body.textContent).toContain("Pour info");
    expect(body.querySelectorAll("button[title]")).toHaveLength(0);
    expect(body.textContent).not.toContain("inbox-v3.fig");
    expect(body.textContent).not.toContain("specs-mobile.pdf");
    expect(screen.getByTestId("summary-source-mobile").textContent).toBe("local");
    expect(screen.getByTestId("summary-footer-mobile").textContent).toMatch(/^Généré à \d{2}:\d{2}$/);
  });

  it("affiche le briefing du modèle : actions, échéance, notifications repliées et pied épuré", async () => {
    seedSummary("7 mails sur 24 h · 1 action attendue, 1 pour info, 1 notification.", {
      actions: [{ mailId: "3", reason: "Renvoyer l'avenant signé", due: isoToday(0) }],
      infos: [{ mailId: "1", reason: "" }],
      notifications: [{ mailId: "2", reason: "" }],
    });
    mount();

    const body = await screen.findByTestId("summary-attachments-mobile");
    await waitFor(() => expect(within(body).getByText("Renvoyer l'avenant signé")).toBeTruthy());

    expect(within(body).getByText("À traiter")).toBeTruthy();
    expect(within(body).getByText("Pour info")).toBeTruthy();
    expect(within(body).getByText("aujourd'hui")).toBeTruthy();
    expect(screen.getByTestId("summary-source-mobile").textContent).toBe("IA");
    expect(screen.getByTestId("summary-footer-mobile").textContent).toBe("Généré à 08:12");

    const fold = within(body).getByRole("button", { name: /Notifications & listes · 1/ });
    expect(within(body).queryByText("[lavande] Rust backend: 3 pull requests")).toBeNull();

    fireEvent.click(fold);
    expect(within(body).getByText("[lavande] Rust backend: 3 pull requests")).toBeTruthy();
    expect(fold.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(fold);
    expect(within(body).queryByText("[lavande] Rust backend: 3 pull requests")).toBeNull();
  });

  it("exclut les mails déjà lus du Résumé et affiche le message zen quand tout est lu", async () => {
    seedSummary("Mails lus", {
      actions: [],
      infos: [{ mailId: "4", reason: "" }],
      notifications: [{ mailId: "6", reason: "" }],
    });
    mount();

    const body = await screen.findByTestId("summary-attachments-mobile");
    await waitFor(() =>
      expect(within(body).getByText("Tout a été lu sur la période.")).toBeTruthy(),
    );
    expect(within(body).queryByText("Déjeuner jeudi ?")).toBeNull();
    expect(within(body).queryByText("Ton récapitulatif hebdomadaire")).toBeNull();
  });

  it("ouvre le mail résumé et répond depuis une carte d'action", async () => {
    seedSummary("7 mails sur 24 h · 1 action attendue.", {
      actions: [{ mailId: "3", reason: "Renvoyer l'avenant signé", due: "aucune" }],
      infos: [{ mailId: "1", reason: "" }],
      notifications: [],
    });
    const onOpen = vi.fn();
    const onReply = vi.fn();
    mount({ onOpen, onReply });

    const body = await screen.findByTestId("summary-attachments-mobile");
    await waitFor(() => expect(within(body).getByText("Renvoyer l'avenant signé")).toBeTruthy());

    fireEvent.click(within(body).getByRole("button", { name: "Devis signé — retour de ma part" }));
    fireEvent.click(within(body).getByRole("button", { name: "Répondre" }));

    expect(onOpen).toHaveBeenCalledWith(mailOf("3"));
    expect((onReply.mock.calls[0][0] as Mail).id).toBe("3");
  });

  it("propose l'action mobile en suggestion et confirme l'ajout", async () => {
    seedSummary("7 mails sur 24 h · 1 action attendue.", {
      actions: [{ mailId: "3", reason: "Renvoyer l'avenant signé", due: isoToday(2) }],
      infos: [],
      notifications: [],
    });
    mount();

    const body = await screen.findByTestId("summary-attachments-mobile");
    await waitFor(() => expect(within(body).getByText("Renvoyer l'avenant signé")).toBeTruthy());

    fireEvent.click(within(body).getByRole("button", { name: "Planification" }));

    await waitFor(() => expect(screen.getByTestId("suggestions").textContent).toContain("Renvoyer l'avenant signé"));
    const done = await within(body).findByRole("button", { name: "Ajouté" });
    expect((done as HTMLButtonElement).disabled).toBe(true);
    expect(within(body).queryByRole("button", { name: "Planification" })).toBeNull();
  });

  it("signale une suggestion déjà proposée sans la dupliquer", async () => {
    seedSummary("7 mails sur 24 h · 1 action attendue.", {
      actions: [{ mailId: "1", reason: "Répondre à Camille", due: "aucune" }],
      infos: [],
      notifications: [],
    });
    mount();

    const body = await screen.findByTestId("summary-attachments-mobile");
    await waitFor(() => expect(within(body).getByText("Répondre à Camille")).toBeTruthy());

    fireEvent.click(within(body).getByRole("button", { name: "Planification" }));

    const done = await within(body).findByRole("button", { name: "Déjà proposé" });
    expect((done as HTMLButtonElement).disabled).toBe(true);
    expect(within(body).queryByRole("button", { name: "Ajouté" })).toBeNull();
    const proposals = (screen.getByTestId("suggestions").textContent ?? "").split("|");
    expect(proposals.filter((entry) => entry === "Répondre à Camille")).toHaveLength(1);
  });

  it("garde le bouton de régénération comme seule relance manuelle", async () => {
    mount();

    const regenerate = await screen.findByLabelText("Régénérer le résumé");

    expect(regenerate.tagName).toBe("BUTTON");
    expect(screen.getAllByLabelText("Régénérer le résumé")).toHaveLength(1);
  });

  it("affiche Hybride, Urgent et + Agenda sur mobile pour une décision avec rendez-vous", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    const received = new Date(Date.now() - 3_600_000).toISOString();
    const apiThread = {
      id: "t-1",
      account_id: "alpha",
      messages: [
        {
          account_id: "alpha",
          folder_path: "INBOX",
          uid: 1,
          uidvalidity: 1,
          thread_id: "t-1",
          message_id: "<1@test.fr>",
          in_reply_to: null,
          references: [],
          from: { name: "Camille", email: "camille@test.fr" },
          to: [{ name: null, email: "alpha@test.fr" }],
          cc: [],
          subject: "Point projet jeudi",
          date: received,
          flags: { unread: true, starred: false, answered: false },
          size: 512,
          pgp: "none",
          preview: "On se retrouve jeudi ?",
          body_text: "On se retrouve jeudi ?",
          body_html: null,
          attachments: [],
        },
      ],
      primary: {
        account_id: "alpha",
        folder_path: "INBOX",
        uid: 1,
        uidvalidity: 1,
        thread_id: "t-1",
        message_id: "<1@test.fr>",
        in_reply_to: null,
        references: [],
        from: { name: "Camille", email: "camille@test.fr" },
        to: [{ name: null, email: "alpha@test.fr" }],
        cc: [],
        subject: "Point projet jeudi",
        date: received,
        flags: { unread: true, starred: false, answered: false },
        size: 512,
        pgp: "none",
        preview: "On se retrouve jeudi ?",
        body_text: "On se retrouve jeudi ?",
        body_html: null,
        attachments: [],
      },
      count: 1,
      unread: 1,
      starred: false,
      encrypted: 0,
      attachments: 0,
      participants: ["camille@test.fr"],
      subject: "Point projet jeudi",
      preview: "On se retrouve jeudi ?",
    };
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({
        llm: { endpoint: "https://llm.test/v1", apiKey: "sk-test", model: "modele" },
        decision: {
          enabled: true,
          endpoint: "https://decision.test/v1/systemone",
          model: "mammoth-1",
          apiKey: "nw-test",
        },
        summary: { ...DEFAULT_SUMMARY, llmConsent: true },
        aiTasks: { enabled: false },
      }),
    );
    const jsonReply = (payload: unknown) =>
      ({ ok: true, status: 200, statusText: "", json: async () => payload }) as unknown as Response;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const { pathname } = new URL(String(input), "http://localhost");
      const path = decodeURIComponent(pathname);
      if (path.endsWith("/chat/completions")) {
        return jsonReply({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  accroche: "1 rendez-vous proposé.",
                  actions: [{ mailId: "alpha:INBOX:1", raison: "Confirmer le point jeudi", echeance: isoToday(1) }],
                  infos: [],
                  notifications: [],
                  taches: [],
                }),
              },
            },
          ],
        });
      }
      if (path.endsWith("/api/ai/decisions/triage")) {
        return jsonReply({
          results: [
            {
              decision: {
                account_id: "alpha",
                folder_path: "INBOX",
                uid: 1,
                message_id: "<1@test.fr>",
                content_hash: "h1",
                schema_version: 1,
                model: "mammoth-1",
                category: "important",
                category_conf: 0.92,
                category_probs: { important: 0.92 },
                urgency: 2.3,
                needs_reply: 0.85,
                has_task: 0.2,
                has_event: 0.88,
                security: "safe",
                security_conf: 0.99,
                cleanup_score: 0.05,
                decided_at: Math.floor(Date.now() / 1000),
                source: "local",
              },
              cached: false,
            },
          ],
          errors: [],
        });
      }
      if (path.endsWith("/api/accounts")) {
        return jsonReply([
          {
            id: "alpha",
            label: "alpha",
            email: "alpha@test.fr",
            username: "alpha@test.fr",
            imap: { host: "imap.test", port: 993, encryption: "tls" },
            smtp: { host: "smtp.test", port: 465, encryption: "tls" },
            folders: 1,
          },
        ]);
      }
      if (path.endsWith("/api/accounts/alpha/folders")) {
        return jsonReply([
          {
            account_id: "alpha",
            path: "INBOX",
            name: "Boîte de réception",
            role: "inbox",
            uidvalidity: 1,
            uidnext: 2,
            last_sync_at: null,
          },
        ]);
      }
      if (path.endsWith("/api/accounts/alpha/folders/INBOX/threads")) return jsonReply([apiThread]);
      return jsonReply([]);
    });

    mount();

    const body = await screen.findByTestId("summary-attachments-mobile");
    await waitFor(() => expect(screen.getByTestId("summary-source-mobile").textContent).toBe("Hybride"), {
      timeout: 3000,
    });
    expect(within(body).getByText("Urgent")).toBeTruthy();

    fireEvent.click(within(body).getByRole("button", { name: "+ Agenda" }));

    await waitFor(() =>
      expect(screen.getByTestId("suggestions").textContent).toContain("Point projet jeudi"),
    );
    const done = await within(body).findByRole("button", { name: "Ajouté" });
    expect((done as HTMLButtonElement).disabled).toBe(true);
  });

  it("affiche TOTP, Phishing, Factures + actions rapides sur mobile et masque l'accroche Décision", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const now = Date.now();
    const makeThread = (uid: number, from: string, email: string, subject: string) => {
      const msg = {
        account_id: "alpha",
        folder_path: "INBOX",
        uid,
        uidvalidity: 1,
        thread_id: `t-${uid}`,
        message_id: `<${uid}@test.fr>`,
        in_reply_to: null,
        references: [],
        from: { name: from, email },
        to: [{ name: null, email: "alpha@test.fr" }],
        cc: [],
        subject,
        date: new Date(now - uid * 60_000).toISOString(),
        flags: { unread: true, starred: false, answered: false },
        size: 512,
        pgp: "none",
        preview: subject,
        body_text: subject,
        body_html: null,
        attachments: [],
      };
      return {
        id: msg.thread_id,
        account_id: "alpha",
        messages: [msg],
        primary: msg,
        count: 1,
        unread: 1,
        starred: false,
        encrypted: 0,
        attachments: 0,
        participants: [email],
        subject,
        preview: subject,
      };
    };
    const threads = [
      makeThread(101, "GitHub Security", "noreply@github.com", "Code GitHub"),
      makeThread(102, "Banque", "alerte@phish.xyz", "Carte bloquée"),
      makeThread(103, "OVH", "factures@ovh.com", "Facture avril"),
    ];
    const baseDecision = (uid: number, overrides: Partial<MailDecision>): MailDecision => ({
      accountId: "alpha",
      folderPath: "INBOX",
      uid,
      messageId: `<${uid}@test.fr>`,
      contentHash: `h-${uid}`,
      schemaVersion: 1,
      model: "mammoth-1",
      category: "info",
      categoryConf: 0.95,
      categoryProbs: {},
      urgency: 0.8,
      needsReply: 0.1,
      hasTask: 0,
      hasEvent: 0,
      security: "safe",
      securityConf: 0.99,
      cleanupScore: 0.1,
      decidedAt: Math.floor(now / 1000),
      source: "synced",
      ...overrides,
    });
    await decisionDb().putDecisions([
      baseDecision(101, {
        category: "auth_totp",
        totpCode: "482917",
        totpService: "GitHub",
        urgency: 1.5,
      }),
      baseDecision(102, {
        category: "important",
        security: "phishing",
        securityConf: 0.96,
      }),
      baseDecision(103, {
        category: "custom:factures",
        suggestedFolder: "Factures",
        suggestedFolderConf: 0.94,
      }),
    ]);
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({
        decision: {
          enabled: false,
          customCategories: [
            {
              id: "factures",
              name: "Factures",
              description: "Factures",
              color: "emerald",
              excludeFromPriority: false,
              allowNotifications: true,
              cleanupEligible: false,
            },
          ],
        },
        summary: { ...DEFAULT_SUMMARY, llmConsent: false },
        aiTasks: { enabled: false },
      }),
    );
    const jsonReply = (payload: unknown) =>
      ({ ok: true, status: 200, statusText: "", json: async () => payload }) as unknown as Response;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const { pathname } = new URL(String(input), "http://localhost");
      const path = decodeURIComponent(pathname);
      if (path.endsWith("/api/accounts")) {
        return jsonReply([
          {
            id: "alpha",
            label: "alpha",
            email: "alpha@test.fr",
            username: "alpha@test.fr",
            imap: { host: "imap.test", port: 993, encryption: "tls" },
            smtp: { host: "smtp.test", port: 465, encryption: "tls" },
            folders: 1,
          },
        ]);
      }
      if (path.endsWith("/api/accounts/alpha/folders")) {
        return jsonReply([
          {
            account_id: "alpha",
            path: "INBOX",
            name: "Boîte de réception",
            role: "inbox",
            uidvalidity: 1,
            uidnext: 105,
            last_sync_at: null,
          },
        ]);
      }
      if (path.endsWith("/api/accounts/alpha/folders/INBOX/threads")) return jsonReply(threads);
      return jsonReply([]);
    });

    const onMailAction = vi.fn();
    mount({ onMailAction });

    const body = await screen.findByTestId("summary-attachments-mobile");
    await waitFor(() => expect(within(body).getByTestId("summary-totp-code-mobile")).toBeTruthy(), {
      timeout: 3000,
    });

    expect(screen.getByTestId("summary-source-mobile").textContent).toBe("Décision");
    // Accroche robotique masquée en mode Décision
    expect(screen.queryByText(/3 mails :/)).toBeNull();
    expect(within(body).getByText("Vérification & accès")).toBeTruthy();
    expect(within(body).getByText("Suspect · Phishing")).toBeTruthy();
    expect(within(body).getByText("Code · GitHub")).toBeTruthy();
    expect(within(body).getByTestId("summary-totp-code-mobile").textContent).toBe("482 917");
    expect(within(body).getByText("Factures")).toBeTruthy();
    expect(within(body).getByRole("button", { name: "Ranger dans Factures" })).toBeTruthy();

    fireEvent.click(within(body).getByRole("button", { name: "Copier" }));
    expect(writeText).toHaveBeenCalledWith("482917");
    expect(within(body).getByRole("button", { name: "Copié !" })).toBeTruthy();

    const deleteButtons = within(body).getAllByRole("button", { name: "Supprimer" });
    // Le bloc Vérification & accès (101) est tout en haut avant À traiter (102)
    fireEvent.click(deleteButtons[0]);
    fireEvent.click(deleteButtons[1]);
    expect(onMailAction).toHaveBeenCalledTimes(2);
    expect((onMailAction.mock.calls[0][1] as Mail).id).toBe("alpha:INBOX:101");
    expect((onMailAction.mock.calls[1][1] as Mail).id).toBe("alpha:INBOX:102");
  });
});
