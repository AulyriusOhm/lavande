import { describe, expect, it, vi } from "vitest";
import { mailApi } from "@/lib/api";

const response = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    statusText: "",
    json: async () => payload,
  }) as unknown as Response;

async function urlOf(call: () => Promise<unknown>): Promise<string> {
  const fetchMock = vi.fn(async () => response([]));
  vi.stubGlobal("fetch", fetchMock);
  await call();
  const [url] = fetchMock.mock.calls[0] as unknown as [string];
  return url;
}

describe("mailApi.search · query string du démon", () => {
  it("garde la signature historique (id, query, limit)", async () => {
    await expect(urlOf(() => mailApi.search("a 1", "facture", 20))).resolves.toBe(
      "/api/accounts/a%201/search?q=facture&limit=20",
    );
  });

  it("ajoute les filtres et l'offset demandés", async () => {
    await expect(
      urlOf(() =>
        mailApi.search("a1", "facture", 50, {
          unread: true,
          hasAttachment: true,
          folder: "Projets",
          before: "2026-02-01",
          offset: 50,
        }),
      ),
    ).resolves.toBe(
      "/api/accounts/a1/search?q=facture&limit=50&offset=50&folder=Projets&unread=true" +
        "&has_attachment=true&before=2026-02-01",
    );
  });

  it("encode les valeurs à espaces", async () => {
    await expect(urlOf(() => mailApi.search("a1", "", 50, { from: "Jean Dupont" }))).resolves.toBe(
      "/api/accounts/a1/search?limit=50&from=Jean%20Dupont",
    );
  });
});
