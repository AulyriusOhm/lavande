import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PlanningProvider } from "@/lib/planning-store";
import { SyncSettings } from "@/components/sync-settings";
import { randomDek, wrapForDevice } from "@/lib/sync/crypto";
import { createDevice, createMemoryStorage, emptyState, type SyncStorage } from "@/lib/sync/storage";

const SERVER = "http://127.0.0.1:8787";

function json(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}

function configuredStorage(email: string): SyncStorage {
  const device = createDevice("Portable", "web");
  return createMemoryStorage({
    ...emptyState(device),
    account: { serverUrl: SERVER, userId: "user-1", email, accountSalt: "salt-1", token: "token-1" },
    envelopes: { devices: { [device.id]: wrapForDevice(randomDek(), device.pubKey) } },
  });
}

function stubSyncServer(devices: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/api/v1/ops")) {
        return method === "GET" ? json({ ops: [], nextSeq: 0, hasMore: false }) : json({ acked: [], nextSeq: 0 });
      }
      return json(devices);
    }) as unknown as typeof fetch,
  );
}

function renderSync(storage: SyncStorage) {
  return render(
    <PlanningProvider storage={storage}>
      <SyncSettings />
    </PlanningProvider>,
  );
}

describe("SyncSettings", () => {
  it("affiche le formulaire de compte quand rien n'est configuré", () => {
    renderSync(createMemoryStorage());

    expect(screen.getByText("Non configuré")).toBeTruthy();
    expect(screen.getByText("0 opération en attente")).toBeTruthy();
    const url = screen.getByLabelText("URL du serveur") as HTMLInputElement;
    expect(url.value).toBe(SERVER);
    expect(screen.getByLabelText("E-mail")).toBeTruthy();
    expect(screen.getByLabelText("Mot de passe")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Créer le compte" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Se connecter" })).toBeTruthy();
    expect(screen.getByText("Cet appareil est nouveau")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Synchroniser/ })).toBeTruthy();
  });

  it("affiche le compte et les appareils quand la synchronisation est configurée", async () => {
    const storage = configuredStorage("roman@lavande.mail");
    const device = storage.read().device;
    stubSyncServer([
      {
        id: device.id,
        name: "Portable",
        platform: "web",
        schemaVersion: 1,
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        current: true,
      },
    ]);

    renderSync(storage);

    expect(screen.getByText("roman@lavande.mail")).toBeTruthy();
    expect(screen.getByText(SERVER)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Synchroniser/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Se déconnecter/ })).toBeTruthy();
    expect(screen.getByText("Ajouter un appareil")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Créer le compte" })).toBeNull();

    await waitFor(() => {
      expect(screen.getByText("Portable")).toBeTruthy();
    });
    expect(screen.getByText("cet appareil")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Révoquer" })).toBeTruthy();
  });

  it("affiche l'erreur du serveur en texte, sans casser le rendu", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("serveur injoignable");
      }) as unknown as typeof fetch,
    );

    renderSync(configuredStorage("roman@lavande.mail"));

    await waitFor(() => {
      expect(screen.getByText("serveur injoignable")).toBeTruthy();
    });
    expect(screen.getByText("roman@lavande.mail")).toBeTruthy();
  });
});
