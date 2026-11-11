import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, FolderTree, Loader2, PlugZap, Radar, Server, Sparkles } from "lucide-react";
import { ApiError, errorText, mailApi } from "@/lib/api";
import type { DiscoverySource, Encryption } from "@/lib/api";
import { accountSlug } from "@/lib/mail-backend";
import { isTauriShell, openExternal } from "@/lib/open-external";
import { OAuthGuide } from "@/components/oauth-guide";
import { useMailStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { IconButton, ToggleRow } from "@/components/ui/primitives";
import { MeshGlow } from "@/components/ui/backdrops";
import { BlurFade } from "@/components/ui/blur-fade";
import { ShimmerButton } from "@/components/ui/shimmer-button";

const ENCRYPTIONS: { value: Encryption; label: string; imap: number; smtp: number }[] = [
  { value: "tls", label: "TLS · 993 / 465", imap: 993, smtp: 465 },
  { value: "start_tls", label: "STARTTLS · 143 / 587", imap: 143, smtp: 587 },
];

const FIELD =
  "focus-ring h-11 w-full rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink placeholder:font-medium placeholder:text-ink-muted";
const LABEL = "text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase";

const portsOf = (value: Encryption) =>
  ENCRYPTIONS.find((entry) => entry.value === value) ?? ENCRYPTIONS[0];

async function waitForOAuth(session: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await mailApi.oauthStatus(session);
    if (status.status !== "pending") return status;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return { status: "failed" as const, error: "délai de consentement dépassé" };
}

const ORIGIN_LABEL: Record<DiscoverySource, string> = {
  ispdb: "base Thunderbird",
  autoconfig: "configuration du domaine",
  well_known: "configuration du domaine",
  guess: "détection par sondage",
};

export function ConnectScreen({
  onClose,
  variant = "mobile",
}: {
  onClose?: () => void;
  variant?: "mobile" | "desktop";
}) {
  const desktop = variant === "desktop";
  const { createAccount, useDemo, phase, refreshMailbox, notify } = useMailStore();
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState(String(ENCRYPTIONS[0].imap));
  const [imapEncryption, setImapEncryption] = useState<Encryption>(ENCRYPTIONS[0].value);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(String(ENCRYPTIONS[0].smtp));
  const [smtpEncryption, setSmtpEncryption] = useState<Encryption>(ENCRYPTIONS[0].value);
  const [busy, setBusy] = useState(false);
  const [syncFolders, setSyncFolders] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const builtInClientId =
    import.meta.env.VITE_OAUTH_CLIENT_ID ??
    import.meta.env.VITE_MICROSOFT_CLIENT_ID ??
    import.meta.env.VITE_GOOGLE_CLIENT_ID ??
    "";
  const [clientId, setClientId] = useState(builtInClientId);
  const [oauthBusy, setOauthBusy] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [redirectUri, setRedirectUri] = useState(
    isTauriShell()
      ? "http://127.0.0.1:8790/api/oauth/callback"
      : `${window.location.origin}/api/oauth/callback`,
  );

  useEffect(() => {
    let cancelled = false;
    mailApi
      .health()
      .then((health) => {
        if (!cancelled && health.public_url) {
          setRedirectUri(`${health.public_url}/api/oauth/callback`);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const [discovery, setDiscovery] = useState<{ tone: "ok" | "none"; text: string } | null>(null);

  const applyDiscovery = async () => {
    const address = email.trim();
    if (discovering || !address.includes("@")) return;
    setDiscovering(true);
    setDiscovery(null);
    try {
      const found = await mailApi.discover(address);
      const incoming = found.incoming;
      const outgoing = found.outgoing;
      if (!found.found || !incoming || !outgoing) {
        setDiscovery({
          tone: "none",
          text:
            found.reason ??
            "Aucune configuration publiée pour ce domaine : saisis les serveurs à la main.",
        });
        return;
      }
      const name = found.display_name || found.provider || "Configuration trouvée";
      setLabel((current) => current.trim() || name);
      setUsername((current) => current.trim() || incoming.username || address);
      setImapHost(incoming.host);
      setImapPort(String(incoming.port));
      setImapEncryption(incoming.encryption);
      setSmtpHost(outgoing.host);
      setSmtpPort(String(outgoing.port));
      setSmtpEncryption(outgoing.encryption);
      setDiscovery({
        tone: "ok",
        text: `${name} · ${found.source ? ORIGIN_LABEL[found.source] : "détection"}`,
      });
    } catch (failure: unknown) {
      setDiscovery({ tone: "none", text: errorText(failure) });
    } finally {
      setDiscovering(false);
    }
  };

  const changeImapEncryption = (value: Encryption) => {
    setImapEncryption(value);
    setImapPort(String(portsOf(value).imap));
  };

  const changeSmtpEncryption = (value: Encryption) => {
    setSmtpEncryption(value);
    setSmtpPort(String(portsOf(value).smtp));
  };

  const startOAuth = async (provider: "google" | "microsoft" | "custom") => {
    const address = email.trim();
    if (!address.includes("@")) {
      setOauthError("Renseigne d'abord l'adresse e-mail.");
      return;
    }
    if (!imapHost.trim() || !smtpHost.trim()) {
      setOauthError("Renseigne d'abord les serveurs (bouton « Détecter les serveurs » sous l'adresse).");
      return;
    }
    const tab = isTauriShell() ? null : window.open("", "_blank");
    setOauthBusy(provider);
    setOauthError(null);
    setPendingUrl(null);
    try {
      const started = await mailApi.oauthStart({
        provider,
        email: address,
        label: label.trim() || address,
        id: accountSlug(address),
        imap: { host: imapHost.trim(), port: Number(imapPort), encryption: imapEncryption },
        smtp: { host: smtpHost.trim(), port: Number(smtpPort), encryption: smtpEncryption },
        client_id: clientId.trim() || undefined,
      });
      if (tab) {
        tab.location.replace(started.auth_url);
      } else {
        openExternal(started.auth_url);
      }
      setPendingUrl(started.auth_url);
      const outcome = await waitForOAuth(started.session);
      if (outcome.status === "done") {
        setPendingUrl(null);
        setConnected(true);
        if (!syncFolders) {
          await mailApi
            .setSyncFolders(outcome.account_id ?? accountSlug(address), [])
            .catch((failure: unknown) =>
              notify(`Dossiers non enregistrés · ${errorText(failure)}`),
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await refreshMailbox();
        onClose?.();
        return;
      }
      tab?.close();
      setPendingUrl(null);
      setOauthError(outcome.error ?? "Connexion OAuth2 interrompue.");
    } catch (failure: unknown) {
      tab?.close();
      setPendingUrl(null);
      setOauthError(errorText(failure));
    } finally {
      setOauthBusy(null);
    }
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const id = accountSlug(email);
    setBusy(true);
    setError(null);
    createAccount({
      id,
      label: label.trim(),
      email: email.trim(),
      username: username.trim() || email.trim(),
      imap: { host: imapHost.trim(), port: Number(imapPort), encryption: imapEncryption },
      smtp: { host: smtpHost.trim(), port: Number(smtpPort), encryption: smtpEncryption },
      auth: { kind: "password", password },
    })
      .then(async () => {
        if (syncFolders) return;
        await mailApi
          .setSyncFolders(id, [])
          .catch((failure: unknown) => notify(`Dossiers non enregistrés · ${errorText(failure)}`));
      })
      .catch((failure: unknown) => {
        setError(
          failure instanceof ApiError
            ? `${failure.kind} · ${failure.message}`
            : errorText(failure),
        );
      })
      .finally(() => setBusy(false));
  };

  if (connected) {
    return (
      <div
        className={cn(
          "relative bg-canvas",
          desktop ? "grid h-full w-full place-items-center" : "flex h-full flex-col items-center justify-center px-6",
        )}
      >
        <MeshGlow className="h-44" />
        <div className="relative flex flex-col items-center text-center">
          <span className="grid size-14 place-items-center rounded-full bg-emerald-500/15 text-emerald-600">
            <CheckCircle2 className="size-7" strokeWidth={2.4} />
          </span>
          <h1 className="mt-4 text-[21px] leading-tight font-extrabold tracking-[-0.035em] text-ink">
            Authentification réussie
          </h1>
          <p className="mt-1 text-[12.5px] font-bold text-ink-soft">{label.trim() || email}</p>
          <p className="mt-3 inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-muted">
            <Loader2 className="size-3.5 animate-spin" />
            Ouverture de la boîte…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative bg-canvas",
        desktop ? "h-full w-full overflow-y-auto" : "flex h-full flex-col",
      )}
    >
      <MeshGlow className={desktop ? "h-52" : "h-36"} />

      <header
        className={cn(
          "relative flex shrink-0 items-center gap-2",
          desktop ? "mx-auto w-full max-w-[780px] px-10 pt-9 pb-2" : "px-3 pt-3 pb-1",
        )}
      >
        {onClose && (
          <IconButton aria-label="Fermer la connexion de compte" onClick={onClose}>
            <ArrowLeft className="size-4.5" />
          </IconButton>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-muted uppercase">Connexion</p>
          <h1
            className={cn(
              "mt-0.5 leading-tight font-extrabold tracking-[-0.035em] text-ink",
              desktop ? "text-[27px]" : "text-[21px]",
            )}
          >
            Ajouter un compte
          </h1>
        </div>
      </header>

      <form
        onSubmit={submit}
        className={cn(
          "relative min-h-0 flex-1 overflow-y-auto no-scrollbar",
          desktop ? "mx-auto w-full max-w-[780px] px-10 pt-3 pb-12" : "px-5 pt-2 pb-8",
        )}
      >
        <BlurFade yOffset={8}>
          <p className="text-[11.5px] leading-relaxed font-medium text-ink-muted">
            {phase === "empty"
              ? "Aucun compte n'est encore connecté au service mail local. Renseigne ton serveur IMAP et SMTP : la connexion est testée avant l'enregistrement."
              : "La connexion est testée par le service local avant tout enregistrement. Aucun mot de passe ne transite par l'interface."}
          </p>
        </BlurFade>

        <BlurFade delay={0.04}>
          <div className={cn("mt-4", desktop ? "grid grid-cols-2 gap-3" : "space-y-3")}>
            <div>
              <label htmlFor="connect-label" className={LABEL}>
                Libellé
              </label>
              <input
                id="connect-label"
                className={cn(FIELD, "mt-1.5")}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Perso, Studio…"
                autoComplete="off"
                required
              />
            </div>
            <div>
              <label htmlFor="connect-email" className={LABEL}>
                Adresse e-mail
              </label>
              <input
                id="connect-email"
                type="email"
                className={cn(FIELD, "mt-1.5")}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                onBlur={() => {
                  if (!imapHost.trim() && !smtpHost.trim()) void applyDiscovery();
                }}
                placeholder="prenom@domaine.fr"
                autoComplete="email"
                required
              />
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void applyDiscovery()}
                  disabled={discovering || !email.includes("@")}
                  className="focus-ring inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[11px] font-bold text-accent-ink transition-colors hover:border-accent-ring disabled:opacity-50"
                >
                  {discovering ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Radar className="size-3.5" strokeWidth={2.4} />
                  )}
                  Détecter les serveurs
                </button>
                {discovery ? (
                  <p
                    className={cn(
                      "min-w-0 truncate text-[11px] font-semibold",
                      discovery.tone === "ok" ? "text-emerald-600" : "text-ink-muted",
                    )}
                  >
                    {discovery.text}
                  </p>
                ) : null}
              </div>
            </div>
            <div className={cn("rounded-2xl border border-line bg-surface/60 p-3", desktop && "col-span-2")}>
              <p className={LABEL}>Connexion par OAuth2</p>
              <p className="mt-1 text-[11px] leading-relaxed font-medium text-ink-muted">
                {builtInClientId
                  ? "Le consentement s'ouvre dans ton navigateur, puis la boîte est relevée par le service local. Aucun mot de passe ne transite par l'interface."
                  : "Le consentement s'ouvre dans un nouvel onglet. Il faut un identifiant d'application OAuth (client_id) enregistré chez le fournisseur : rien n'est embarqué dans Lavande."}
              </p>
              {builtInClientId ? null : (
                <>
                  <input
                    className={cn(FIELD, "mt-2 h-9 text-[12px]")}
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                    placeholder="Application (client) ID"
                    autoComplete="off"
                    aria-label="Identifiant d'application OAuth"
                  />
                  <OAuthGuide redirectUri={redirectUri} />
                </>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => void startOAuth("google")}
                  disabled={oauthBusy !== null}
                  className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[11.5px] font-bold text-ink transition-colors hover:border-accent-ring disabled:opacity-50"
                >
                  {oauthBusy === "google" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <PlugZap className="size-3.5" strokeWidth={2.4} />
                  )}
                  Google
                </button>
                <button
                  type="button"
                  onClick={() => void startOAuth("microsoft")}
                  disabled={oauthBusy !== null}
                  className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[11.5px] font-bold text-ink transition-colors hover:border-accent-ring disabled:opacity-50"
                >
                  {oauthBusy === "microsoft" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <PlugZap className="size-3.5" strokeWidth={2.4} />
                  )}
                  Microsoft
                </button>
                {oauthBusy ? (
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted">
                    <CheckCircle2 className="size-3.5" />
                    en attente du consentement…
                  </span>
                ) : null}
              </div>
              {oauthError ? (
                <p className="mt-2 text-[11px] font-semibold text-rose-600">{oauthError}</p>
              ) : null}
              {pendingUrl ? (
                <p className="mt-2 text-[11px] leading-relaxed font-semibold text-ink-muted">
                  Rien ne s'est ouvert ?{" "}
                  <button
                    type="button"
                    onClick={() => openExternal(pendingUrl)}
                    className="font-bold text-accent-ink underline underline-offset-2"
                  >
                    Ouvrir la page de consentement
                  </button>
                </p>
              ) : null}
            </div>
            <div>
              <label htmlFor="connect-username" className={LABEL}>
                Identifiant
              </label>
              <input
                id="connect-username"
                className={cn(FIELD, "mt-1.5")}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="souvent l'adresse complète"
                autoComplete="username"
              />
            </div>
            <div>
              <label htmlFor="connect-password" className={LABEL}>
                Mot de passe
              </label>
              <input
                id="connect-password"
                type="password"
                className={cn(FIELD, "mt-1.5")}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
              />
            </div>
          </div>
        </BlurFade>

        <div className={cn("mt-5", desktop ? "grid grid-cols-2 gap-3" : "space-y-3")}>
        <BlurFade delay={0.08}>
          <fieldset className="rounded-2xl border border-line bg-surface p-3.5">
            <legend className="flex items-center gap-1.5 px-1 text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
              <Server className="size-3.5" />
              Réception IMAP
            </legend>
            <div className="mt-2 space-y-3">
              <div>
                <label htmlFor="connect-imap-host" className={LABEL}>
                  Hôte IMAP
                </label>
                <input
                  id="connect-imap-host"
                  className={cn(FIELD, "mt-1.5")}
                  value={imapHost}
                  onChange={(event) => setImapHost(event.target.value)}
                  placeholder="imap.domaine.fr"
                  autoComplete="off"
                  required
                />
              </div>
              <div className="flex gap-2">
                <div className="w-[104px] shrink-0">
                  <label htmlFor="connect-imap-port" className={LABEL}>
                    Port
                  </label>
                  <input
                    id="connect-imap-port"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={65535}
                    className={cn(FIELD, "mt-1.5 tabular-nums")}
                    value={imapPort}
                    onChange={(event) => setImapPort(event.target.value)}
                    required
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <label htmlFor="connect-imap-encryption" className={LABEL}>
                    Chiffrement
                  </label>
                  <select
                    id="connect-imap-encryption"
                    className={cn(FIELD, "mt-1.5 cursor-pointer")}
                    value={imapEncryption}
                    onChange={(event) => changeImapEncryption(event.target.value as Encryption)}
                  >
                    {ENCRYPTIONS.map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </fieldset>
        </BlurFade>

        <BlurFade delay={0.12}>
          <fieldset className="rounded-2xl border border-line bg-surface p-3.5">
            <legend className="flex items-center gap-1.5 px-1 text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
              <PlugZap className="size-3.5" />
              Envoi SMTP
            </legend>
            <div className="mt-2 space-y-3">
              <div>
                <label htmlFor="connect-smtp-host" className={LABEL}>
                  Hôte SMTP
                </label>
                <input
                  id="connect-smtp-host"
                  className={cn(FIELD, "mt-1.5")}
                  value={smtpHost}
                  onChange={(event) => setSmtpHost(event.target.value)}
                  placeholder="smtp.domaine.fr"
                  autoComplete="off"
                  required
                />
              </div>
              <div className="flex gap-2">
                <div className="w-[104px] shrink-0">
                  <label htmlFor="connect-smtp-port" className={LABEL}>
                    Port
                  </label>
                  <input
                    id="connect-smtp-port"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={65535}
                    className={cn(FIELD, "mt-1.5 tabular-nums")}
                    value={smtpPort}
                    onChange={(event) => setSmtpPort(event.target.value)}
                    required
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <label htmlFor="connect-smtp-encryption" className={LABEL}>
                    Chiffrement
                  </label>
                  <select
                    id="connect-smtp-encryption"
                    className={cn(FIELD, "mt-1.5 cursor-pointer")}
                    value={smtpEncryption}
                    onChange={(event) => changeSmtpEncryption(event.target.value as Encryption)}
                  >
                    {ENCRYPTIONS.map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </fieldset>
        </BlurFade>
        </div>

        <BlurFade delay={0.14}>
          <div className="mt-3 rounded-2xl border border-line bg-surface">
            <ToggleRow
              icon={<FolderTree className="size-4" />}
              label="Synchroniser les dossiers"
              hint={
                syncFolders
                  ? "Tous les dossiers du compte, affinables ensuite dans les réglages"
                  : "Le compte se connecte sans rien télécharger"
              }
              checked={syncFolders}
              onChange={setSyncFolders}
            />
          </div>
        </BlurFade>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-2xl border border-rose-200 bg-rose-500/10 px-3.5 py-2.5 text-[11.5px] leading-relaxed font-semibold break-words text-rose-600 dark:border-rose-500/30 dark:text-rose-300"
          >
            {error}
          </p>
        )}

        <div className={cn("mt-5 flex gap-2", desktop ? "flex-row items-center" : "flex-col")}>
          <ShimmerButton
            type="submit"
            disabled={busy}
            shimmerDuration={4}
            className={desktop ? "w-[260px]" : "w-full"}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
            {busy ? "Connexion en cours…" : "Tester et connecter"}
          </ShimmerButton>
          {import.meta.env.VITE_DISTRIBUTION === "1" ? null : (
            <button
              type="button"
              onClick={useDemo}
              className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-full text-[11.5px] font-bold text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <Sparkles className="size-3.5" />
              Voir la démo avec les données de la maquette
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
