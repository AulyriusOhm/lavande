import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SyncBadge, syncBadgeLabel } from "@/components/sync-badge";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { createMemoryStorage, emptyState, createDevice, type SyncState } from "@/lib/sync/storage";

function renderBadge(state: SyncState, onOpen?: () => void) {
  const storage = createMemoryStorage(state);
  render(
    <PrefsProvider>
      <PlanningProvider storage={storage}>
        <SyncBadge onOpen={onOpen} />
      </PlanningProvider>
    </PrefsProvider>,
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

describe("SyncBadge · jetons de thème", () => {
  const account = {
    serverUrl: "http://127.0.0.1:8787",
    userId: "user-1",
    email: "a@b.c",
    accountSalt: "salt",
    token: "token",
  };

  it("habille la phase hors ligne avec les jetons dédiés", () => {
    renderBadge(baseState({ account }));
    const badge = screen.getByLabelText(/^Synchronisation : Hors ligne/);

    expect(badge.className).toContain("bg-sync-offline-soft");
    expect(badge.className).toContain("text-sync-offline-ink");
    expect(badge.querySelector("span")?.className).toContain("bg-sync-offline-dot");
    expect(badge.className).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it("déclare chaque jeton de synchronisation dans les deux thèmes", () => {
    const css = readFileSync(path.join(process.cwd(), "src/index.css"), "utf8");

    for (const token of ["offline", "ok", "error"]) {
      for (const suffix of ["dot", "soft", "ink"]) {
        const occurrences = css.split(`--sync-${token}-${suffix}:`).length - 1;
        expect(occurrences, `--sync-${token}-${suffix}`).toBe(2);
      }
    }
  });

  it("n'a plus aucune couleur figée dans le composant", () => {
    const source = readFileSync(path.join(process.cwd(), "src/components/sync-badge.tsx"), "utf8");

    expect(source).not.toMatch(/#[0-9a-f]{6}/i);
  });
});
