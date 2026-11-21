import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TotpPopup } from "@/components/totp-popup";

const ALERT = {
  code: "482917",
  service: "GitHub",
  mailId: "perso:INBOX:42",
  receivedAt: 1_731_000_000_000,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TotpPopup", () => {
  it("n'affiche rien quand alert est null", () => {
    const { container } = render(<TotpPopup alert={null} onDismiss={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("affiche le service et le code formaté en monospace espacé", () => {
    render(<TotpPopup alert={ALERT} onDismiss={vi.fn()} onOpenMail={vi.fn()} onMarkRead={vi.fn()} />);

    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByTestId("totp-code-value").textContent).toBe("482 917");
  });

  it("copie le code brut, affiche « Copié ! » puis ferme proprement", () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onDismiss = vi.fn();

    render(<TotpPopup alert={ALERT} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: /Copier/i }));
    expect(writeText).toHaveBeenCalledWith("482917");
    expect(screen.getByText("Copié !")).toBeTruthy();
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("déclenche Lu, Ouvrir et Fermer correctement", () => {
    const onDismiss = vi.fn();
    const onMarkRead = vi.fn();
    const onOpenMail = vi.fn();

    render(
      <TotpPopup
        alert={ALERT}
        onDismiss={onDismiss}
        onMarkRead={onMarkRead}
        onOpenMail={onOpenMail}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Marquer comme lu/i }));
    expect(onMarkRead).toHaveBeenCalledWith(ALERT.mailId);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Ouvrir le mail/i }));
    expect(onOpenMail).toHaveBeenCalledWith(ALERT.mailId);
    expect(onDismiss).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
    expect(onDismiss).toHaveBeenCalledTimes(3);
  });

  it("se ferme automatiquement après 90 secondes", () => {
    const onDismiss = vi.fn();
    render(<TotpPopup alert={ALERT} onDismiss={onDismiss} />);

    act(() => {
      vi.advanceTimersByTime(89_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
