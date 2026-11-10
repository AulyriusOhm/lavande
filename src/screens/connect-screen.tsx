import { useState } from "react";
import { ArrowLeft, Loader2, PlugZap, Server, Sparkles } from "lucide-react";
import { ApiError, errorText } from "@/lib/api";
import type { Encryption } from "@/lib/api";
import { accountSlug } from "@/lib/mail-backend";
import { useMailStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/primitives";
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

export function ConnectScreen({ onClose }: { onClose?: () => void }) {
  const { createAccount, useDemo, phase } = useMailStore();
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
  const [error, setError] = useState<string | null>(null);

  const changeImapEncryption = (value: Encryption) => {
    setImapEncryption(value);
    setImapPort(String(portsOf(value).imap));
  };

  const changeSmtpEncryption = (value: Encryption) => {
    setSmtpEncryption(value);
    setSmtpPort(String(portsOf(value).smtp));
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    createAccount({
      id: accountSlug(email),
      label: label.trim(),
      email: email.trim(),
      username: username.trim() || email.trim(),
      imap: { host: imapHost.trim(), port: Number(imapPort), encryption: imapEncryption },
      smtp: { host: smtpHost.trim(), port: Number(smtpPort), encryption: smtpEncryption },
      auth: { kind: "password", password },
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

  return (
    <div className="relative flex h-full flex-col bg-canvas">
      <MeshGlow className="h-36" />

      <header className="relative flex shrink-0 items-center gap-2 px-3 pt-3 pb-1">
        {onClose && (
          <IconButton aria-label="Fermer la connexion de compte" onClick={onClose}>
            <ArrowLeft className="size-4.5" />
          </IconButton>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-muted uppercase">Connexion</p>
          <h1 className="mt-0.5 text-[21px] leading-tight font-extrabold tracking-[-0.035em] text-ink">
            Ajouter un compte
          </h1>
        </div>
      </header>

      <form onSubmit={submit} className="relative min-h-0 flex-1 overflow-y-auto no-scrollbar px-5 pt-2 pb-8">
        <BlurFade yOffset={8}>
          <p className="text-[11.5px] leading-relaxed font-medium text-ink-muted">
            {phase === "empty"
              ? "Aucun compte n'est encore connecté au service mail local. Renseigne ton serveur IMAP et SMTP : la connexion est testée avant l'enregistrement."
              : "La connexion est testée par le service local avant tout enregistrement. Aucun mot de passe ne transite par l'interface."}
          </p>
        </BlurFade>

        <BlurFade delay={0.04}>
          <div className="mt-4 space-y-3">
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
                placeholder="prenom@domaine.fr"
                autoComplete="email"
                required
              />
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

        <BlurFade delay={0.08}>
          <fieldset className="mt-5 rounded-2xl border border-line bg-surface p-3.5">
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
          <fieldset className="mt-3 rounded-2xl border border-line bg-surface p-3.5">
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

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-2xl border border-rose-200 bg-rose-500/10 px-3.5 py-2.5 text-[11.5px] leading-relaxed font-semibold break-words text-rose-600 dark:border-rose-500/30 dark:text-rose-300"
          >
            {error}
          </p>
        )}

        <div className="mt-5 flex flex-col gap-2">
          <ShimmerButton type="submit" disabled={busy} shimmerDuration={4} className="w-full">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
            {busy ? "Connexion en cours…" : "Tester et connecter"}
          </ShimmerButton>
          <button
            type="button"
            onClick={useDemo}
            className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-full text-[11.5px] font-bold text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Sparkles className="size-3.5" />
            Voir la démo avec les données de la maquette
          </button>
        </div>
      </form>
    </div>
  );
}
