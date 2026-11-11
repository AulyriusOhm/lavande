import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  APP_VERSION,
  checkForUpdate,
  installAndRelaunch,
  messageOf,
  phaseLabel,
  updaterSupported,
  useUpdater,
  type PendingUpdate,
  type UpdatePhase,
  type UpdaterBackend,
} from "@/lib/updater";

function backendWith(patch: Partial<UpdaterBackend> = {}): UpdaterBackend {
  return {
    version: async () => "0.1.0",
    check: async () => null,
    relaunch: async () => undefined,
    ...patch,
  };
}

function pendingUpdate(patch: Partial<PendingUpdate> = {}): PendingUpdate {
  return {
    version: "0.2.0",
    notes: "Correctifs",
    install: async (onProgress) => {
      onProgress(50);
      onProgress(100);
    },
    close: async () => undefined,
    ...patch,
  };
}

function recorder() {
  const phases: UpdatePhase[] = [];
  return { phases, report: (phase: UpdatePhase) => phases.push(phase) };
}

describe("mise à jour hors coquille Tauri", () => {
  it("le navigateur et les tests ne sont pas pris en charge", () => {
    expect(updaterSupported()).toBe(false);
  });

  it("le hook reste inactif : aucun état actif, aucune action", async () => {
    const { result } = renderHook(() => useUpdater());
    expect(result.current.supported).toBe(false);
    expect(result.current.phase).toEqual({ kind: "unsupported" });
    expect(result.current.busy).toBe(false);
    expect(result.current.canInstall).toBe(false);
    await expect(result.current.check()).resolves.toBeNull();
    await expect(result.current.install()).resolves.toBeUndefined();
  });

  it("la version de repli vient de package.json", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("checkForUpdate", () => {
  it("aucune mise à jour : vérification puis à jour", async () => {
    const { phases, report } = recorder();
    await expect(checkForUpdate(backendWith(), report)).resolves.toBeNull();
    expect(phases.map((phase) => phase.kind)).toEqual(["checking", "current"]);
  });

  it("mise à jour disponible : version et notes remontées", async () => {
    const { phases, report } = recorder();
    const pending = pendingUpdate();
    const found = await checkForUpdate(backendWith({ check: async () => pending }), report);
    expect(found).toBe(pending);
    expect(phases.at(-1)).toEqual({ kind: "available", version: "0.2.0", notes: "Correctifs" });
  });

  it("erreur réseau : état d'échec avec le message", async () => {
    const { phases, report } = recorder();
    const backend = backendWith({
      check: async () => {
        throw new Error("réseau indisponible");
      },
    });
    await expect(checkForUpdate(backend, report)).resolves.toBeNull();
    expect(phases.at(-1)).toEqual({ kind: "error", message: "réseau indisponible" });
  });

  it("vérification de fond : l'erreur reste silencieuse", async () => {
    const { phases, report } = recorder();
    const backend = backendWith({
      check: async () => {
        throw new Error("réseau indisponible");
      },
    });
    await checkForUpdate(backend, report, { silent: true });
    expect(phases.map((phase) => phase.kind)).toEqual(["checking", "idle"]);
  });
});

describe("installAndRelaunch", () => {
  it("télécharge, installe puis relance", async () => {
    const { phases, report } = recorder();
    const relaunch = vi.fn(async () => undefined);
    await installAndRelaunch(backendWith({ relaunch }), pendingUpdate(), report);
    expect(phases).toEqual([
      { kind: "downloading", version: "0.2.0", percent: 0 },
      { kind: "downloading", version: "0.2.0", percent: 50 },
      { kind: "downloading", version: "0.2.0", percent: 100 },
      { kind: "installing", version: "0.2.0" },
    ]);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("taille inconnue : progression indéterminée", async () => {
    const { phases, report } = recorder();
    await installAndRelaunch(
      backendWith(),
      pendingUpdate({ install: async (onProgress) => onProgress(null) }),
      report,
    );
    expect(phases[1]).toEqual({ kind: "downloading", version: "0.2.0", percent: null });
  });

  it("installation refusée : état d'échec, pas de relance", async () => {
    const { phases, report } = recorder();
    const relaunch = vi.fn(async () => undefined);
    const failing = pendingUpdate({
      install: async () => {
        throw new Error("signature invalide");
      },
    });
    await installAndRelaunch(backendWith({ relaunch }), failing, report);
    expect(phases.at(-1)).toEqual({ kind: "error", message: "signature invalide" });
    expect(relaunch).not.toHaveBeenCalled();
  });
});

describe("phaseLabel", () => {
  it("décrit chaque état", () => {
    expect(phaseLabel({ kind: "unsupported" }).label).toBe("Bureau uniquement");
    expect(phaseLabel({ kind: "idle" })).toEqual({ label: "Non vérifiée", tone: "neutral" });
    expect(phaseLabel({ kind: "checking" })).toEqual({ label: "Vérification…", tone: "accent" });
    expect(phaseLabel({ kind: "current" })).toEqual({ label: "À jour", tone: "green" });
    expect(phaseLabel({ kind: "available", version: "0.2.0", notes: "" })).toEqual({
      label: "Mise à jour disponible · v0.2.0",
      tone: "amber",
    });
    expect(phaseLabel({ kind: "downloading", version: "0.2.0", percent: 42 }).label).toBe(
      "Téléchargement · 42 %",
    );
    expect(phaseLabel({ kind: "downloading", version: "0.2.0", percent: null }).label).toBe(
      "Téléchargement…",
    );
    expect(phaseLabel({ kind: "installing", version: "0.2.0" }).label).toBe("Installation…");
    expect(phaseLabel({ kind: "error", message: "boom" })).toEqual({ label: "Échec", tone: "rose" });
  });

  it("messageOf tolère les erreurs inhabituelles", () => {
    expect(messageOf(new Error("échec"))).toBe("échec");
    expect(messageOf("refus")).toBe("refus");
    expect(messageOf(null)).toBe("mise à jour impossible");
  });
});
