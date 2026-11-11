import { beforeEach, describe, expect, it, vi } from "vitest";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("@/lib/api", () => ({ request }));

const { deleteKey, exportKey, generateKey, importKey, listKeys } = await import("@/lib/pgp-api");
const { formatFingerprint, isExpired, keyState, messagePgpStatus } = await import("@/lib/pgp");
import type { PgpKey } from "@/lib/pgp";

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

beforeEach(() => {
  request.mockReset();
});

describe("pgp-api", () => {
  it("liste les clés et déballe `keys`", async () => {
    request.mockResolvedValue({ keys: [KEY] });

    await expect(listKeys()).resolves.toEqual([KEY]);
    expect(request).toHaveBeenCalledWith("/pgp/keys", { signal: undefined });
  });

  it("génère une paire avec un délai long", async () => {
    request.mockResolvedValue({ key: KEY, public_key: "-----BEGIN PGP PUBLIC KEY BLOCK-----" });

    const result = await generateKey({ name: "Roman", email: "roman@lavande.mail" });

    expect(result.public_key).toContain("BEGIN PGP");
    expect(request).toHaveBeenCalledWith("/pgp/keys/generate", {
      method: "POST",
      body: { name: "Roman", email: "roman@lavande.mail" },
      timeout: 120_000,
    });
  });

  it("importe un bloc armored et déballe `key`", async () => {
    request.mockResolvedValue({ key: KEY });

    await expect(importKey("-----BEGIN PGP PUBLIC KEY BLOCK-----")).resolves.toEqual(KEY);
    expect(request).toHaveBeenCalledWith("/pgp/keys/import", {
      method: "POST",
      body: { armored: "-----BEGIN PGP PUBLIC KEY BLOCK-----" },
    });
  });

  it("exporte la clé publique d'une empreinte encodée", async () => {
    request.mockResolvedValue({ public_key: "armored" });

    await expect(exportKey(KEY.fingerprint)).resolves.toBe("armored");
    expect(request).toHaveBeenCalledWith(
      `/pgp/keys/${encodeURIComponent(KEY.fingerprint)}/export`,
    );
  });

  it("supprime une clé en DELETE", async () => {
    request.mockResolvedValue(undefined);

    await deleteKey(KEY.fingerprint);
    expect(request).toHaveBeenCalledWith(`/pgp/keys/${encodeURIComponent(KEY.fingerprint)}`, {
      method: "DELETE",
    });
  });
});

describe("pgp", () => {
  it("déduit l'état d'une clé de ses dates ISO", () => {
    expect(keyState(KEY, new Date("2027-01-01T00:00:00Z"))).toBe("valid");
    expect(keyState(KEY, new Date("2029-01-01T00:00:00Z"))).toBe("expired");
    expect(keyState({ ...KEY, revoked: true })).toBe("revoked");
    expect(keyState({ ...KEY, expired: true })).toBe("expired");
    expect(isExpired({ ...KEY, expires_at: null })).toBe(false);
  });

  it("groupe les empreintes par blocs de 4", () => {
    expect(formatFingerprint("9f3a71c4d0b85e62")).toBe("9F3A 71C4 D0B8 5E62");
  });

  it("traduit `pgp` + `pgp_detail` en statut lisible", () => {
    expect(messagePgpStatus({ pgp: "none" })).toBeNull();
    expect(messagePgpStatus({ pgp: "signed" })).toMatchObject({
      verification: null,
      decrypted: false,
    });
    expect(
      messagePgpStatus({
        pgp: "encrypted",
        pgp_detail: { verified: true, signer: "Camille", decrypted: true, error: null },
      }),
    ).toEqual({
      state: "encrypted",
      verification: "verified",
      decrypted: true,
      signer: "Camille",
      error: null,
    });
    expect(
      messagePgpStatus({
        pgp: "signed",
        pgp_detail: { verified: false, signer: null, decrypted: false, error: "clé absente" },
      }),
    ).toMatchObject({ verification: "invalid", error: "clé absente" });
  });
});
