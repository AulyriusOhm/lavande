import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "@/App";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const help = () => screen.queryByRole("dialog", { name: "Raccourcis clavier" });

describe("raccourcis · intégration bureau", () => {
  it("navigue, crée et affiche l'aide au clavier", async () => {
    window.history.replaceState(null, "", "?desktop");
    render(<App />);
    await waitFor(() => expect(document.querySelector("[data-desktop]")).toBeTruthy(), { timeout: 5000 });

    fireEvent.keyDown(window, { key: "/", ctrlKey: true });
    await waitFor(() => expect(help()).toBeTruthy());
    const dialog = help() as HTMLElement;
    expect(within(dialog).getByText("Boîte de réception")).toBeTruthy();
    expect(within(dialog).getByText("Rechercher")).toBeTruthy();
    expect(within(dialog).getAllByText("Ctrl").length).toBeGreaterThan(0);

    fireEvent.keyDown(window, { key: "/", ctrlKey: true });
    await waitFor(() => expect(help()).toBeNull());

    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    await waitFor(() => expect(help()).toBeTruthy());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(help()).toBeNull());

    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    await waitFor(() => expect(window.location.hash).toBe("#calendar"));

    fireEvent.keyDown(window, { key: "n", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Nouveau rendez-vous" })).toBeTruthy());

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Recherche globale" })).toBeTruthy());
  });
});
