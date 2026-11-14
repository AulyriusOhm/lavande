/**
 * Mises à jour de l'application.
 *
 * Deux backends : le plugin `updater` (bureau) et le plugin natif
 * `lavandeupdater` (Android : APK téléchargé puis confié à PackageInstaller).
 * Dans un navigateur ou sous les tests, tout répond « non pris en charge » sans
 * jamais charger un plugin. Les états et les transitions vivent dans des
 * fonctions pures, pilotées par un `UpdaterBackend` qu'un test peut remplacer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import packageJson from "../../package.json";
import { isNativeShell, shellLayout } from "@/lib/native";
import { isTauriShell } from "@/lib/open-external";

/** Version du front, affichée quand la coquille ne peut pas la donner. */
export const APP_VERSION: string = packageJson.version;

export type UpdateTone = "neutral" | "accent" | "green" | "amber" | "rose";

export type UpdatePhase =
  | { kind: "unsupported" }
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "installing"; version: string }
  | { kind: "error"; message: string };

/** Une mise à jour annoncée par le serveur, prête à être téléchargée. */
export type PendingUpdate = {
  version: string;
  notes: string;
  install: (onProgress: (percent: number | null) => void) => Promise<void>;
  close: () => Promise<void>;
};

export type UpdaterBackend = {
  version: () => Promise<string>;
  check: () => Promise<PendingUpdate | null>;
  relaunch: () => Promise<void>;
};

/** Coquilles Tauri servies : bureau (plugin updater) et Android (plugin natif). */
export function updaterSupported(): boolean {
  return typeof window !== "undefined" && isTauriShell() && shellLayout() !== "stage";
}

export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "mise à jour impossible";
}

/** Comparaison numérique segment par segment, « v » initial ignoré. */
export function compareVersions(a: string, b: string): number {
  const segments = (value: string) =>
    value
      .replace(/^v/i, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = segments(a);
  const right = segments(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function phaseLabel(phase: UpdatePhase): { label: string; tone: UpdateTone } {
  switch (phase.kind) {
    case "unsupported":
      return { label: "Non disponible dans le navigateur", tone: "neutral" };
    case "idle":
      return { label: "Non vérifiée", tone: "neutral" };
    case "checking":
      return { label: "Vérification…", tone: "accent" };
    case "current":
      return { label: "À jour", tone: "green" };
    case "available":
      return { label: `Mise à jour disponible · v${phase.version}`, tone: "amber" };
    case "downloading":
      return {
        label: phase.percent === null ? "Téléchargement…" : `Téléchargement · ${phase.percent} %`,
        tone: "accent",
      };
    case "installing":
      return { label: "Installation…", tone: "accent" };
    case "error":
      return { label: "Échec", tone: "rose" };
  }
}

/** Interroge le serveur ; `silent` étouffe l'erreur d'une vérification de fond. */
export async function checkForUpdate(
  backend: UpdaterBackend,
  report: (phase: UpdatePhase) => void,
  options: { silent?: boolean } = {},
): Promise<PendingUpdate | null> {
  report({ kind: "checking" });
  try {
    const pending = await backend.check();
    if (!pending) {
      report({ kind: "current" });
      return null;
    }
    report({ kind: "available", version: pending.version, notes: pending.notes });
    return pending;
  } catch (error) {
    report(options.silent ? { kind: "idle" } : { kind: "error", message: messageOf(error) });
    return null;
  }
}

/** Télécharge, installe puis relance l'application sur la nouvelle version. */
export async function installAndRelaunch(
  backend: UpdaterBackend,
  pending: PendingUpdate,
  report: (phase: UpdatePhase) => void,
): Promise<void> {
  report({ kind: "downloading", version: pending.version, percent: 0 });
  try {
    await pending.install((percent) => report({ kind: "downloading", version: pending.version, percent }));
    report({ kind: "installing", version: pending.version });
    await backend.relaunch();
  } catch (error) {
    report({ kind: "error", message: messageOf(error) });
  }
}

/** Backend réel : plugins Tauri chargés à la demande, jamais dans un navigateur. */
export function tauriUpdater(): UpdaterBackend {
  return {
    version: async () => {
      const { getVersion } = await import("@tauri-apps/api/app");
      return getVersion();
    },
    check: async () => {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check({ timeout: 20_000 });
      if (!update) return null;
      return {
        version: update.version,
        notes: update.body?.trim() ?? "",
        install: (onProgress) => {
          let total = 0;
          let received = 0;
          return update.downloadAndInstall((event) => {
            if (event.event === "Started") {
              total = event.data.contentLength ?? 0;
              received = 0;
              onProgress(total > 0 ? 0 : null);
              return;
            }
            if (event.event === "Progress") {
              received += event.data.chunkLength;
              onProgress(total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null);
              return;
            }
            onProgress(100);
          });
        },
        close: () => update.close(),
      };
    },
    relaunch: async () => {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}

const ANDROID_PROGRESS_EVENT = "plugin:lavandeupdater://download-progress";

const ANDROID_UNKNOWN_SOURCES =
  "Autorisez l'installation d'applications inconnues pour Lavande, puis relancez la mise à jour.";

type AndroidManifest = {
  version?: string;
  notes?: string;
  platforms?: { android?: { signature?: string; url?: string } };
};

type AndroidApk = { url: string; signature: string; version: string };

/** Backend Android : APK signé téléchargé par le plugin natif, puis installé. */
export function androidUpdater(): UpdaterBackend {
  return {
    version: async () => {
      const { getVersion } = await import("@tauri-apps/api/app");
      return getVersion();
    },
    check: async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const { getVersion } = await import("@tauri-apps/api/app");
      const { fetch } = await import("@tauri-apps/plugin-http");
      const endpoint = await invoke<string>("android_update_endpoint");
      const response = await fetch(endpoint, { connectTimeout: 20_000 });
      if (!response.ok) throw new Error(`manifeste de mise à jour inaccessible (${response.status})`);
      const manifest = (await response.json()) as AndroidManifest;
      const android = manifest.platforms?.android;
      const version = manifest.version;
      if (!version || !android) return null;
      if (compareVersions(version, await getVersion()) <= 0) return null;
      if (!android.url || !android.signature) throw new Error("manifeste Android incomplet");
      const notes = manifest.notes?.trim() ?? "";
      return pendingAndroidUpdate({ url: android.url, signature: android.signature, version }, notes);
    },
    relaunch: async () => undefined,
  };
}

function pendingAndroidUpdate(apk: AndroidApk, notes: string): PendingUpdate {
  return {
    version: apk.version,
    notes,
    install: async (onProgress) => {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<{ received: number; total: number; percent?: number }>(
        ANDROID_PROGRESS_EVENT,
        (event) => onProgress(event.payload.percent ?? null),
      );
      try {
        const { path } = await invoke<{ path: string }>("plugin:lavandeupdater|downloadApk", {
          url: apk.url,
        });
        await invoke("verify_android_update", {
          path,
          signature: apk.signature,
          version: apk.version,
        });
        const { allowed } = await invoke<{ allowed: boolean }>("plugin:lavandeupdater|canInstall");
        if (!allowed) {
          await invoke("plugin:lavandeupdater|openInstallSettings");
          throw new Error(ANDROID_UNKNOWN_SOURCES);
        }
        await invoke("plugin:lavandeupdater|installApk", { path });
      } catch (error) {
        throw new Error(messageOf(error));
      } finally {
        unlisten();
      }
    },
    close: async () => undefined,
  };
}

const AUTO_CHECK_KEY = "lavande:updater-auto-check";

/**
 * État de la mise à jour pour l'UI. La vérification de fond n'a lieu qu'une
 * fois par session et n'affiche jamais d'erreur.
 */
export function useUpdater() {
  const supported = updaterSupported();
  const [phase, setPhase] = useState<UpdatePhase>(supported ? { kind: "idle" } : { kind: "unsupported" });
  const [current, setCurrent] = useState<string | null>(null);
  const pending = useRef<PendingUpdate | null>(null);
  const backend = useRef<UpdaterBackend | null>(null);

  const resolveBackend = useCallback(
    () => (backend.current ??= isNativeShell() ? androidUpdater() : tauriUpdater()),
    [],
  );

  useEffect(() => {
    if (!supported) return;
    let alive = true;
    void resolveBackend()
      .version()
      .then((value) => {
        if (alive) setCurrent(value);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [supported, resolveBackend]);

  const check = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!supported) return null;
      const found = await checkForUpdate(resolveBackend(), setPhase, options);
      pending.current = found;
      return found;
    },
    [supported, resolveBackend],
  );

  const install = useCallback(async () => {
    const update = pending.current;
    if (!supported || !update) return;
    await installAndRelaunch(resolveBackend(), update, setPhase);
  }, [supported, resolveBackend]);

  useEffect(() => {
    if (!supported) return;
    try {
      if (window.sessionStorage.getItem(AUTO_CHECK_KEY)) return;
      window.sessionStorage.setItem(AUTO_CHECK_KEY, "done");
    } catch {
      return;
    }
    void check({ silent: true });
  }, [supported, check]);

  const busy = phase.kind === "checking" || phase.kind === "downloading" || phase.kind === "installing";
  const canInstall =
    phase.kind === "available" || phase.kind === "downloading" || phase.kind === "installing";

  return { supported, phase, current, busy, canInstall, check, install };
}
