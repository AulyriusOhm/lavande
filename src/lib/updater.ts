/**
 * Mises à jour de l'application.
 *
 * Deux backends : le plugin `updater` (bureau) et le plugin natif
 * `lavandeupdater` (Android : APK téléchargé puis confié à PackageInstaller).
 * Dans un navigateur ou sous les tests, tout répond « non pris en charge » sans
 * jamais charger un plugin. Les états et les transitions vivent dans des
 * fonctions pures, pilotées par un `UpdaterBackend` qu'un test peut remplacer.
 */
import { useSyncExternalStore } from "react";
import packageJson from "../../package.json";
import { isNativeShell, shellLayout } from "@/lib/native";
import { isTauriShell } from "@/lib/open-external";
import type { UpdatesPrefs } from "@/lib/prefs";

/** Version du front, affichée quand la coquille ne peut pas la donner. */
export const APP_VERSION: string = packageJson.version;

/** Un paquet RPM ne peut pas se réécrire dans un `/usr` monté en lecture seule. */
export const OSTREE_RPM =
  "Cette installation RPM ne peut pas se mettre à jour sur un système immuable (Fedora Atomic, Bazzite, Silverblue). Téléchargez l'AppImage sur lavande.lanro.eu : elle se met à jour toute seule.";

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
      const { invoke } = await import("@tauri-apps/api/core");
      const host = await invoke<{ immutable: boolean; bundle: string | null }>("update_host").catch(
        () => null,
      );
      const blocked = host?.immutable === true && host.bundle === "rpm";
      return {
        version: update.version,
        notes: update.body?.trim() ?? "",
        install: (onProgress) => {
          if (blocked) return Promise.reject(new Error(OSTREE_RPM));
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
      onProgress(null);
      try {
        const { path } = await invoke<{ path: string }>("plugin:lavandeupdater|download_apk", {
          url: apk.url,
        });
        await invoke("verify_android_update", {
          path,
          signature: apk.signature,
          version: apk.version,
        });
        const { allowed } = await invoke<{ allowed: boolean }>("plugin:lavandeupdater|can_install");
        if (!allowed) {
          await invoke("plugin:lavandeupdater|open_install_settings");
          throw new Error(ANDROID_UNKNOWN_SOURCES);
        }
        await invoke("plugin:lavandeupdater|install_apk", { path });
      } catch (error) {
        throw new Error(messageOf(error));
      }
    },
    close: async () => undefined,
  };
}

const LAST_CHECK_KEY = "lavande:updater-last-check";
const HOUR = 3_600_000;
const DEFAULT_SCHEDULE: UpdatesPrefs = { autoCheck: true, intervalHours: 24 };

type UpdaterSnapshot = { phase: UpdatePhase; current: string | null };

let snapshot: UpdaterSnapshot = { phase: { kind: "idle" }, current: null };
const listeners = new Set<() => void>();
let pending: PendingUpdate | null = null;
let checking: Promise<PendingUpdate | null> | null = null;
let installing: Promise<void> | null = null;
let readingVersion: Promise<void> | null = null;
let schedule: UpdatesPrefs = DEFAULT_SCHEDULE;
let timer: ReturnType<typeof setTimeout> | null = null;
let subscribers = 0;

const resolveBackend = () => (isNativeShell() ? androidUpdater() : tauriUpdater());

function publish(patch: Partial<UpdaterSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

const report = (phase: UpdatePhase) => publish({ phase });

/** Horodatage de la dernière vérification terminée : 0 si aucune. */
export function lastCheckAt(): number {
  try {
    const value = Number(window.localStorage.getItem(LAST_CHECK_KEY) ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function stampCheck() {
  try {
    window.localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {
    // stockage indisponible : la prochaine vérification repart de zéro
  }
}

function clearTimer() {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

function isDue() {
  const last = lastCheckAt();
  return last === 0 || Date.now() - last >= schedule.intervalHours * HOUR;
}

/** Une seule vérification à la fois, partagée par tous les consommateurs. */
function check(options: { silent?: boolean } = {}) {
  if (!updaterSupported()) return Promise.resolve<PendingUpdate | null>(null);
  if (checking) return checking;
  checking = (async () => {
    try {
      const found = await checkForUpdate(resolveBackend(), report, options);
      pending = found;
      return found;
    } finally {
      checking = null;
      stampCheck();
    }
  })();
  return checking;
}

function install() {
  if (!updaterSupported() || !pending) return Promise.resolve();
  if (installing) return installing;
  const update = pending;
  installing = installAndRelaunch(resolveBackend(), update, report).finally(() => {
    installing = null;
  });
  return installing;
}

function readVersion() {
  if (!updaterSupported() || readingVersion) return;
  readingVersion = resolveBackend()
    .version()
    .then((value) => {
      if (value !== snapshot.current) publish({ current: value });
    })
    .catch(() => undefined)
    .finally(() => {
      readingVersion = null;
    });
}

function plan() {
  clearTimer();
  if (subscribers === 0 || !schedule.autoCheck || !updaterSupported()) return;
  const wait = Math.max(0, lastCheckAt() + schedule.intervalHours * HOUR - Date.now());
  timer = setTimeout(() => {
    timer = null;
    void tick();
  }, wait);
}

async function tick() {
  if (subscribers === 0 || !updaterSupported()) return;
  if (!schedule.autoCheck) {
    clearTimer();
    return;
  }
  if (isDue()) await check({ silent: true });
  plan();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  subscribers += 1;
  if (subscribers === 1) {
    readVersion();
    void tick();
  }
  return () => {
    listeners.delete(listener);
    subscribers -= 1;
    if (subscribers === 0) clearTimer();
  };
}

const getSnapshot = () => snapshot;

/** Applique la préférence des réglages sans redémarrage : coupe ou replanifie. */
export function configureUpdaterSchedule(next: UpdatesPrefs) {
  if (next.autoCheck === schedule.autoCheck && next.intervalHours === schedule.intervalHours) return;
  schedule = { ...next };
  void tick();
}

const unsupportedCheck = () => Promise.resolve<PendingUpdate | null>(null);
const unsupportedInstall = () => Promise.resolve();

/**
 * État de la mise à jour pour l'UI, partagé par tous les consommateurs : une
 * vérification lancée depuis les réglages se voit dans la popup, et
 * réciproquement. La vérification de fond suit la fréquence des réglages et
 * n'affiche jamais d'erreur réseau.
 */
export function useUpdater() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (!updaterSupported()) {
    return {
      supported: false,
      phase: { kind: "unsupported" } as UpdatePhase,
      current: null,
      busy: false,
      canInstall: false,
      check: unsupportedCheck,
      install: unsupportedInstall,
    };
  }

  const phase = state.phase;
  return {
    supported: true,
    phase,
    current: state.current,
    busy: phase.kind === "checking" || phase.kind === "downloading" || phase.kind === "installing",
    canInstall:
      phase.kind === "available" || phase.kind === "downloading" || phase.kind === "installing",
    check,
    install,
  };
}
