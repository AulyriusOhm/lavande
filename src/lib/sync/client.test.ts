import { describe, expect, it, vi } from "vitest";
import { createSyncApi, SyncHttpError } from "./client";
import type { SyncOp } from "./storage";

type Recorded = { url: string; init: RequestInit };

function jsonResponse(status: number, body?: unknown): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
}

function stubFetch(status: number, body?: unknown): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse(status, body);
    }),
  );
  return calls;
}

function headersOf(call: Recorded): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

function sampleOp(deviceId: string, opId: string): SyncOp {
  return {
    opId,
    deviceId,
    kind: "task",
    entityRef: "krWPrW0BTkQ6_F74dgExhu",
    hlc: "001700000000000-00000-abc123",
    schemaVersion: 1,
    nonce: "bm9uY2U",
    ciphertext: "Y2lwaGVy",
  };
}

describe("createSyncApi", () => {
  it("normalise l'url, envoie le JSON et l'en-tête Authorization", async () => {
    const calls = stubFetch(201, { userId: "u1", token: "tk", expiresAt: "2030-01-01T00:00:00.000Z", accountSalt: "salt" });
    const api = createSyncApi({ baseUrl: "https://sync.test/", token: "jeton", deviceId: "dev-1" });

    const result = await api.register("a@b.c", "auth-key", "salt-1");

    expect(result).toEqual({ userId: "u1", token: "tk", expiresAt: "2030-01-01T00:00:00.000Z", accountSalt: "salt" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://sync.test/api/v1/auth/register");
    expect(calls[0].init.method).toBe("POST");
    expect(headersOf(calls[0])).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      authorization: "Bearer jeton",
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ email: "a@b.c", authKey: "auth-key", accountSalt: "salt-1" });
  });

  it("omet Authorization sans jeton et n'envoie pas de corps en GET", async () => {
    const calls = stubFetch(200, { userId: "u1", email: "a@b.c", accountSalt: "salt", devices: [] });
    const api = createSyncApi({ baseUrl: "https://sync.test/", token: null, deviceId: "dev-1" });

    await api.me();

    expect(calls[0].url).toBe("https://sync.test/api/v1/me");
    expect(calls[0].init.method).toBe("GET");
    expect(headersOf(calls[0])).toEqual({ accept: "application/json" });
    expect(calls[0].init.body).toBeUndefined();
  });

  it("traduit 401 en SyncHttpError(401, unauthorized)", async () => {
    stubFetch(401, { code: "unauthorized", message: "jeton expiré" });
    const api = createSyncApi({ baseUrl: "https://sync.test", token: "vieux", deviceId: "dev-1" });

    const error = await api.me().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SyncHttpError);
    expect((error as SyncHttpError).status).toBe(401);
    expect((error as SyncHttpError).code).toBe("unauthorized");
    expect((error as SyncHttpError).message).toBe("jeton expiré");
  });

  it("traduit 426 en schema_too_new", async () => {
    stubFetch(426, { code: "schema_too_new", message: "schemaVersion 3 > 2" });
    const api = createSyncApi({ baseUrl: "https://sync.test", token: "tk", deviceId: "dev-1" });

    await expect(api.pushOps([sampleOp("dev-1", "dev-1:1")])).rejects.toMatchObject({
      status: 426,
      code: "schema_too_new",
    });
  });

  it("replie sur http_error quand le corps d'erreur n'est pas du JSON", async () => {
    stubFetch(500, undefined);
    const api = createSyncApi({ baseUrl: "https://sync.test", token: "tk", deviceId: "dev-1" });

    await expect(api.serverStatus()).rejects.toMatchObject({ status: 500, code: "http_error" });
  });

  it("traduit une panne réseau en SyncHttpError(0, offline)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("réseau coupé");
      }),
    );
    const api = createSyncApi({ baseUrl: "https://sync.test", token: "tk", deviceId: "dev-1" });

    const error = await api.serverStatus().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SyncHttpError);
    expect((error as SyncHttpError).status).toBe(0);
    expect((error as SyncHttpError).code).toBe("offline");
    expect((error as SyncHttpError).message).toBe("réseau coupé");
  });

  it("refuse une url de serveur vide", () => {
    expect(() => createSyncApi({ baseUrl: "   ", deviceId: "dev-1" })).toThrow("url du serveur manquante");
  });

  it("refuse de fonctionner sans implémentation fetch", () => {
    vi.stubGlobal("fetch", undefined);

    expect(() => createSyncApi({ baseUrl: "https://sync.test", deviceId: "dev-1" })).toThrow(
      "fetch indisponible : fournissez fetchImpl",
    );
  });

  it("envoie exactement le tableau d'opérations dans pushOps", async () => {
    const calls = stubFetch(200, { acked: ["dev-1:1"], nextSeq: 12 });
    const api = createSyncApi({ baseUrl: "https://sync.test", token: "tk", deviceId: "dev-1" });
    const ops = [sampleOp("dev-1", "dev-1:1"), sampleOp("dev-1", "dev-1:2")];

    const result = await api.pushOps(ops);

    expect(result).toEqual({ acked: ["dev-1:1"], nextSeq: 12 });
    expect(calls[0].url).toBe("https://sync.test/api/v1/ops");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ ops });
  });

  it("pagine le pull avec since et limit", async () => {
    const calls = stubFetch(200, { ops: [], nextSeq: 42, hasMore: false });
    const api = createSyncApi({ baseUrl: "https://sync.test", token: "tk", deviceId: "dev-1" });

    await api.pullOps(12);
    await api.pullOps(12, 200);

    expect(calls[0].url).toBe("https://sync.test/api/v1/ops?since=12&limit=500");
    expect(calls[1].url).toBe("https://sync.test/api/v1/ops?since=12&limit=200");
  });

  it("accepte une réponse 204 sans corps", async () => {
    const calls = stubFetch(204);
    const api = createSyncApi({ baseUrl: "https://sync.test", token: "tk", deviceId: "dev-1" });

    await expect(api.logout()).resolves.toBeUndefined();
    expect(calls[0].url).toBe("https://sync.test/api/v1/auth/logout");
  });
});
