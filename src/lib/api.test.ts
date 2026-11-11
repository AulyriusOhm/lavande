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

describe("mailApi · choix des dossiers synchronisés", () => {
  it("envoie la sélection en PATCH sur /sync-folders", async () => {
    const fetchMock = vi.fn(async () =>
      response({ id: "a1", folders: 2, synced_folders: ["INBOX"] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const summary = await mailApi.setSyncFolders("a 1", ["INBOX"]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/accounts/a%201/sync-folders");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ folders: ["INBOX"] }));
    expect(summary.synced_folders).toEqual(["INBOX"]);
  });

  it("envoie null pour revenir au choix par défaut", async () => {
    const fetchMock = vi.fn(async () => response({ id: "a1", folders: 2, synced_folders: null }));
    vi.stubGlobal("fetch", fetchMock);

    const summary = await mailApi.setSyncFolders("a1", null);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ folders: null }));
    expect(summary.synced_folders).toBeNull();
  });

  it("accepte une liste vide : aucun dossier", async () => {
    const fetchMock = vi.fn(async () => response({ id: "a1", folders: 2, synced_folders: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const summary = await mailApi.setSyncFolders("a1", []);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ folders: [] }));
    expect(summary.synced_folders).toEqual([]);
  });

  it("remonte un dossier inconnu refusé par le démon", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ error: "dossier « Zzz » inconnu", kind: "config" }, 400)),
    );

    await expect(mailApi.setSyncFolders("a1", ["Zzz"])).rejects.toThrow("dossier « Zzz » inconnu");
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
