import { describe, expect, it, vi } from "vitest";
import { createDaemonVault } from "./vault";

type Call = { method: string; path: string; body: Record<string, string> };

function reply(status: number, body?: unknown): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

function stubDaemon(): { calls: Call[]; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {};
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input).split("?")[0];
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, string>) : {};
      calls.push({ method, path, body });
      if (path === "/api/sync/secrets/device") {
        if (method === "PUT") {
          secrets.device = body.private_key ?? "";
          return reply(204);
        }
        return reply(200, { private_key: secrets.device ?? null });
      }
      if (method === "PUT") secrets.account = body.token ?? "";
      if (method === "DELETE") delete secrets.account;
      if (method === "PUT" || method === "DELETE") return reply(204);
      return reply(200, { token: secrets.account ?? null });
    }) as unknown as typeof fetch,
  );
  return { calls, secrets };
}

describe("createDaemonVault", () => {
  it("dépose et relit la clé privée et le jeton par les routes du démon", async () => {
    const { calls, secrets } = stubDaemon();
    const vault = createDaemonVault();

    expect(await vault.readDeviceKey()).toBeNull();
    await vault.writeDeviceKey("cle-privee");
    expect(await vault.readDeviceKey()).toBe("cle-privee");

    await vault.writeAccountToken("user-1", "session-1");
    expect(await vault.readAccountToken("user-1")).toBe("session-1");

    await vault.deleteAccountToken("user-1");
    expect(await vault.readAccountToken("user-1")).toBeNull();
    expect(secrets).toEqual({ device: "cle-privee" });

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/sync/secrets/device",
      "PUT /api/sync/secrets/device",
      "GET /api/sync/secrets/device",
      "PUT /api/sync/secrets/accounts/user-1",
      "GET /api/sync/secrets/accounts/user-1",
      "DELETE /api/sync/secrets/accounts/user-1",
      "GET /api/sync/secrets/accounts/user-1",
    ]);
    expect(calls[1].body).toEqual({ private_key: "cle-privee" });
    expect(calls[3].body).toEqual({ token: "session-1" });
  });

  it("remonte l'échec du démon au lieu de rendre un secret vide", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(401, { error: "jeton du démon invalide", kind: "auth" })) as unknown as typeof fetch,
    );
    await expect(createDaemonVault().readDeviceKey()).rejects.toThrow(/jeton du démon invalide/);
  });
});
