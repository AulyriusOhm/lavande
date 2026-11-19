import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  APP_VERSION,
  OSTREE_RPM,
  androidUpdater,
  checkForUpdate,
  compareVersions,
  installAndRelaunch,
  messageOf,
  phaseLabel,
  tauriUpdater,
  updaterSupported,
  useUpdater,
  type PendingUpdate,
  type UpdatePhase,
  type UpdaterBackend,
} from "@/lib/updater";

const { invokeMock, fetchMock, getVersionMock, pluginCheckMock, pluginRelaunchMock } = vi.hoisted(
  () => ({
    invokeMock: vi.fn(),
    fetchMock: vi.fn(),
    getVersionMock: vi.fn(),
    pluginCheckMock: vi.fn(),
    pluginRelaunchMock: vi.fn(),
  }),
);

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: getVersionMock }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: pluginCheckMock }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: pluginRelaunchMock }));

const ANDROID_ENDPOINT = "https://lavande.lanro.eu/updates/latest.json";
const APK_URL = "https://lavande.lanro.eu/updates/Lavande.apk";
const APK_PATH = "/data/user/0/eu.lanro.lavande/cache/Lavande.apk";
const UNKNOWN_SOURCES =
  "Autorisez l'installation d'applications inconnues pour Lavande, puis relancez la mise à jour.";

function shellOn(platform: "desktop" | "android" | "browser" | "preview-app") {
  if (platform === "desktop" || platform === "android") {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
      platform === "android" ? "Mozilla/5.0 (Linux; Android 14) wv" : "Mozilla/5.0 (X11; Linux x86_64)",
    );
  }
  if (platform === "preview-app") window.history.replaceState({}, "", "/?app");
}

function androidManifest(
  patch: { version?: string; notes?: string; platforms?: Record<string, unknown> } = {},
) {
  return {
    version: "0.3.0",
    notes: "  Nouveautés  ",
    platforms: { android: { signature: "c2lnbmF0dXJl", url: APK_URL } },
    ...patch,
  };
}

function serve(json: unknown) {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => json });
}

function androidShell(options: { allowed?: boolean } = {}) {
  const commands: string[] = [];
  invokeMock.mockImplementation(async (command: string) => {
    commands.push(command);
    if (command === "android_update_endpoint") return ANDROID_ENDPOINT;
    if (command === "plugin:lavandeupdater|download_apk") return { path: APK_PATH };
    if (command === "plugin:lavandeupdater|can_install") return { allowed: options.allowed ?? true };
    if (command === "plugin:lavandeupdater|install_apk") return { sessionId: 7 };
    return null;
  });
  return commands;
}

beforeEach(() => {
  getVersionMock.mockResolvedValue("0.2.4");
  serve(androidManifest());
});

afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.history.replaceState({}, "", "/");
});

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
    expect(phaseLabel({ kind: "unsupported" }).label).toBe("Non disponible dans le navigateur");
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

describe("compareVersions", () => {
  it("ordonne les numéros de version", () => {
    expect(compareVersions("0.3.0", "0.2.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.4", "0.2.4")).toBe(0);
    expect(compareVersions("0.1.9", "0.2.0")).toBeLessThan(0);
  });

  it("traite les segments absents comme des zéros", () => {
    expect(compareVersions("0.3", "0.3.0")).toBe(0);
    expect(compareVersions("0.3.1", "0.3")).toBeGreaterThan(0);
    expect(compareVersions("1", "1.0.1")).toBeLessThan(0);
  });

  it("ignore le « v » initial", () => {
    expect(compareVersions("v0.2.4", "0.2.4")).toBe(0);
    expect(compareVersions("V0.3.0", "0.2.4")).toBeGreaterThan(0);
  });
});

describe("updaterSupported", () => {
  it("accepte la coquille de bureau", () => {
    shellOn("desktop");
    expect(updaterSupported()).toBe(true);
  });

  it("accepte la coquille Android", () => {
    shellOn("android");
    expect(updaterSupported()).toBe(true);
  });

  it("refuse la maquette ?app dans un navigateur", () => {
    shellOn("preview-app");
    expect(updaterSupported()).toBe(false);
  });

  it("refuse un navigateur ordinaire", () => {
    shellOn("browser");
    expect(updaterSupported()).toBe(false);
  });
});

describe("androidUpdater.check", () => {
  it("manifeste plus récent et bloc android : mise à jour proposée", async () => {
    shellOn("android");
    const commands = androidShell();
    const pending = await androidUpdater().check();
    expect(pending).not.toBeNull();
    expect(pending?.version).toBe("0.3.0");
    expect(pending?.notes).toBe("Nouveautés");
    expect(commands).toEqual(["android_update_endpoint"]);
    expect(fetchMock).toHaveBeenCalledWith(ANDROID_ENDPOINT, { connectTimeout: 20_000 });
  });

  it("version identique : rien à installer", async () => {
    shellOn("android");
    androidShell();
    serve(androidManifest({ version: "0.2.4" }));
    await expect(androidUpdater().check()).resolves.toBeNull();
  });

  it("bloc android absent : rien à installer", async () => {
    shellOn("android");
    androidShell();
    serve(androidManifest({ platforms: {} }));
    await expect(androidUpdater().check()).resolves.toBeNull();
  });

  it("manifeste sans signature : erreur explicite", async () => {
    shellOn("android");
    androidShell();
    serve(androidManifest({ platforms: { android: { url: APK_URL } } }));
    await expect(androidUpdater().check()).rejects.toThrow("manifeste Android incomplet");
  });

  it("manifeste inaccessible : erreur avec le statut", async () => {
    shellOn("android");
    androidShell();
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    await expect(androidUpdater().check()).rejects.toThrow("manifeste de mise à jour inaccessible (503)");
  });
});

describe("androidUpdater.install", () => {
  it("télécharge, vérifie, contrôle l'autorisation puis installe", async () => {
    shellOn("android");
    const commands = androidShell();
    const pending = await androidUpdater().check();
    const percents: (number | null)[] = [];
    await pending?.install((percent) => percents.push(percent));

    expect(commands).toEqual([
      "android_update_endpoint",
      "plugin:lavandeupdater|download_apk",
      "verify_android_update",
      "plugin:lavandeupdater|can_install",
      "plugin:lavandeupdater|install_apk",
    ]);
    expect(invokeMock).toHaveBeenCalledWith("plugin:lavandeupdater|download_apk", { url: APK_URL });
    expect(invokeMock).toHaveBeenCalledWith("verify_android_update", {
      path: APK_PATH,
      signature: "c2lnbmF0dXJl",
      version: "0.3.0",
    });
    expect(invokeMock).toHaveBeenCalledWith("plugin:lavandeupdater|install_apk", { path: APK_PATH });
    expect(percents).toEqual([null]);
  });

  it("installateur non autorisé : réglages ouverts et erreur française", async () => {
    shellOn("android");
    const commands = androidShell({ allowed: false });
    const pending = await androidUpdater().check();
    await expect(pending?.install(() => undefined)).rejects.toThrow(UNKNOWN_SOURCES);
    expect(invokeMock).toHaveBeenCalledWith("plugin:lavandeupdater|open_install_settings");
    expect(commands).not.toContain("plugin:lavandeupdater|install_apk");
  });

  it("échec natif en chaîne : remonté en Error", async () => {
    shellOn("android");
    androidShell();
    const pending = await androidUpdater().check();
    invokeMock.mockRejectedValueOnce("téléchargement interrompu");
    await expect(pending?.install(() => undefined)).rejects.toThrow("téléchargement interrompu");
  });
});

function hostProbe(response: { immutable: boolean; bundle: string | null } | Error) {
  const commands: string[] = [];
  invokeMock.mockImplementation(async (command: string) => {
    commands.push(command);
    if (command !== "update_host") return null;
    if (response instanceof Error) throw response;
    return response;
  });
  return commands;
}

function pluginUpdate() {
  const downloadAndInstall = vi.fn(async (onEvent: (event: unknown) => void) => {
    onEvent({ event: "Started", data: { contentLength: 200 } });
    onEvent({ event: "Progress", data: { chunkLength: 100 } });
    onEvent({ event: "Finished", data: {} });
  });
  pluginCheckMock.mockResolvedValue({
    version: "0.3.0",
    body: "  Nouveautés  ",
    downloadAndInstall,
    close: vi.fn(async () => undefined),
  });
  return downloadAndInstall;
}

describe("tauriUpdater sur un hôte ostree", () => {
  beforeEach(() => {
    shellOn("desktop");
    pluginRelaunchMock.mockResolvedValue(undefined);
  });

  it("RPM sur système immuable : installation refusée sans téléchargement", async () => {
    const commands = hostProbe({ immutable: true, bundle: "rpm" });
    const downloadAndInstall = pluginUpdate();

    const pending = await tauriUpdater().check();

    expect(commands).toEqual(["update_host"]);
    expect(pending?.version).toBe("0.3.0");
    expect(pending?.notes).toBe("Nouveautés");
    await expect(pending?.install(() => undefined)).rejects.toThrow(OSTREE_RPM);
    expect(downloadAndInstall).not.toHaveBeenCalled();
  });

  it("AppImage sur système immuable : installation normale", async () => {
    hostProbe({ immutable: true, bundle: "appimage" });
    const downloadAndInstall = pluginUpdate();

    const pending = await tauriUpdater().check();
    const percents: (number | null)[] = [];
    await pending?.install((percent) => percents.push(percent));

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(percents).toEqual([0, 50, 100]);
  });

  it("RPM sur système classique : installation normale", async () => {
    hostProbe({ immutable: false, bundle: "rpm" });
    const downloadAndInstall = pluginUpdate();

    const pending = await tauriUpdater().check();
    await pending?.install(() => undefined);

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  it("sonde indisponible : le flux normal reprend", async () => {
    hostProbe(new Error("commande inconnue"));
    const downloadAndInstall = pluginUpdate();

    const pending = await tauriUpdater().check();
    await pending?.install(() => undefined);

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  it("le refus remonte dans l'état d'échec de installAndRelaunch", async () => {
    hostProbe({ immutable: true, bundle: "rpm" });
    pluginUpdate();
    const { phases, report } = recorder();

    const pending = await tauriUpdater().check();
    await installAndRelaunch(tauriUpdater(), pending as PendingUpdate, report);

    expect(phases.at(-1)).toEqual({ kind: "error", message: OSTREE_RPM });
    expect(pluginRelaunchMock).not.toHaveBeenCalled();
  });
});

describe("useUpdater sur la coquille Android", () => {
  it("résout le backend natif et lit la version installée", async () => {
    shellOn("android");
    androidShell();
    serve(androidManifest({ version: "0.2.4" }));
    const { result } = renderHook(() => useUpdater());
    expect(result.current.supported).toBe(true);
    await vi.waitFor(() => expect(result.current.current).toBe("0.2.4"));
    await vi.waitFor(() => expect(result.current.phase.kind).toBe("current"));
  });
});
