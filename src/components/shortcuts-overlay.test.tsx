import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ShortcutsOverlay } from "@/components/shortcuts-overlay";
import { defineShortcuts } from "@/lib/shortcuts";

const shortcuts = defineShortcuts([
  {
    id: "compose",
    keys: "mod+n",
    group: "Actions",
    label: "Nouveau message",
    description: "Ouvrir la rédaction",
    run: () => {},
  },
  {
    id: "view-calendar",
    keys: "mod+2",
    group: "Navigation",
    label: "Agenda",
    description: "Ouvrir le calendrier",
    when: () => false,
    run: () => {},
  },
  {
    id: "help",
    keys: "?",
    group: "Aide",
    label: "Raccourcis clavier",
    description: "Afficher cette liste",
    run: () => {},
  },
]);

describe("overlay des raccourcis", () => {
  it("liste les raccourcis disponibles avec leurs touches", () => {
    render(<ShortcutsOverlay open onClose={() => {}} shortcuts={shortcuts} mod="ctrl" />);

    const dialog = screen.getByRole("dialog", { name: "Raccourcis clavier" });
    expect(dialog).toBeTruthy();
    expect(screen.getByText("Nouveau message")).toBeTruthy();
    expect(screen.getByText("Ctrl")).toBeTruthy();
    expect(screen.getByText("Actions")).toBeTruthy();
    expect(screen.getByText("Aide")).toBeTruthy();
  });

  it("masque les raccourcis indisponibles", () => {
    render(<ShortcutsOverlay open onClose={() => {}} shortcuts={shortcuts} mod="ctrl" />);
    expect(screen.queryByText("Agenda")).toBeNull();
    expect(screen.queryByText("Navigation")).toBeNull();
  });

  it("n'affiche rien quand elle est fermée", () => {
    render(<ShortcutsOverlay open={false} onClose={() => {}} shortcuts={shortcuts} mod="ctrl" />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("se ferme au clic sur le fond ou sur la croix", () => {
    const onClose = vi.fn();
    render(<ShortcutsOverlay open onClose={onClose} shortcuts={shortcuts} mod="ctrl" />);

    fireEvent.click(screen.getByLabelText("Fermer les raccourcis clavier"));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Fermer"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
