import { request } from "@/lib/api";
import type { PgpKey } from "@/lib/pgp";

export type PgpKeysResponse = { keys: PgpKey[] };

export type PgpGenerateInput = { name: string; email: string };

export type PgpGenerateResponse = { key: PgpKey; public_key: string };

export type PgpImportInput = { armored: string };

export type PgpImportResponse = { key: PgpKey };

export type PgpExportResponse = { public_key: string };

const keyPath = (fingerprint: string) => `/pgp/keys/${encodeURIComponent(fingerprint)}`;

const GENERATE_TIMEOUT = 120_000;

export function listKeys(signal?: AbortSignal): Promise<PgpKey[]> {
  return request<PgpKeysResponse>("/pgp/keys", { signal }).then((payload) => payload.keys);
}

export function generateKey(input: PgpGenerateInput): Promise<PgpGenerateResponse> {
  return request<PgpGenerateResponse>("/pgp/keys/generate", {
    method: "POST",
    body: input,
    timeout: GENERATE_TIMEOUT,
  });
}

export function importKey(armored: string): Promise<PgpKey> {
  return request<PgpImportResponse>("/pgp/keys/import", {
    method: "POST",
    body: { armored } satisfies PgpImportInput,
  }).then((payload) => payload.key);
}

export function exportKey(fingerprint: string): Promise<string> {
  return request<PgpExportResponse>(`${keyPath(fingerprint)}/export`).then(
    (payload) => payload.public_key,
  );
}

export function deleteKey(fingerprint: string): Promise<void> {
  return request<void>(keyPath(fingerprint), { method: "DELETE" });
}
