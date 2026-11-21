import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReauthPopup } from "@/components/reauth-popup";

const ALERT = {
  accountId: "gmail",
  label: "Gmail",
  email: "roman.lanro@gmail.com",
};

describe("ReauthPopup", () => {
  it("n'affiche rien quand alert est null", () => {
    const { container } = render(
      <ReauthPopup alert={null} onDismiss={vi.fn()} onReconnect={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("affiche le compte et l'invitation à se reconnecter", () => {
    render(<ReauthPopup alert={ALERT} onDismiss={vi.fn()} onReconnect={vi.fn()} />);

    expect(screen.getByText("Connexion expirée")).toBeTruthy();
    expect(screen.getByText("Gmail")).toBeTruthy();
    expect(screen.getByText(ALERT.email)).toBeTruthy();
    expect(screen.getByText(/Reconnecte-toi pour reprendre la synchronisation/)).toBeTruthy();
    expect(screen.getByRole("alert").getAttribute("aria-label")).toBe(
      "Connexion expirée pour Gmail",
    );
  });

  it("reconnecte le compte sans refermer le popup", () => {
    const onDismiss = vi.fn();
    const onReconnect = vi.fn();

    render(<ReauthPopup alert={ALERT} onDismiss={onDismiss} onReconnect={onReconnect} />);
    fireEvent.click(screen.getByRole("button", { name: /Se reconnecter/i }));

    expect(onReconnect).toHaveBeenCalledWith(ALERT.accountId);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("se ferme par la croix", () => {
    const onDismiss = vi.fn();

    render(<ReauthPopup alert={ALERT} onDismiss={onDismiss} onReconnect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
