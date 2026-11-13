import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { EventSuggestionCard } from "@/components/event-suggestion-card";
import type { Mail } from "@/lib/mail";
import { MAIL_SUGGESTIONS, type MailSuggestion } from "@/lib/tasks";

const MEETING: MailSuggestion = {
  ...MAIL_SUGGESTIONS[0],
  id: "sg-rdv",
  kind: "event",
  account: "perso",
  mailId: "1",
  from: "Camille Rousseau",
  proposal: "Atelier budget",
  due: "",
  dueTone: "none",
  date: "2026-11-20",
  start: "10:00",
  end: "10:30",
  location: "Visio",
};

const MAIL = { id: "1", subject: "Maquettes v3" } as Mail;

function mount({
  suggestion = MEETING,
  mail = MAIL,
  onAccept = () => {},
  onOpenMail = () => {},
  onDismiss = () => {},
}: {
  suggestion?: MailSuggestion;
  mail?: Mail | null;
  onAccept?: () => void;
  onOpenMail?: (mail: Mail) => void;
  onDismiss?: () => void;
} = {}) {
  return render(
    <EventSuggestionCard
      suggestion={suggestion}
      account="Perso"
      mail={mail ?? undefined}
      onAccept={onAccept}
      onOpenMail={onOpenMail}
      onDismiss={onDismiss}
    />,
  );
}

describe("Carte de suggestion de RDV", () => {
  it("affiche le compte, l'expéditeur, la proposition, le créneau et le lieu", () => {
    mount();

    expect(screen.getByTestId("event-suggestion-account").textContent).toBe("Perso");
    expect(screen.getByText("Camille Rousseau")).toBeTruthy();
    expect(screen.getByText("Atelier budget")).toBeTruthy();
    expect(screen.getByTestId("event-suggestion-when").textContent).toContain("10:00 → 10:30");
    expect(screen.getByText("Visio")).toBeTruthy();
  });

  it("retombe sur l'échéance de la suggestion sans créneau", () => {
    mount({ suggestion: { ...MEETING, date: undefined, start: undefined, end: undefined, due: "vendredi" } });

    expect(screen.getByTestId("event-suggestion-when").textContent).toBe("vendredi");
  });

  it("n'affiche aucune ligne d'horaire sans jour ni échéance", () => {
    mount({
      suggestion: { ...MEETING, date: undefined, start: undefined, end: undefined, due: "", location: undefined },
    });

    expect(screen.queryByTestId("event-suggestion-when")).toBeNull();
    expect(screen.queryByText("Visio")).toBeNull();
  });

  it("remonte l'acceptation et le rejet de la suggestion", () => {
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    mount({ onAccept, onDismiss });

    fireEvent.click(screen.getByRole("button", { name: "Accepter : Atelier budget" }));
    fireEvent.click(screen.getByRole("button", { name: "Ignorer la suggestion" }));

    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("ouvre le mail source quand il est chargé", () => {
    const onOpenMail = vi.fn<(mail: Mail) => void>();
    mount({ onOpenMail });

    fireEvent.click(screen.getByRole("button", { name: "Ouvrir le mail" }));

    expect(onOpenMail).toHaveBeenCalledWith(MAIL);
  });

  it("masque le lien mail quand le mail source n'est pas chargé", () => {
    mount({ mail: null });

    expect(screen.queryByRole("button", { name: "Ouvrir le mail" })).toBeNull();
  });

  it("garde des cibles tactiles d'au moins 44 px sur mobile", () => {
    mount();

    for (const name of ["Accepter : Atelier budget", "Ouvrir le mail", "Ignorer la suggestion"]) {
      expect(screen.getByRole("button", { name }).className).toContain("max-sm:min-h-11");
    }
  });
});
