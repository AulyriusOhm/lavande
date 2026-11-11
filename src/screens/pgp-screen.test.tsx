import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PgpKey } from "@/lib/pgp";

const { listKeys, generateKey, importKey, exportKey, deleteKey, notify } = vi.hoisted(() => ({
  listKeys: vi.fn(),
  generateKey: vi.fn(),
  importKey: vi.fn(),
  exportKey: vi.fn(),
  deleteKey: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@/lib/pgp-api", () => ({ listKeys, generateKey, importKey, exportKey, deleteKey }));
vi.mock("@/lib/store", () => ({ useMailStore: () => ({ notify }) }));
vi.mock("@/lib/prefs", () => ({
  usePrefs: () => ({
    pgpEncrypt: true,
    pgpSign: true,
    attachPublicKey: false,
    setPgpEncrypt: vi.fn(),
    setPgpSign: vi.fn(),
    setAttachPublicKey: vi.fn(),
  }),
}));

const { PgpScreen } = await import("@/screens/pgp-screen");

const KEY: PgpKey = {
  fingerprint: "9F3A71C4D0B85E624A1788CD2B907F31AE456C08",
  key_id: "2B907F31AE456C08",
  user_id: "Roman <roman@lavande.mail>",
  name: "Roman",
  email: "roman@lavande.mail",
  algorithm: "Curve25519 · Ed25519",
  created_at: "2026-03-12T10:00:00Z",
  expires_at: "2028-03-12T10:00:00Z",
  has_secret: true,
  revoked: false,
  expired: false,
};

const CONTACT: PgpKey = {
  ...KEY,
  fingerprint: "4B710E9C55A2B3D86F142C9077DE1A3B09F522C7",
  key_id: "77DE1A3B09F522C7",
  user_id: "Camille <camille@studio-lilas.fr>",
  name: "Camille",
  email: "camille@studio-lilas.fr",
  has_secret: false,
  expires_at: "2024-01-04T09:30:00Z",
};

beforeEach(() => {
  listKeys.mockReset().mockResolvedValue([KEY, CONTACT]);
  generateKey.mockReset();
  importKey.mockReset();
  exportKey.mockReset();
  deleteKey.mockReset().mockResolvedValue(undefined);
  notify.mockReset();
});

describe("PgpScreen", () => {
  it("liste les clés réelles du démon et leur état", async () => {
    render(<PgpScreen onClose={() => {}} />);

    expect(await screen.findByText("Roman")).toBeTruthy();
    expect(screen.getByText("Camille")).toBeTruthy();
    expect(screen.getAllByText("clé valide").length).toBe(1);
    expect(screen.getByText("clé expirée")).toBeTruthy();
    expect(screen.getByText("2 clés")).toBeTruthy();
  });

  it("affiche un état vide quand le trousseau est vide", async () => {
    listKeys.mockResolvedValue([]);
    render(<PgpScreen onClose={() => {}} />);

    expect(await screen.findByText("Aucune clé dans le trousseau")).toBeTruthy();
  });

  it("remonte l'erreur du démon", async () => {
    listKeys.mockRejectedValue(new Error("démon injoignable"));
    render(<PgpScreen onClose={() => {}} />);

    expect(await screen.findByText("démon injoignable")).toBeTruthy();
  });

  it("génère une clé depuis le formulaire", async () => {
    generateKey.mockResolvedValue({ key: KEY, public_key: "-----BEGIN PGP PUBLIC KEY BLOCK-----" });
    render(<PgpScreen onClose={() => {}} />);
    await screen.findByText("Roman");

    fireEvent.click(screen.getByText("Générer une clé"));
    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Roman" } });
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "roman@lavande.mail" } });
    fireEvent.click(screen.getByText("Générer"));

    await waitFor(() =>
      expect(generateKey).toHaveBeenCalledWith({ name: "Roman", email: "roman@lavande.mail" }),
    );
    expect(notify).toHaveBeenCalledWith("Clé générée · Roman");
    expect(await screen.findByText("Copier la clé publique")).toBeTruthy();
  });

  it("supprime une clé après confirmation", async () => {
    render(<PgpScreen onClose={() => {}} />);
    fireEvent.click(await screen.findByText("Roman"));
    fireEvent.click(screen.getByText("Supprimer la clé"));
    fireEvent.click(screen.getByText("Supprimer"));

    await waitFor(() => expect(deleteKey).toHaveBeenCalledWith(KEY.fingerprint));
    expect(notify).toHaveBeenCalledWith("Clé supprimée · Roman");
  });
});
