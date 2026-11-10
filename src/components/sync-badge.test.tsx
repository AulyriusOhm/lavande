import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SyncBadge, syncBadgeLabel } from "@/components/sync-badge";
import { PlanningProvider } from "@/lib/planning-store";
import { createMemoryStorage, emptyState, createDevice, type SyncState } from "@/lib/sync/storage";

function renderBadge(state: SyncState, onOpen?: () => void) {
  const storage = createMemoryStorage(state);
  render(
    <PlanningProvider storage={storage}>
      <SyncBadge onOpen={onOpen} />
    </PlanningProvider>,
  );
  return storage;
}

function baseState(patch: Partial<SyncState> = {}): SyncState {
  return { ...emptyState(createDevice("Test", "node")), ...patch };
}

describe("SyncBadge", () => {
  it("affiche « Locale » sans compte configuré", () => {
    renderBadge(baseState());
    expect(screen.getByLabelText("Synchronisation : Locale")).toBeTruthy();
  });

  it("affiche le nombre d'opérations en attente quand un compte existe", () => {
    const state = baseState({
      account: {
        serverUrl: "http://127.0.0.1:8787",
        userId: "user-1",
        email: "a@b.c",
        accountSalt: "salt",
        token: "token",
      },
      outbox: [
        {
          opId: "device:1",
          deviceId: "device",
          kind: "task",
          entityRef: "ref",
          hlc: "000000000000001-00000-abc",
          schemaVersion: 1,
          nonce: "nonce",
          ciphertext: "ct",
        },
      ],
    });
    renderBadge(state);
    expect(screen.getByLabelText("Synchronisation : 1 en attente")).toBeTruthy();
  });

  it("traduit chaque phase en libellé court", () => {
    expect(syncBadgeLabel("unconfigured", 0)).toBe("Locale");
    expect(syncBadgeLabel("offline", 0)).toBe("Hors ligne");
    expect(syncBadgeLabel("syncing", 0)).toBe("Synchro…");
    expect(syncBadgeLabel("synced", 0)).toBe("À jour");
    expect(syncBadgeLabel("error", 0)).toBe("Erreur");
    expect(syncBadgeLabel("read_only", 0)).toBe("Lecture seule");
    expect(syncBadgeLabel("synced", 3)).toBe("3 en attente");
  });

  it("ouvre les réglages au clic", () => {
    const onOpen = vi.fn();
    renderBadge(baseState(), onOpen);
    fireEvent.click(screen.getByLabelText(/Synchronisation/));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
