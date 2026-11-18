import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useExternalLinks } from "@/lib/open-external";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const invokeMock = vi.mocked(invoke);

function Harness({ children }: { children: ReactNode }) {
  useExternalLinks();
  return createElement("div", null, children);
}

function mount() {
  render(
    createElement(
      Harness,
      null,
      createElement("a", { href: "https://exemple.fr/chemin?q=1#bas", id: "web" }, "Site"),
      createElement("a", { href: "#section", id: "fragment" }, "Ancre"),
      createElement("a", { href: "mailto:contact@exemple.fr", id: "mail" }, "Écrire"),
      createElement("a", { href: "tel:+33123456789", id: "tel" }, "Appeler"),
      createElement("a", { href: "?desktop", id: "relatif" }, "Maquette PC"),
      createElement("a", { href: "https://exemple.fr/fichier.pdf", id: "telechargement", download: "" }, "PDF"),
      createElement("a", { href: "//exemple.fr/protocole-relatif", id: "protocole" }, "Site"),
      createElement("button", { type: "button", id: "bouton" }, "Bouton"),
    ),
  );
}

const click = (id: string) => fireEvent.click(document.getElementById(id)!);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("useExternalLinks", () => {
  beforeEach(() => {
    vi.stubGlobal("open", vi.fn());
  });

  afterEach(() => {
    cleanup();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("ouvre les liens http(s) dans le navigateur système et bloque la navigation", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    mount();

    expect(click("web")).toBe(false);
    await settle();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("open_external", {
      url: "https://exemple.fr/chemin?q=1#bas",
    });
    expect(window.open).not.toHaveBeenCalled();
  });

  it("retombe sur window.open hors coquille Tauri", () => {
    mount();

    expect(click("web")).toBe(false);

    expect(window.open).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledWith(
      "https://exemple.fr/chemin?q=1#bas",
      "_blank",
      "noopener,noreferrer",
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("laisse les ancres internes, mailto:, tel:, les liens relatifs et les téléchargements au document", () => {
    mount();

    for (const id of ["fragment", "mail", "tel", "relatif", "telechargement"]) {
      expect(click(id)).toBe(true);
    }
    fireEvent.click(screen.getByRole("button", { name: "Bouton" }));

    expect(invokeMock).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it("capte aussi les ancres protocol-relatives", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    mount();

    expect(click("protocole")).toBe(false);
    await settle();

    expect(invokeMock).toHaveBeenCalledWith("open_external", {
      url: new URL("//exemple.fr/protocole-relatif", document.baseURI).href,
    });
  });

  it("capte le clic avant un gestionnaire qui remonte l'événement", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(
      createElement(
        Harness,
        null,
        createElement(
          "div",
          { onClick: (event: MouseEvent) => event.stopPropagation() },
          createElement("a", { href: "https://exemple.fr/nested", id: "nested" }, "Site"),
        ),
      ),
    );

    expect(click("nested")).toBe(false);
    await settle();

    expect(invokeMock).toHaveBeenCalledWith("open_external", { url: "https://exemple.fr/nested" });
  });
});
