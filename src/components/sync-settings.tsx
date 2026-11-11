import { useCallback, useEffect, useState } from "react";
import { sha256 } from "@noble/hashes/sha2.js";
import { Loader2, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import { usePlanning } from "@/lib/planning-store";
import { usePrefs } from "@/lib/prefs";
import { decodeBase64Url, encodeBase64Url } from "@/lib/sync/crypto";
import type { SyncDevice } from "@/lib/sync/client";
import type { SyncPhase } from "@/lib/sync/engine";
import { cn } from "@/lib/utils";
import { Badge, DButton, DIconButton, SectionLabel, Surface, TextInput } from "@/desktop/ui";
import { Switch, SwitchTrack } from "@/components/ui/primitives";
import { isNativeShell } from "@/lib/native";

const DEFAULT_SERVER = "http://127.0.0.1:8787";
const SERVER_KEY = "lavande.sync.serverUrl";
const NATIVE_HINT = "http://192.168.1.x:8787";
const PAIR_POLL_MS = 2000;

function initialServerUrl(): string {
  const fallback = isNativeShell() ? "" : DEFAULT_SERVER;
  try {
    const saved = window.localStorage.getItem(SERVER_KEY);
    return saved === null || saved === "" ? fallback : saved;
  } catch {
    return fallback;
  }
}

function rememberServer(url: string): void {
  try {
    window.localStorage.setItem(SERVER_KEY, url);
  } catch {
    return;
  }
}

const PHASE: Record<SyncPhase, { label: string; tone: "neutral" | "amber" | "sky" | "green" | "rose" }> = {
  unconfigured: { label: "Non configuré", tone: "neutral" },
  offline: { label: "Hors ligne", tone: "amber" },
  syncing: { label: "Synchronisation…", tone: "sky" },
  synced: { label: "Synchronisé", tone: "green" },
  error: { label: "Erreur", tone: "rose" },
  read_only: { label: "Lecture seule", tone: "rose" },
};

const WHEN = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });

function formatWhen(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : WHEN.format(date);
}

function messageOf(failure: unknown, fallback: string) {
  return failure instanceof Error && failure.message !== "" ? failure.message : fallback;
}

function shortFingerprint(publicKey: string) {
  try {
    return encodeBase64Url(sha256(decodeBase64Url(publicKey))).slice(0, 8);
  } catch {
    return "—";
  }
}

function SyncToggle({
  label,
  hint,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-3.5 py-2.5 transition-opacity",
        disabled && "opacity-45",
      )}
    >
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block text-[12.5px] font-bold text-ink">{label}</span>
        <span className="block text-[10.5px] font-medium text-ink-muted">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="focus-ring grid size-11 shrink-0 place-items-center rounded-full disabled:cursor-not-allowed"
      >
        <SwitchTrack checked={checked} />
      </button>
    </div>
  );
}

export function SyncSettings({ variant = "mobile" }: { variant?: "mobile" | "desktop" }) {
  const { sync, syncNow, engine } = usePlanning();
  const { sync: syncPrefs, setSync } = usePrefs();
  const mobile = variant === "mobile";
  const configured = sync.phase !== "unconfigured";
  const phase = PHASE[sync.phase];

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [devices, setDevices] = useState<SyncDevice[]>([]);
  const [claimCode, setClaimCode] = useState("");
  const [claimed, setClaimed] = useState<{ code: string; deviceId: string; fingerprint: string } | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string; pollSecret: string } | null>(null);

  const account = engine.getState().account;
  const own = engine.getState().device;
  const autoSync = engine.getState().autoSync;

  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(messageOf(failure, "action impossible"));
    } finally {
      setBusy(null);
    }
  }, []);

  const refreshDevices = useCallback(
    () => run("devices", async () => setDevices(await engine.listDevices())),
    [engine, run],
  );

  useEffect(() => {
    if (!configured) return;
    void refreshDevices();
  }, [configured, refreshDevices]);

  useEffect(() => {
    if (pairing === null) return;
    const timer = window.setInterval(() => {
      void engine
        .pairPoll(pairing.code, pairing.pollSecret)
        .then((result) => {
          if (result !== "completed") return;
          setPairing(null);
          setClaimed(null);
        })
        .catch((failure: unknown) => {
          setPairing(null);
          setError(messageOf(failure, "appairage interrompu"));
        });
    }, PAIR_POLL_MS);
    return () => window.clearInterval(timer);
  }, [engine, pairing]);

  const ready = email.trim() !== "" && password !== "" && serverUrl.trim() !== "";

  const create = () =>
    run("create", async () => {
      const url = serverUrl.trim();
      await engine.createAccount({ serverUrl: url, email: email.trim(), password });
      rememberServer(url);
      setPassword("");
    });

  const login = () =>
    run("login", async () => {
      const url = serverUrl.trim();
      await engine.loginAccount({ serverUrl: url, email: email.trim(), password });
      rememberServer(url);
      setPassword("");
    });

  const logout = () =>
    run("logout", async () => {
      await engine.logoutAccount();
      setDevices([]);
      setClaimed(null);
      setClaimCode("");
    });

  const revoke = (id: string) =>
    run(`revoke:${id}`, async () => {
      await engine.revokeDevice(id);
      setDevices(await engine.listDevices());
    });

  const claim = () =>
    run("claim", async () => {
      const code = claimCode.trim().toUpperCase();
      const result = await engine.pairClaim(code);
      setClaimed({ code, deviceId: result.deviceId, fingerprint: result.fingerprint });
    });

  const completeClaim = () =>
    run("complete", async () => {
      if (claimed === null) return;
      await engine.pairComplete(claimed.code);
      setClaimed(null);
      setClaimCode("");
      setDevices(await engine.listDevices());
    });

  const startPairing = () =>
    run("pair", async () => {
      setPairing(await engine.pairStart(serverUrl.trim()));
    });

  const field = mobile ? "min-h-11" : "";
  const action = mobile ? "min-h-11 flex-1 rounded-full" : "";
  const small = mobile ? "text-[11px]" : "text-[10.5px]";
  const errorText = "mt-2 text-[11px] font-semibold text-rose-600 dark:text-rose-300";
  const master = syncPrefs.enabled;
  const planningSync = master && syncPrefs.kanban;

  return (
    <div className="space-y-3">
      <Surface className="overflow-hidden pb-1">
        <div className="px-3.5 pt-3">
          <SectionLabel>Synchronisation</SectionLabel>
        </div>
        <div className="mt-1.5 divide-y divide-line/70 border-t border-line/70">
          <SyncToggle
            label="Tout synchroniser"
            hint="Coupe ou rétablit toutes les synchronisations d'un coup"
            checked={master}
            onChange={(value) => setSync({ enabled: value })}
          />
          <SyncToggle
            label="Mails"
            hint="Relève automatiquement les nouveaux messages et rafraîchit la boîte"
            checked={syncPrefs.mails}
            disabled={!master}
            onChange={(value) => setSync({ mails: value })}
          />
          <SyncToggle
            label="Calendrier"
            hint="Conserve les rendez-vous et les partage entre tes fenêtres"
            checked={syncPrefs.calendar}
            disabled={!master}
            onChange={(value) => setSync({ calendar: value })}
          />
          <SyncToggle
            label="Kanban / tâches"
            hint="Tâches, suggestions et planning entre tes appareils"
            checked={syncPrefs.kanban}
            disabled={!master}
            onChange={(value) => setSync({ kanban: value })}
          />
        </div>
        {!master ? (
          <p className={cn("px-3.5 pt-1 pb-2.5 font-semibold text-ink-muted", small)}>
            Toute synchronisation est coupée : rien ne quitte cet appareil. La synchronisation manuelle
            d'un dossier reste possible.
          </p>
        ) : null}
      </Surface>

      <Surface className="p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={phase.tone}>{phase.label}</Badge>
          <span className={cn("font-semibold text-ink-muted", small)}>
            {sync.pending} opération{sync.pending > 1 ? "s" : ""} en attente
          </span>
          <span className={cn("font-semibold text-ink-muted", small)}>
            dernière synchro : {sync.lastSyncAt === undefined ? "jamais" : formatWhen(sync.lastSyncAt)}
          </span>
          <DButton
            variant="soft"
            size="sm"
            className={cn("ml-auto", mobile && "min-h-11 rounded-full")}
            disabled={busy !== null || sync.phase === "syncing" || !planningSync}
            onClick={() => void syncNow()}
          >
            <RefreshCw className={cn("size-3.5", sync.phase === "syncing" && "animate-spin")} />
            Synchroniser
          </DButton>
        </div>
        {sync.error !== undefined ? <p className={errorText}>{sync.error}</p> : null}
        {error !== null ? <p className={errorText}>{error}</p> : null}
        {!planningSync ? (
          <p className={cn("mt-1.5 font-semibold text-ink-muted", small)}>
            {master
              ? "Synchronisation des tâches coupée : les modifications restent locales."
              : "Synchronisation globale coupée : le planning ne quitte pas cet appareil."}
          </p>
        ) : null}
        <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-line/70 pt-2.5">
          <span className={cn("font-semibold text-ink-muted", small)}>Synchro automatique (30 s)</span>
          <Switch
            checked={autoSync && planningSync}
            label="Synchro automatique"
            onChange={(value) => engine.setAutoSync(value)}
          />
        </div>
      </Surface>

      {!configured ? (
        <>
          <Surface className="p-3.5">
            <SectionLabel>Créer ou connecter un compte</SectionLabel>
            <div className="mt-2 space-y-2">
              <TextInput
                aria-label="URL du serveur"
                className={field}
                value={serverUrl}
                placeholder={isNativeShell() ? NATIVE_HINT : DEFAULT_SERVER}
                onChange={(event) => setServerUrl(event.target.value)}
              />
              <TextInput
                aria-label="E-mail"
                type="email"
                className={field}
                value={email}
                placeholder="nom@domaine.fr"
                onChange={(event) => setEmail(event.target.value)}
              />
              <TextInput
                aria-label="Mot de passe"
                type="password"
                className={field}
                value={password}
                placeholder="mot de passe"
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <DButton
                variant="primary"
                className={action}
                disabled={busy !== null || !ready}
                onClick={() => void create()}
              >
                Créer le compte
              </DButton>
              <DButton
                variant="ghost"
                className={action}
                disabled={busy !== null || !ready}
                onClick={() => void login()}
              >
                Se connecter
              </DButton>
            </div>
            <p className={cn("mt-2 leading-relaxed font-medium text-ink-muted", small)}>
              Le mot de passe dérive la clé maîtresse : il ne quitte jamais cet appareil. Seuls les
              documents chiffrés transitent par le serveur.
            </p>
          </Surface>

          <Surface className="p-3.5">
            <SectionLabel>Cet appareil est nouveau</SectionLabel>
            <p className={cn("mt-1.5 leading-relaxed font-medium text-ink-muted", small)}>
              Ouvre un code sur l'appareil déjà synchronisé, puis saisis-le ici pour recevoir la clé.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <TextInput
                aria-label="URL du serveur d'appairage"
                className={cn(field, "min-w-0 flex-1")}
                value={serverUrl}
                placeholder={DEFAULT_SERVER}
                onChange={(event) => setServerUrl(event.target.value)}
              />
              <DButton
                variant="soft"
                className={action}
                disabled={busy !== null || serverUrl.trim() === "" || pairing !== null}
                onClick={() => void startPairing()}
              >
                <ShieldCheck className="size-3.5" />
                Demander un code
              </DButton>
            </div>
            {pairing !== null ? (
              <div className="mt-2.5 rounded-2xl bg-surface-2 p-3 text-center">
                <p className="text-[10px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                  Code d'appairage
                </p>
                <p className="mt-1 font-mono text-[26px] leading-none font-extrabold tracking-[0.28em] text-ink">
                  {pairing.code}
                </p>
                <p className="mt-1.5 font-mono text-[10px] font-semibold text-ink-muted">
                  valable jusqu'à {formatWhen(pairing.expiresAt)}
                </p>
                <p className="mt-1.5 inline-flex items-center gap-1.5 text-[10.5px] font-semibold text-accent-ink">
                  <Loader2 className="size-3 animate-spin" />
                  En attente de l'autre appareil…
                </p>
              </div>
            ) : null}
          </Surface>
        </>
      ) : (
        <>
          <Surface className="p-3.5">
            <SectionLabel>Compte synchronisé</SectionLabel>
            <p className="mt-2 truncate text-[12.5px] font-bold text-ink">
              {account !== undefined && account.email !== "" ? account.email : "appareil appairé"}
            </p>
            <p className={cn("truncate font-mono font-medium text-ink-muted", small)}>
              {account?.serverUrl ?? DEFAULT_SERVER}
            </p>
            <p className={cn("mt-1 truncate font-mono font-medium text-ink-muted", small)}>
              cet appareil · {own.name} · {shortFingerprint(own.pubKey)}
            </p>
            <DButton
              variant="ghost"
              className={cn("mt-2.5", mobile && "min-h-11 rounded-full")}
              disabled={busy !== null}
              onClick={() => void logout()}
            >
              <LogOut className="size-3.5" />
              Se déconnecter
            </DButton>
          </Surface>

          <Surface className="p-3.5">
            <div className="flex items-center gap-2">
              <SectionLabel>Appareils</SectionLabel>
              <DIconButton
                label="Rafraîchir les appareils"
                className="ml-auto size-8"
                disabled={busy !== null}
                onClick={() => void refreshDevices()}
              >
                <RefreshCw className={cn("size-3.5", busy === "devices" && "animate-spin")} />
              </DIconButton>
            </div>
            {devices.length === 0 ? (
              <p className={cn("mt-2 font-medium text-ink-muted", small)}>Aucun appareil connu.</p>
            ) : (
              <ul className="mt-1.5 divide-y divide-line/70">
                {devices.map((device) => (
                  <li key={device.id} className="flex items-center gap-2 py-2">
                    <div className="min-w-0 flex-1 leading-tight">
                      <p className="flex items-center gap-1.5 truncate text-[12px] font-bold text-ink">
                        {device.name}
                        {device.current ? <Badge tone="accent">cet appareil</Badge> : null}
                      </p>
                      <p className="truncate font-mono text-[10px] font-semibold text-ink-muted">
                        {device.platform} ·{" "}
                        {device.current ? shortFingerprint(own.pubKey) : device.id.slice(0, 8)} · v
                        {device.schemaVersion}
                      </p>
                    </div>
                    <DButton
                      variant="danger"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void revoke(device.id)}
                    >
                      Révoquer
                    </DButton>
                  </li>
                ))}
              </ul>
            )}
          </Surface>

          <Surface className="p-3.5">
            <SectionLabel>Ajouter un appareil</SectionLabel>
            <p className={cn("mt-1.5 leading-relaxed font-medium text-ink-muted", small)}>
              Saisis le code affiché par le nouvel appareil, vérifie son empreinte, puis confirme.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <TextInput
                aria-label="Code d'appairage"
                className={cn(field, "min-w-0 flex-1 font-mono tracking-[0.2em] uppercase")}
                maxLength={6}
                value={claimCode}
                placeholder="ABC123"
                onChange={(event) => setClaimCode(event.target.value.toUpperCase())}
              />
              <DButton
                variant="soft"
                className={action}
                disabled={busy !== null || claimCode.trim().length !== 6}
                onClick={() => void claim()}
              >
                Vérifier le code
              </DButton>
            </div>
            {claimed !== null ? (
              <div className="mt-2.5 rounded-2xl bg-surface-2 p-3">
                <p className="text-[10px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                  Empreinte de l'appareil demandeur
                </p>
                <p className="mt-1 font-mono text-[13px] font-bold break-all text-ink">{claimed.fingerprint}</p>
                <p className="mt-1 truncate font-mono text-[10px] font-medium text-ink-muted">
                  {claimed.deviceId}
                </p>
                <DButton
                  variant="primary"
                  className={cn("mt-2.5", mobile && "min-h-11 rounded-full")}
                  disabled={busy !== null}
                  onClick={() => void completeClaim()}
                >
                  <ShieldCheck className="size-3.5" />
                  Confirmer l'appairage
                </DButton>
              </div>
            ) : null}
          </Surface>
        </>
      )}
    </div>
  );
}
