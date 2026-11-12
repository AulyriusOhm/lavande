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

describe("mailApi · interrupteur PGP du compte", () => {
  it("envoie le booléen en PATCH sur /pgp", async () => {
    const fetchMock = vi.fn(async () => response({ id: "a1", folders: 2, pgp: false }));
    vi.stubGlobal("fetch", fetchMock);

    const summary = await mailApi.setAccountPgp("a 1", false);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/accounts/a%201/pgp");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ enabled: false }));
    expect(summary.pgp).toBe(false);
  });

  it("remonte un compte inconnu refusé par le démon", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ error: "compte « absent » inconnu", kind: "store" }, 404)),
    );

    await expect(mailApi.setAccountPgp("absent", true)).rejects.toThrow("compte « absent » inconnu");
  });
});

describe("mailApi · suppression d'un dossier", () => {
  it("supprime le dossier avec le chemin encodé", async () => {
    const fetchMock = vi.fn(async () => noContent());
    vi.stubGlobal("fetch", fetchMock);

    await mailApi.deleteFolder("a1", "Projets 2026");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/accounts/a1/folders/Projets%202026");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });

  it("remonte le refus du serveur", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ error: "serveur IMAP : refusé", kind: "imap" }, 502)),
    );

    await expect(mailApi.deleteFolder("a1", "INBOX")).rejects.toThrow("serveur IMAP : refusé");
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
