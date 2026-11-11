import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
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

const storedSync = () =>
  (JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as { sync?: unknown }).sync;

function seedSync(sync: Record<string, boolean>) {
  window.localStorage.setItem("lavande.prefs", JSON.stringify({ sync }));
}

function renderSync(storage: SyncStorage) {
  return render(
    <PrefsProvider>
      <PlanningProvider storage={storage}>
        <SyncSettings />
      </PlanningProvider>
    </PrefsProvider>,
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

describe("SyncSettings · interrupteurs de synchronisation", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("affiche le maître et les trois domaines, tous actifs par défaut", () => {
    renderSync(createMemoryStorage());

    for (const name of ["Tout synchroniser", "Mails", "Calendrier", "Kanban / tâches"]) {
      expect((screen.getByRole("switch", { name }) as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
    }
    expect(screen.getByText("Tout synchroniser")).toBeTruthy();
    expect(screen.queryByText(/Toute synchronisation est coupée/)).toBeNull();
  });

  it("coupe un domaine au clic et le persiste", async () => {
    renderSync(createMemoryStorage());

    fireEvent.click(screen.getByRole("switch", { name: "Mails" }));

    await waitFor(() => expect(storedSync()).toMatchObject({ mails: false }));
    expect(
      (screen.getByRole("switch", { name: "Mails" }) as HTMLButtonElement).getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      (screen.getByRole("switch", { name: "Calendrier" }) as HTMLButtonElement).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("grise les domaines et la synchro planning quand le maître est coupé", async () => {
    renderSync(createMemoryStorage());

    fireEvent.click(screen.getByRole("switch", { name: "Tout synchroniser" }));

    await waitFor(() => expect(storedSync()).toMatchObject({ enabled: false }));
    expect(screen.getByText(/Toute synchronisation est coupée/)).toBeTruthy();
    for (const name of ["Mails", "Calendrier", "Kanban / tâches"]) {
      expect((screen.getByRole("switch", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByRole("button", { name: "Synchroniser" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/le planning ne quitte pas cet appareil/)).toBeTruthy();
  });

  it("relit un réglage déjà coupé", () => {
    seedSync({ enabled: true, mails: false, calendar: true, kanban: false });
    renderSync(createMemoryStorage());

    expect(
      (screen.getByRole("switch", { name: "Mails" }) as HTMLButtonElement).getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      (screen.getByRole("switch", { name: "Kanban / tâches" }) as HTMLButtonElement).getAttribute("aria-checked"),
    ).toBe("false");
    expect((screen.getByRole("button", { name: "Synchroniser" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Synchronisation des tâches coupée/)).toBeTruthy();
  });
});
