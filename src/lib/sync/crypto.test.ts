import { describe, expect, it } from "vitest";
import {
  ARGON2_PARAMS,
  CRYPTO_VERSION,
  constantTimeEqual,
  decodeBase64Url,
  deriveAuthKey,
  deriveIndexKey,
  deriveKek,
  deriveMasterKey,
  encodeBase64Url,
  entityRef,
  generateDeviceKeys,
  openOp,
  randomCode,
  randomDek,
  randomSalt,
  sealOp,
  unwrapFromDevice,
  unwrapFromPassword,
  wrapForDevice,
  wrapForPassword,
  type OpMeta,
} from "./crypto";

const FAST = { t: 1, m: 64, p: 1, dkLen: 32 };
const PASSWORD = "correct horse batterie de stylos";

function masterKey(salt = randomSalt(), password = PASSWORD) {
  return deriveMasterKey(password, salt, FAST);
}

const META: OpMeta = {
  opId: "op-1",
  deviceId: "dev-1",
  entityRef: "ref-1",
  hlc: "0001-0001-dev-1",
  schemaVersion: 1,
};

describe("constantes", () => {
  it("expose la version et les paramètres Argon2id de référence", () => {
    expect(CRYPTO_VERSION).toBe(1);
    expect(ARGON2_PARAMS).toEqual({ t: 3, m: 65536, p: 1, dkLen: 32 });
  });
});

describe("deriveMasterKey", () => {
  it("dérive les mêmes octets pour les mêmes entrées", () => {
    const salt = randomSalt();
    const first = deriveMasterKey(PASSWORD, salt, FAST);
    const second = deriveMasterKey(PASSWORD, salt, FAST);
    expect(first).toEqual(second);
    expect(first).toHaveLength(32);
  });

  it("dérive des octets différents avec un autre sel", () => {
    const first = deriveMasterKey(PASSWORD, randomSalt(), FAST);
    const second = deriveMasterKey(PASSWORD, randomSalt(), FAST);
    expect(encodeBase64Url(first)).not.toBe(encodeBase64Url(second));
  });

  it("dérive des octets différents avec un autre mot de passe", () => {
    const salt = randomSalt();
    const first = deriveMasterKey(PASSWORD, salt, FAST);
    const second = deriveMasterKey(`${PASSWORD} `, salt, FAST);
    expect(encodeBase64Url(first)).not.toBe(encodeBase64Url(second));
  });
});

describe("dérivations HKDF", () => {
  it("produit authKey, kek et indexKey toutes distinctes", () => {
    const master = masterKey();
    const authKey = deriveAuthKey(master);
    const kek = deriveKek(master);
    const indexKey = deriveIndexKey(master);
    const encodées = [authKey, kek, indexKey].map(encodeBase64Url);
    expect(encodées[0]).toHaveLength(43);
    expect(new Set(encodées).size).toBe(3);
    expect(deriveAuthKey(master)).toEqual(authKey);
  });
});

describe("entityRef", () => {
  it("est stable, discrimine les voisins et masque l'identifiant", () => {
    const indexKey = deriveIndexKey(randomDek());
    const a = entityRef(indexKey, "task", "task-0001");
    const b = entityRef(indexKey, "task", "task-0002");
    expect(entityRef(indexKey, "task", "task-0001")).toBe(a);
    expect(b).not.toBe(a);
    expect(a).toHaveLength(22);
    expect(a).not.toContain("task-0001");
    expect(entityRef(indexKey, "suggestion", "task-0001")).not.toBe(a);
    expect(entityRef(deriveIndexKey(randomDek()), "task", "task-0001")).not.toBe(a);
  });
});

describe("génération aléatoire", () => {
  it("génère des DEK de 32 octets et des sels base64url uniques", () => {
    expect(randomDek()).toHaveLength(32);
    const sels = new Set([randomSalt(), randomSalt(), randomSalt(), randomSalt(32)]);
    expect(sels.size).toBe(4);
    expect(decodeBase64Url(randomSalt())).toHaveLength(16);
    expect(decodeBase64Url(randomSalt(32))).toHaveLength(32);
  });

  it("génère un code d'appairage court et sans caractères ambigus", () => {
    for (let i = 0; i < 50; i++) {
      const code = randomCode();
      expect(code).toMatch(/^[A-HJ-NP-Z2-7]{6,8}$/);
    }
    expect(randomCode(5)).toHaveLength(8);
    expect(() => randomCode(1)).toThrow();
  });
});

describe("base64url", () => {
  it("fait l'aller-retour sur toutes les longueurs utiles", () => {
    const source = randomDek();
    for (let size = 0; size <= source.length; size++) {
      const bytes = source.slice(0, size);
      expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes);
    }
  });

  it("produit un alphabet sans padding", () => {
    expect(encodeBase64Url(randomDek())).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(() => decodeBase64Url("abc$")).toThrow();
  });
});

describe("constantTimeEqual", () => {
  it("compare des octets sans court-circuit", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(constantTimeEqual(bytes, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(bytes, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(bytes, new Uint8Array([1, 2]))).toBe(false);
  });
});

describe("enveloppe par appareil", () => {
  it("enveloppe et déchiffre la DEK avec la clé privée de l'appareil", () => {
    const dek = randomDek();
    const device = generateDeviceKeys();
    expect(decodeBase64Url(device.pubKey)).toHaveLength(32);
    expect(decodeBase64Url(device.privKey)).toHaveLength(32);
    const envelope = wrapForDevice(dek, device.pubKey);
    expect(envelope.v).toBe(1);
    expect(envelope.ct).not.toContain(encodeBase64Url(dek));
    expect(unwrapFromDevice(envelope, device.privKey)).toEqual(dek);
  });

  it("refuse une autre clé privée", () => {
    const envelope = wrapForDevice(randomDek(), generateDeviceKeys().pubKey);
    expect(() => unwrapFromDevice(envelope, generateDeviceKeys().privKey)).toThrow();
  });

  it("refuse une altération d'un octet du chiffré", () => {
    const device = generateDeviceKeys();
    const envelope = wrapForDevice(randomDek(), device.pubKey);
    const ct = decodeBase64Url(envelope.ct);
    ct[0] ^= 0x01;
    expect(() => unwrapFromDevice({ ...envelope, ct: encodeBase64Url(ct) }, device.privKey)).toThrow();
  });
});

describe("enveloppe par mot de passe", () => {
  it("enveloppe et déchiffre la DEK avec la kek", () => {
    const dek = randomDek();
    const kek = deriveKek(masterKey());
    const envelope = wrapForPassword(dek, kek);
    expect(envelope.v).toBe(1);
    expect(unwrapFromPassword(envelope, kek)).toEqual(dek);
    expect(() => unwrapFromPassword(envelope, deriveKek(masterKey()))).toThrow();
  });
});

describe("opérations scellées", () => {
  const dek = randomDek();
  const payload = { title: "Relancer la démo", state: "todo", tags: ["client", "v3"] };

  it("fait l'aller-retour d'un payload objet", () => {
    const sealed = sealOp(dek, META, payload);
    expect(openOp(dek, META, sealed)).toEqual(payload);
  });

  it("lève si les métadonnées changent", () => {
    const sealed = sealOp(dek, META, payload);
    expect(() => openOp(dek, { ...META, hlc: `${META.hlc}-b` }, sealed)).toThrow();
    expect(() => openOp(dek, { ...META, opId: "op-2" }, sealed)).toThrow();
  });

  it("lève si la DEK est erronée", () => {
    const sealed = sealOp(dek, META, payload);
    expect(() => openOp(randomDek(), META, sealed)).toThrow();
  });

  it("lève si le payload déchiffré n'est pas un objet JSON", () => {
    const sealed = sealOp(dek, META, 42);
    expect(() => openOp(dek, META, sealed)).toThrow();
  });

  it("tire des nonces uniques", () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 100; i++) nonces.add(sealOp(dek, META, payload).nonce);
    expect(nonces.size).toBe(100);
  });
});
