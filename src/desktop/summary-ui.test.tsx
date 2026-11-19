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

/** Mails indexés par le briefing de test : trois groupes, deux pièces jointes. */
const BRIEFING_MAILS: Mail[] = ["3", "8", "1", "4", "2", "6", "7"].map(byId);

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
    onOpen?: (id: string) => void;
    onReply?: (mail: Mail) => void;
    onPropose?: (ref: { mailId: string; reason: string; due?: string }) => "added" | "existing";
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
      mails={BRIEFING_MAILS}
      loading={false}
      onToggle={() => {}}
      onOpen={handlers.onOpen ?? (() => {})}
      onRefresh={() => {}}
      onReply={handlers.onReply ?? (() => {})}
      onPropose={handlers.onPropose ?? (() => "added")}
    />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
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
    expect(card.textContent).toMatch(/Généré à \d{2}:\d{2}/);
    expect(card.textContent).toContain("local");
    expect(card.textContent).toContain("mails analysés");
  });

  it("n'affiche pas de chips pièces jointes dans le briefing", async () => {
    stubBackend();
    mount(<DesktopInbox onOpenSearch={() => {}} />);

    const card = await screen.findByTestId("morning-summary");
    await waitFor(() => expect(within(card).getByTestId("summary-attachments")).toBeTruthy());

    const groups = within(card).getByTestId("summary-attachments");
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
    expect(card.textContent).toContain("Généré à 08:12");
    expect(card.textContent).toContain("mis en cache");
    expect(card.textContent).toContain("7 mails analysés");
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

  it("ouvre le mail depuis l'objet ou « Voir le mail »", () => {
    const onOpen = vi.fn();
    renderSummary(briefing(), { onOpen });
    const card = screen.getByTestId("morning-summary");

    fireEvent.click(within(card).getByRole("button", { name: "Devis signé — retour de ma part" }));
    const seeMail = within(card)
      .getAllByRole("button", { name: "Voir le mail" })
      .at(0) as HTMLButtonElement;
    fireEvent.click(seeMail);

    expect(onOpen.mock.calls.map((call) => call[0])).toEqual(["3", "3"]);
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
