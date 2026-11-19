import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
function seedSummary(headline: string, groups: SummaryResult["groups"]) {
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
    source: "llm",
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

function mount(spies: { onOpen?: (mail: Mail) => void; onReply?: (mail: Mail) => void } = {}) {
  function Host() {
    const navigationRef = useRef<MailNavigation | null>(null);
    const { suggestions } = useMailStore();
    return (
      <>
        <output data-testid="suggestions">{suggestions.map((entry) => entry.proposal).join("|")}</output>
        <InboxScreen
          mails={MAILS}
          account="all"
          folder="inbox"
          active
          navigationRef={navigationRef}
          onOpenAccounts={() => {}}
          onOpenFolders={() => {}}
          onOpen={spies.onOpen ?? (() => {})}
          onToggleStar={() => {}}
          onSearch={() => {}}
          onMailAction={() => {}}
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

beforeEach(() => {
  window.localStorage.clear();
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

describe("Boîte de réception mobile · résumé périodique", () => {
  it("affiche l'accroche et les informations sans chips pièces jointes", async () => {
    mount();

    const body = await screen.findByTestId("summary-attachments-mobile");

    expect(body.textContent).toContain("Pour info");
    expect(body.querySelectorAll("button[title]")).toHaveLength(0);
    expect(body.textContent).not.toContain("inbox-v3.fig");
    expect(body.textContent).not.toContain("specs-mobile.pdf");
    expect(screen.getByTestId("summary-source-mobile").textContent).toBe("local");
    expect(screen.getByTestId("summary-footer-mobile").textContent).toContain("Généré à");
    expect(screen.getByTestId("summary-footer-mobile").textContent).toContain("local");
  });

  it("affiche le briefing du modèle : actions, échéance, notifications repliées et cache", async () => {
    seedSummary("7 mails sur 24 h · 1 action attendue, 2 pour info, 3 notifications.", {
      actions: [{ mailId: "3", reason: "Renvoyer l'avenant signé", due: isoToday(0) }],
      infos: [{ mailId: "1", reason: "" }, { mailId: "4", reason: "" }],
      notifications: [{ mailId: "2", reason: "" }, { mailId: "6", reason: "" }, { mailId: "7", reason: "" }],
    });
    mount();

    const body = await screen.findByTestId("summary-attachments-mobile");
    await waitFor(() => expect(within(body).getByText("Renvoyer l'avenant signé")).toBeTruthy());

    expect(within(body).getByText("À traiter")).toBeTruthy();
    expect(within(body).getByText("Pour info")).toBeTruthy();
    expect(within(body).getByText("aujourd'hui")).toBeTruthy();
    expect(screen.getByTestId("summary-source-mobile").textContent).toBe("IA");
    expect(screen.getByTestId("summary-footer-mobile").textContent).toContain("Généré à 08:12");
    expect(screen.getByTestId("summary-footer-mobile").textContent).toContain("mis en cache");

    const fold = within(body).getByRole("button", { name: /Notifications & listes · 3/ });
    expect(within(body).queryByText("[lavande] Rust backend: 3 pull requests")).toBeNull();

    fireEvent.click(fold);
    expect(within(body).getByText("[lavande] Rust backend: 3 pull requests")).toBeTruthy();
    expect(fold.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(fold);
    expect(within(body).queryByText("[lavande] Rust backend: 3 pull requests")).toBeNull();
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
});
