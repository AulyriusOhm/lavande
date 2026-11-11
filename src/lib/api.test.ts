import { describe, expect, it, vi } from "vitest";
import { mailApi } from "@/lib/api";

const response = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

const noContent = (): Response => ({ ok: true, status: 204 }) as unknown as Response;

describe("mailApi · renommage de compte", () => {
  it("envoie un PATCH avec le nouveau libellé", async () => {
    const fetchMock = vi.fn(async () => response({ id: "a1", label: "Bureau" }));
    vi.stubGlobal("fetch", fetchMock);

    await mailApi.renameAccount("a 1", "Bureau");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/accounts/a%201");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ label: "Bureau" }));
  });

  it("accepte une réponse 204 sans corps", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => noContent()));

    await expect(mailApi.renameAccount("a1", "Bureau")).resolves.toBeUndefined();
  });

  it("remonte l'erreur du démon", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ error: "libellé vide", kind: "config" }, 400)),
    );

    await expect(mailApi.renameAccount("a1", "")).rejects.toThrow("libellé vide");
  });
});

describe("mailApi · désynchronisation d'un dossier", () => {
  it("supprime le cache local avec le chemin encodé", async () => {
    const fetchMock = vi.fn(async () => noContent());
    vi.stubGlobal("fetch", fetchMock);

    await mailApi.desyncFolder("a1", "[Gmail]/Tous les mails");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/accounts/a1/folders/%5BGmail%5D%2FTous%20les%20mails/local");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });
});
