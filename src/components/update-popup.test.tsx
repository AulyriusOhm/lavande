import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UpdatePopup, parseReleaseNotes } from "@/components/update-popup";
import { PrefsProvider } from "@/lib/prefs";
import type { UpdatePhase } from "@/lib/updater";

const state = vi.hoisted(() => ({
  supported: true,
  current: "0.2.13" as string | null,
  phase: { kind: "idle" } as UpdatePhase,
  install: vi.fn(),
}));

vi.mock("@/lib/updater", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/updater")>();
  return {
    ...actual,
    useUpdater: () => ({
      supported: state.supported,
      phase: state.phase,
      current: state.current,
      busy: false,
      canInstall: true,
      check: async () => null,
      install: state.install,
    }),
  };
});

const NOTES = [
  "## Correctifs",
  "- Libellés Gmail enfin lisibles",
  "- Fenêtre de réponse",
  "## Améliorations",
  "- Hauteurs de tableaux respectées",
].join("\n");

const AVAILABLE: UpdatePhase = { kind: "available", version: "0.2.14", notes: NOTES };
const DISMISS_KEY = "lavande:updater-popup-dismissed:0.2.14";

const popup = () => (
  <PrefsProvider>
    <UpdatePopup />
  </PrefsProvider>
);

const installButton = () => screen.getByRole("button", { name: /Installer la mise à jour/ });
const dialog = () => screen.queryByRole("alertdialog");

function installThen(phase: UpdatePhase) {
  const view = render(popup());
  fireEvent.click(installButton());
  state.phase = phase;
  view.rerender(popup());
  return view;
}

beforeEach(() => {
  window.sessionStorage.clear();
  state.supported = true;
  state.current = "0.2.13";
  state.phase = AVAILABLE;
  state.install.mockReset();
  state.install.mockResolvedValue(undefined);
});

describe("UpdatePopup", () => {
  it("annonce la version disponible avec son patchnote groupé", () => {
    render(popup());

    expect(screen.getByRole("alertdialog", { name: "Mise à jour Lavande 0.2.14" })).toBeTruthy();
    expect(screen.getByText("Lavande 0.2.14 est disponible")).toBeTruthy();
    expect(screen.getByText("Une nouvelle version prête à installer")).toBeTruthy();
    expect(screen.getByText("0.2.13 → 0.2.14")).toBeTruthy();
    expect(screen.getByText("Correctifs")).toBeTruthy();
    expect(screen.getByText("Améliorations")).toBeTruthy();
    expect(screen.getByText("Libellés Gmail enfin lisibles")).toBeTruthy();
    expect(screen.getByText("Hauteurs de tableaux respectées")).toBeTruthy();
    expect(document.activeElement).toBe(installButton());
  });

  it("n'affiche que la nouvelle version quand la version installée est inconnue", () => {
    state.current = null;
    render(popup());

    expect(screen.getByText("0.2.14")).toBeTruthy();
    expect(screen.queryByText(/→/)).toBeNull();
  });

  it("renvoie la mise à jour avec « Plus tard » et ne la repropose pas dans la session", () => {
    const view = render(popup());
    fireEvent.click(screen.getByRole("button", { name: "Plus tard" }));

    expect(dialog()).toBeNull();
    expect(window.sessionStorage.getItem(DISMISS_KEY)).toBe("1");

    view.unmount();
    render(popup());
    expect(dialog()).toBeNull();
  });

  it("renvoie avec Échap", () => {
    render(popup());
    fireEvent.keyDown(window, { key: "Escape" });

    expect(dialog()).toBeNull();
    expect(window.sessionStorage.getItem(DISMISS_KEY)).toBe("1");
  });

  it("renvoie au clic sur le voile", () => {
    render(popup());
    fireEvent.click(screen.getByTestId("update-popup-backdrop"));

    expect(dialog()).toBeNull();
    expect(window.sessionStorage.getItem(DISMISS_KEY)).toBe("1");
  });

  it("installe et suit la progression en pourcentage", () => {
    installThen({ kind: "downloading", version: "0.2.14", percent: 62 });

    expect(state.install).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeTruthy();
    expect(screen.getByText("Installation de la 0.2.14…")).toBeTruthy();
    expect(screen.getByText("Téléchargement · 62 %")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("62");
    expect(screen.queryByRole("button", { name: "Plus tard" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Annuler" })).toBeNull();
  });

  it("reste lisible quand la progression est indéterminée", () => {
    installThen({ kind: "downloading", version: "0.2.14", percent: null });

    expect(dialog()).toBeTruthy();
    expect(screen.getByText("Téléchargement…")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
  });

  it("passe en « Installation… » une fois le paquet téléchargé", () => {
    installThen({ kind: "installing", version: "0.2.14" });

    expect(screen.getByText("Installation…")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  });

  it("affiche l'erreur, réessaie et permet de fermer", () => {
    installThen({ kind: "error", message: "signature invalide" });

    expect(screen.getByRole("alert").textContent).toContain("signature invalide");

    fireEvent.click(screen.getByRole("button", { name: /Réessayer/ }));
    expect(state.install).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
    expect(dialog()).toBeNull();
    expect(window.sessionStorage.getItem(DISMISS_KEY)).toBe("1");
  });

  it("ne montre rien quand les mises à jour ne sont pas prises en charge", () => {
    state.supported = false;
    render(popup());

    expect(dialog()).toBeNull();
  });

  it("ne montre rien sans mise à jour disponible", () => {
    state.phase = { kind: "current" };
    render(popup());

    expect(dialog()).toBeNull();
  });

  it("saute la section patchnote quand les notes sont vides", () => {
    state.phase = { kind: "available", version: "0.2.14", notes: "   " };
    render(popup());

    expect(screen.getByText("Lavande 0.2.14 est disponible")).toBeTruthy();
    expect(screen.queryByText("Correctifs")).toBeNull();
    expect(screen.queryByText("Nouveautés")).toBeNull();
  });
});

describe("parseReleaseNotes", () => {
  it("groupe les items par titre", () => {
    expect(parseReleaseNotes("## Nouveautés\n- A\n- B\n## Correctifs\nAjusté")).toEqual([
      { title: "Nouveautés", items: ["A", "B"] },
      { title: "Correctifs", items: ["Ajusté"] },
    ]);
  });

  it("range tout sous « Nouveautés » sans titre", () => {
    expect(parseReleaseNotes("Première ligne\n- Deuxième")).toEqual([
      { title: "Nouveautés", items: ["Première ligne", "Deuxième"] },
    ]);
  });

  it("ignore les lignes vides et rogne les espaces", () => {
    expect(parseReleaseNotes("  \n\n  ## Titre  \n   -  item  \n\n")).toEqual([
      { title: "Titre", items: ["item"] },
    ]);
  });

  it("renvoie un tableau vide pour des notes vides, blanches ou sans item", () => {
    expect(parseReleaseNotes("")).toEqual([]);
    expect(parseReleaseNotes("   \n \t ")).toEqual([]);
    expect(parseReleaseNotes("## Titre sans item")).toEqual([]);
  });
});
