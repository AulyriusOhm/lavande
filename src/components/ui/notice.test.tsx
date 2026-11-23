import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Notice, noticeDuration } from "@/components/ui/notice";

const LONG =
  "connexion chiffrée : outlook.office365.com (52.101.73.14:993) : délai dépassé";

describe("Notice", () => {
  it("affiche le message entier", () => {
    render(<Notice notice={{ id: 1, message: LONG }} onClose={() => {}} />);
    expect(screen.getByRole("status").textContent).toBe(LONG);
  });

  it("se ferme au clic sur le message", () => {
    const onClose = vi.fn();
    render(<Notice notice={{ id: 1, message: LONG }} onClose={onClose} />);
    fireEvent.click(screen.getByRole("status"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ne double pas la fermeture quand on clique sur l'action", () => {
    const onClose = vi.fn();
    const run = vi.fn();
    render(
      <Notice
        notice={{ id: 1, message: LONG, actionLabel: "Réessayer", onAction: run }}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reste affichée plus longtemps quand le message est long", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<Notice notice={{ id: 1, message: LONG }} onClose={onClose} />);
    act(() => vi.advanceTimersByTime(4200));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(10_000));
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("noticeDuration", () => {
  it("garde 4,2 s pour un message court et plafonne à 10 s", () => {
    expect(noticeDuration("Message envoyé")).toBe(4200);
    expect(noticeDuration("x".repeat(500))).toBe(10_000);
  });

  it("respecte la durée fournie comme base", () => {
    expect(noticeDuration("Message envoyé", 2000)).toBe(2000);
  });
});
