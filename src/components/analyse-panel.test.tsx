import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AnalysePanel } from "@/components/analyse-panel";
import type { AnalyseResult } from "@/lib/analyse";
import type { MailAnalyse } from "@/lib/store";
import type { Mail } from "@/lib/mail";
import { formatDueDate, isoToday } from "@/lib/tasks";

const DUE = isoToday(3);
const DAY = isoToday(2);

const MAIL = {
  id: "alpha:INBOX:1",
  account: "alpha",
  folder: "inbox",
  name: "Camille",
  email: "camille@test.fr",
  subject: "Maquettes v3 et point de suivi",
  preview: "Peux-tu envoyer le compte rendu ?",
  body: ["Peux-tu envoyer le compte rendu ?"],
  time: "09:12",
  unread: true,
  starred: false,
  pgp: "none",
  tone: 0,
} as Mail;

const RESULT: AnalyseResult = {
  mailId: MAIL.id,
  tasks: [
    { title: "Envoyer le compte rendu", due: DUE, from: "Camille", mailId: MAIL.id, assignee: "Camille" },
  ],
  events: [
    {
      title: "Point maquettes",
      date: DAY,
      start: "14:00",
      end: "15:00",
      location: "Visio",
      from: "Camille",
      mailId: MAIL.id,
    },
  ],
  conflicts: [
    {
      proposed: {
        title: "Point maquettes",
        date: DAY,
        start: "14:00",
        end: "15:00",
        location: "Visio",
        from: "Camille",
        mailId: MAIL.id,
      },
      event: {
        id: "ev-1",
        title: "Revue produit",
        date: DAY,
        start: "14:30",
        end: "15:30",
        tone: 0,
      },
    },
  ],
  slots: [{ date: DAY, start: "08:00", end: "14:30" }],
  reply: "Bonjour Camille,\n\nLe créneau de 14 h est déjà pris.",
  generatedAt: new Date("2026-01-05T09:12:00").getTime(),
  source: "llm",
};

const ready = (overrides: Partial<AnalyseResult> = {}): MailAnalyse => ({
  mailId: MAIL.id,
  status: "ready",
  result: { ...RESULT, ...overrides },
  error: null,
});

function mount(analyse: MailAnalyse, handlers: Partial<Parameters<typeof AnalysePanel>[0]> = {}) {
  return render(
    <AnalysePanel
      analyse={analyse}
      mail={MAIL}
      variant="desktop"
      onClose={vi.fn()}
      onAcceptTask={vi.fn()}
      onAcceptEvent={vi.fn()}
      onUseReply={vi.fn()}
      onRetry={vi.fn()}
      {...handlers}
    />,
  );
}

describe("panneau d'analyse · contenu", () => {
  it("affiche les sections, la tâche assignée et le rendez-vous", () => {
    mount(ready());

    expect(screen.getByTestId("analyse-panel")).toBeTruthy();
    expect(screen.getByText("Analyse IA")).toBeTruthy();
    expect(screen.getByText(MAIL.subject)).toBeTruthy();
    expect(screen.getByText("Tâches détectées · 1")).toBeTruthy();
    expect(screen.getByTestId("analyse-task")).toBeTruthy();
    expect(screen.getByText("Envoyer le compte rendu")).toBeTruthy();
    expect(screen.getByText(formatDueDate(DUE))).toBeTruthy();
    expect(screen.getByText("Camille")).toBeTruthy();
    expect(screen.getByText("Rendez-vous proposés · 1")).toBeTruthy();
    expect(screen.getByTestId("analyse-event")).toBeTruthy();
    expect(screen.getByText("Visio")).toBeTruthy();
    expect(screen.getByTestId("analyse-reply")).toBeTruthy();
    expect(screen.getByText(/Généré à 09:12 · IA/)).toBeTruthy();
  });

  it("signale le conflit d'agenda du rendez-vous proposé", () => {
    mount(ready());

    const badge = screen.getByTestId("analyse-conflict");
    expect(badge.textContent).toContain("Conflit : Revue produit · 14:30-15:30");
  });

  it("affiche les créneaux libres quand aucun conflit n'est détecté", () => {
    mount(ready({ conflicts: [] }));

    expect(screen.queryByTestId("analyse-conflict")).toBeNull();
    expect(screen.getByText("Créneaux libres")).toBeTruthy();
    expect(screen.getAllByText("08:00–14:30").length).toBeGreaterThan(1);
  });

  it("masque les sections vides", () => {
    mount(ready({ tasks: [], events: [], conflicts: [], slots: [], reply: undefined }));

    expect(screen.queryByTestId("analyse-task")).toBeNull();
    expect(screen.queryByTestId("analyse-event")).toBeNull();
    expect(screen.queryByTestId("analyse-reply")).toBeNull();
    expect(screen.queryByText(/Tâches détectées/)).toBeNull();
    expect(screen.queryByText("Créneaux libres")).toBeNull();
  });

  it("explique l'absence de modèle quand l'analyse est locale et vide", () => {
    mount(
      ready({ tasks: [], events: [], conflicts: [], slots: [], reply: undefined, source: "local" }),
    );

    expect(
      screen.getByText("Configure un modèle dans Réglages → IA pour analyser ce mail."),
    ).toBeTruthy();
    expect(screen.getByText(/Généré à 09:12 · local/)).toBeTruthy();
  });
});

describe("panneau d'analyse · états et actions", () => {
  it("affiche l'attente pendant l'analyse", () => {
    mount({ mailId: MAIL.id, status: "loading", result: null, error: null });

    expect(screen.getByText("Analyse en cours…")).toBeTruthy();
    expect(screen.queryByTestId("analyse-task")).toBeNull();
  });

  it("affiche l'erreur et relance au clic sur Réessayer", () => {
    const onRetry = vi.fn();
    mount({ mailId: MAIL.id, status: "error", result: null, error: "Réseau" }, { onRetry });

    expect(screen.getByText("Analyse impossible")).toBeTruthy();
    expect(screen.getByText("Réseau")).toBeTruthy();
    fireEvent.click(screen.getByText("Réessayer"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("accepte une tâche dans l'état choisi et un rendez-vous", () => {
    const onAcceptTask = vi.fn(() => true);
    const onAcceptEvent = vi.fn();
    mount(ready(), { onAcceptTask, onAcceptEvent });

    fireEvent.click(screen.getByText("Ajouter à la planif"));
    expect(onAcceptTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "En cours" }));
    expect(onAcceptTask).toHaveBeenCalledWith(RESULT.tasks[0], "doing");
    expect(screen.getByText("Ajoutée · En cours")).toBeTruthy();
    expect(screen.queryByText("Ajouter à la planif")).toBeNull();

    fireEvent.click(screen.getByText("Proposer à l'agenda"));
    expect(onAcceptEvent).toHaveBeenCalledWith(RESULT.events[0]);
  });

  it("annule le choix d'état sans rien ajouter", () => {
    const onAcceptTask = vi.fn(() => true);
    mount(ready(), { onAcceptTask });

    fireEvent.click(screen.getByText("Ajouter à la planif"));
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));

    expect(onAcceptTask).not.toHaveBeenCalled();
    expect(screen.getByText("Ajouter à la planif")).toBeTruthy();
  });

  it("garde la carte ajoutable quand l'ajout est refusé (doublon)", () => {
    const onAcceptTask = vi.fn(() => false);
    mount(ready(), { onAcceptTask });

    fireEvent.click(screen.getByText("Ajouter à la planif"));
    fireEvent.click(screen.getByRole("button", { name: "À faire" }));

    expect(onAcceptTask).toHaveBeenCalledWith(RESULT.tasks[0], "todo");
    expect(screen.queryByText(/Ajoutée ·/)).toBeNull();
    expect(screen.getByText("Ajouter à la planif")).toBeTruthy();
  });

  it("remet la réponse suggérée dans une réponse", () => {
    const onUseReply = vi.fn();
    mount(ready(), { onUseReply });

    fireEvent.click(screen.getByText("Utiliser dans une réponse"));
    expect(onUseReply).toHaveBeenCalledWith(RESULT.reply);
  });

  it("force une nouvelle analyse sur Réanalyser et ferme sur la croix", () => {
    const onRetry = vi.fn();
    const onClose = vi.fn();
    mount(ready(), { onRetry, onClose });

    fireEvent.click(screen.getByText("Réanalyser"));
    expect(onRetry).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Fermer l'analyse"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("panneau d'analyse · mobile", () => {
  it("s'ouvre en feuille et se ferme avec Échap", () => {
    const onClose = vi.fn();
    render(
      <AnalysePanel
        analyse={ready()}
        mail={MAIL}
        variant="mobile"
        onClose={onClose}
        onAcceptTask={vi.fn()}
        onAcceptEvent={vi.fn()}
        onUseReply={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Analyse IA" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
