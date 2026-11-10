import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { argon2id } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, randomBytes } from "@noble/hashes/utils.js";

export const CRYPTO_VERSION = 1;

export type Argon2Params = { t: number; m: number; p: number; dkLen: number };

export const ARGON2_PARAMS: Argon2Params = { t: 3, m: 65536, p: 1, dkLen: 32 };

export type WrappedKey = { v: 1; ephPub: string; nonce: string; ct: string };

export type OpMeta = {
  opId: string;
  deviceId: string;
  entityRef: string;
  hlc: string;
  schemaVersion: number;
};

export type SealedOp = { nonce: string; ciphertext: string };

export type EntityKind = "task" | "suggestion";

const AUTH_INFO = "lavande/auth/v1";
const KEK_INFO = "lavande/kek/v1";
const INDEX_INFO = "lavande/index/v1";
const WRAP_INFO = "lavande/wrap/v1";
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ234567";
const NONCE_BYTES = 24;
const KEY_BYTES = 32;


const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PASSWORD_AAD = encoder.encode("lavande/pw/v1");

function utf8ToBytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function bytesToUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const rest = bytes.length - i;
    const b0 = bytes[i];
    const b1 = rest > 1 ? bytes[i + 1] : 0;
    const b2 = rest > 2 ? bytes[i + 2] : 0;
    text += BASE64URL_ALPHABET[b0 >> 2];
    text += BASE64URL_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    if (rest > 1) text += BASE64URL_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)];
    if (rest > 2) text += BASE64URL_ALPHABET[b2 & 63];
  }
  return text;
}

export function decodeBase64Url(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  if (clean.length % 4 === 1) throw new Error("base64url invalide : longueur incorrecte");
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let accumulator = 0;
  let bits = 0;
  let index = 0;
  for (const char of clean) {
    const value = BASE64URL_ALPHABET.indexOf(char);
    if (value < 0) throw new Error(`base64url invalide : caractère « ${char} »`);
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (accumulator >> bits) & 0xff;
    }
  }
  return bytes;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function deriveMasterKey(
  password: string,
  accountSalt: string,
  params: Argon2Params = ARGON2_PARAMS,
): Uint8Array {
  return argon2id(utf8ToBytes(password), decodeBase64Url(accountSalt), params);
}

function hkdfSha256(ikm: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, ikm, new Uint8Array(0), utf8ToBytes(info), KEY_BYTES);
}

export function deriveAuthKey(masterKey: Uint8Array): Uint8Array {
  return hkdfSha256(masterKey, AUTH_INFO);
}

export function deriveKek(masterKey: Uint8Array): Uint8Array {
  return hkdfSha256(masterKey, KEK_INFO);
}

export function deriveIndexKey(dek: Uint8Array): Uint8Array {
  return hkdfSha256(dek, INDEX_INFO);
}

export function entityRef(indexKey: Uint8Array, kind: EntityKind, id: string): string {
  return encodeBase64Url(hmac(sha256, indexKey, utf8ToBytes(`${kind}:${id}`))).slice(0, 22);
}

export function randomDek(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

export function randomUuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function randomSalt(bytes = 16): string {
  if (bytes < 8) throw new Error("randomSalt : au moins 8 octets requis");
  return encodeBase64Url(randomBytes(bytes));
}

export function randomCode(bytes = 4): string {
  const length = Math.floor((bytes * 8) / 5);
  if (length < 6 || length > 8) throw new Error("randomCode : longueur attendue entre 6 et 8 caractères");
  const chars: string[] = [];
  while (chars.length < length) {
    for (const byte of randomBytes(bytes)) {
      const value = byte & 31;
      if (value < CODE_ALPHABET.length) chars.push(CODE_ALPHABET[value]);
      if (chars.length === length) break;
    }
  }
  return chars.join("");
}

export function generateDeviceKeys(): { pubKey: string; privKey: string } {
  const { secretKey, publicKey } = x25519.keygen();
  return { pubKey: encodeBase64Url(publicKey), privKey: encodeBase64Url(secretKey) };
}

function encrypt(key: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): { nonce: Uint8Array; ct: Uint8Array } {
  const nonce = randomBytes(NONCE_BYTES);
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  return { nonce, ct };
}

function decrypt(key: Uint8Array, aad: Uint8Array, nonce: string, ct: string): Uint8Array {
  try {
    return xchacha20poly1305(key, decodeBase64Url(nonce), aad).decrypt(decodeBase64Url(ct));
  } catch {
    throw new Error("déchiffrement impossible : clé ou données altérées");
  }
}

export function wrapForDevice(dek: Uint8Array, devicePubKey: string): WrappedKey {
  const devicePub = decodeBase64Url(devicePubKey);
  const ephemeral = x25519.keygen();
  const ephPub = ephemeral.publicKey;
  const aad = concatBytes(ephPub, devicePub);
  const shared = x25519.getSharedSecret(ephemeral.secretKey, devicePub);
  const key = hkdf(sha256, shared, aad, utf8ToBytes(WRAP_INFO), KEY_BYTES);
  const { nonce, ct } = encrypt(key, aad, dek);
  return {
    v: CRYPTO_VERSION,
    ephPub: encodeBase64Url(ephPub),
    nonce: encodeBase64Url(nonce),
    ct: encodeBase64Url(ct),
  };
}

export function unwrapFromDevice(envelope: WrappedKey, devicePrivKey: string): Uint8Array {
  const ephPub = decodeBase64Url(envelope.ephPub);
  const devicePub = x25519.getPublicKey(decodeBase64Url(devicePrivKey));
  const aad = concatBytes(ephPub, devicePub);
  const shared = x25519.getSharedSecret(decodeBase64Url(devicePrivKey), ephPub);
  const key = hkdf(sha256, shared, aad, utf8ToBytes(WRAP_INFO), KEY_BYTES);
  return decrypt(key, aad, envelope.nonce, envelope.ct);
}

export function wrapForPassword(dek: Uint8Array, kek: Uint8Array): WrappedKey {
  const { nonce, ct } = encrypt(kek, PASSWORD_AAD, dek);
  return {
    v: CRYPTO_VERSION,
    ephPub: encodeBase64Url(randomBytes(KEY_BYTES)),
    nonce: encodeBase64Url(nonce),
    ct: encodeBase64Url(ct),
  };
}

export function unwrapFromPassword(envelope: WrappedKey, kek: Uint8Array): Uint8Array {
  return decrypt(kek, PASSWORD_AAD, envelope.nonce, envelope.ct);
}

function opAad(meta: OpMeta): Uint8Array {
  const { opId, deviceId, entityRef, hlc, schemaVersion } = meta;
  return utf8ToBytes(`${opId}|${deviceId}|${entityRef}|${hlc}|${schemaVersion}`);
}

export function sealOp(dek: Uint8Array, meta: OpMeta, payload: unknown): SealedOp {
  const { nonce, ct } = encrypt(dek, opAad(meta), utf8ToBytes(JSON.stringify(payload)));
  return { nonce: encodeBase64Url(nonce), ciphertext: encodeBase64Url(ct) };
}

export function openOp<T>(dek: Uint8Array, meta: OpMeta, sealed: SealedOp): T {
  const plaintext = bytesToUtf8(decrypt(dek, opAad(meta), sealed.nonce, sealed.ciphertext));
  const parsed: unknown = JSON.parse(plaintext);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("opération invalide : un objet JSON est attendu");
  }
  return parsed as T;
}
