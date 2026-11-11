import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PrefsProvider } from "@/lib/prefs";
import { SignatureEditor, signatureSeed } from "@/components/signature-editor";

const ACCOUNT = { id: "perso", label: "Perso", email: "roman@lavande.mail", tone: 0 };

const stored = () =>
  (JSON.parse(localStorage.getItem("lavande.prefs") ?? "{}") as {
    signatures?: Record<string, { html: string; enabled: boolean }>;
  }).signatures ?? {};

const renderEditor = () =>
  render(
    <PrefsProvider>
      <SignatureEditor account={ACCOUNT} />
    </PrefsProvider>,
  );

describe("signatureSeed", () => {
  it("signe le compte avec son nom et son adresse cliquable", () => {
    const html = signatureSeed(ACCOUNT);
    expect(html).toContain("<strong>Perso</strong>");
    expect(html).toContain('href="mailto:roman@lavande.mail"');
  });

  it("échappe le contenu du compte", () => {
    expect(signatureSeed({ id: "x", label: "A & B", email: "a@b.fr" })).toContain("A &amp; B");
  });
});

describe("SignatureEditor", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("propose de créer la signature quand elle est vide", () => {
    renderEditor();
    expect(screen.getByText("Crée ta signature…")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("crée et enregistre la signature du compte", async () => {
    renderEditor();
    fireEvent.click(screen.getByText("Créer ma signature"));

    await waitFor(() => expect(stored().perso?.enabled).toBe(true));
    expect(stored().perso?.html).toContain("roman@lavande.mail");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Aperçu")).toBeTruthy();
  });

  it("affiche une signature désactivée sans l'appliquer", async () => {
    localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ signatures: { perso: { html: "<p>— Perso</p>", enabled: false } } }),
    );
    renderEditor();

    expect(screen.getByText("en pause")).toBeTruthy();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/Signature désactivée/)).toBeTruthy();
  });
});
