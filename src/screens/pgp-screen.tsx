import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Check,
  ChevronDown,
  Copy,
  Download,
  KeyRound,
  Loader2,
  Lock,
  PenLine,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { errorText } from "@/lib/api";
import { useMailStore } from "@/lib/store";
import { usePrefs } from "@/lib/prefs";
import {
  PGP_STATE,
  formatFingerprint,
  formatKeyDate,
  isExpired,
  keyLabel,
  keyState,
  keyUsage,
  shortFingerprint,
  type PgpKey,
} from "@/lib/pgp";
import { deleteKey, exportKey, generateKey, importKey, listKeys } from "@/lib/pgp-api";
import { cn } from "@/lib/utils";
import { Avatar, Card, IconButton, SectionTitle, ToggleRow } from "@/components/ui/primitives";
import { BlurFade } from "@/components/ui/blur-fade";
import { MeshGlow } from "@/components/ui/backdrops";

const FIELD =
  "focus-ring h-11 w-full rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink placeholder:font-medium placeholder:text-ink-muted";
const LABEL = "text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase";
const ACTION =
  "focus-ring flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[11.5px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink disabled:opacity-50";

const STATE_TONE: Record<ReturnType<typeof keyState>, string> = {
  valid: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  expired: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  revoked: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
};

function downloadKey(armored: string, fingerprint: string) {
  const blob = new Blob([armored], { type: "application/pgp-keys" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${fingerprint.slice(-16).toUpperCase()}.asc`;
  link.click();
  URL.revokeObjectURL(url);
}

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
}

export function PgpScreen({ onClose }: { onClose: () => void }) {
  const { notify } = useMailStore();
  const {
    pgpEncrypt,
    pgpSign,
    attachPublicKey,
    setPgpEncrypt,
    setPgpSign,
    setAttachPublicKey,
  } = usePrefs();

  const [keys, setKeys] = useState<PgpKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"none" | "generate" | "import">("none");
  const [busy, setBusy] = useState<"generate" | "import" | "refresh" | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [armored, setArmored] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [exported, setExported] = useState<{ fingerprint: string; armored: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      setBusy("refresh");
      try {
        const next = await listKeys(signal);
        if (alive.current) setKeys(next);
      } catch (failure) {
        if (!alive.current || (failure instanceof DOMException && failure.name === "AbortError")) return;
        setKeys([]);
        setError(errorText(failure));
      } finally {
        if (alive.current) setBusy(null);
      }
    },
    [],
  );

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [load]);

  const feedback = (text: string) => {
    try {
      notify(text);
    } catch {
      setError(text);
    }
  };

  const runGenerate = async () => {
    const cleanName = name.trim();
    const cleanEmail = email.trim();
    if (!cleanName || !cleanEmail) {
      setError("Nom et adresse e-mail requis pour générer une clé.");
      return;
    }
    setBusy("generate");
    setError(null);
    try {
      const result = await generateKey({ name: cleanName, email: cleanEmail });
      setKeys((current) => [result.key, ...(current ?? []).filter((k) => k.fingerprint !== result.key.fingerprint)]);
      setExported({ fingerprint: result.key.fingerprint, armored: result.public_key });
      setOpenKey(result.key.fingerprint);
      setPanel("none");
      setName("");
      setEmail("");
      feedback(`Clé générée · ${keyLabel(result.key)}`);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    const clean = armored.trim();
    if (!clean.includes("BEGIN PGP")) {
      setError("Colle un bloc de clé publique ASCII armor (-----BEGIN PGP PUBLIC KEY BLOCK-----).");
      return;
    }
    setBusy("import");
    setError(null);
    try {
      const key = await importKey(clean);
      setKeys((current) => [key, ...(current ?? []).filter((k) => k.fingerprint !== key.fingerprint)]);
      setPanel("none");
      setArmored("");
      feedback(`Clé importée · ${keyLabel(key)}`);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const runExport = async (key: PgpKey) => {
    setError(null);
    try {
      const publicKey = await exportKey(key.fingerprint);
      setExported({ fingerprint: key.fingerprint, armored: publicKey });
      setOpenKey(key.fingerprint);
      setCopied(null);
      feedback(`Clé publique de ${keyLabel(key)} prête`);
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  const runDelete = async (key: PgpKey) => {
    setError(null);
    try {
      await deleteKey(key.fingerprint);
      setKeys((current) => (current ?? []).filter((entry) => entry.fingerprint !== key.fingerprint));
      if (exported?.fingerprint === key.fingerprint) setExported(null);
      setConfirmDelete(null);
      feedback(`Clé supprimée · ${keyLabel(key)}`);
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  const runCopy = async (value: string, tag: string) => {
    try {
      await copy(value);
      setCopied(tag);
      feedback("Copié dans le presse-papiers");
    } catch {
      setError("Le presse-papiers est indisponible sur cet appareil.");
    }
  };

  const list = keys ?? [];
  const secret = list.filter((key) => key.has_secret);
  const contacts = list.filter((key) => !key.has_secret);

  const renderKey = (key: PgpKey, index: number) => {
    const state = keyState(key);
    const open = openKey === key.fingerprint;
    const expired = isExpired(key);
    const pending = confirmDelete === key.fingerprint;
    const armor = exported?.fingerprint === key.fingerprint ? exported.armored : null;

    return (
      <BlurFade key={key.fingerprint} delay={0.12 + index * 0.04} yOffset={10}>
        <Card className={cn("overflow-hidden", expired && "border-amber-500/40 bg-amber-500/[0.04]")}>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => {
              setOpenKey(open ? null : key.fingerprint);
              if (!open) setConfirmDelete(null);
            }}
            className="focus-row flex w-full items-center gap-3 p-3 text-left"
          >
            <Avatar name={keyLabel(key)} size={38} tone={index % 4} />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[12.5px] font-bold text-ink">{keyLabel(key)}</span>
              <span className="mt-0.5 block font-mono text-[10px] font-medium text-ink-muted">
                {shortFingerprint(key.fingerprint)}
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-1">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-bold",
                    STATE_TONE[state],
                  )}
                >
                  {state === "valid" ? <BadgeCheck className="size-3" /> : <AlertTriangle className="size-3" />}
                  {PGP_STATE[state].label}
                </span>
                <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[9.5px] font-bold text-ink-soft">
                  {keyUsage(key)}
                </span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[9.5px] font-bold",
                    expired ? "bg-amber-500/12 text-amber-700 dark:text-amber-300" : "bg-surface-2 text-ink-muted",
                  )}
                >
                  {key.expires_at ? `${expired ? "expirée le" : "expire le"} ${formatKeyDate(key.expires_at)}` : "sans expiration"}
                </span>
              </span>
            </span>
            <ChevronDown
              className={cn("size-4 shrink-0 text-ink-muted transition-transform", open && "rotate-180")}
            />
          </button>

          {open ? (
            <div className="border-t border-line/70 px-3.5 py-3">
              <p className="text-[9.5px] font-bold tracking-[0.14em] text-ink-muted uppercase">Empreinte complète</p>
              <p className="mt-1 font-mono text-[10.5px] leading-relaxed font-semibold break-all text-ink-soft">
                {formatFingerprint(key.fingerprint)}
              </p>
              <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10.5px]">
                <div>
                  <dt className="font-semibold text-ink-muted">Identifiant</dt>
                  <dd className="font-mono font-bold break-all text-ink">{key.key_id}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-ink-muted">Algorithme</dt>
                  <dd className="font-bold text-ink">{key.algorithm}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-ink-muted">Créée le</dt>
                  <dd className="font-bold text-ink">{formatKeyDate(key.created_at)}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-ink-muted">Validité</dt>
                  <dd className="font-bold text-ink">
                    {key.expires_at ? formatKeyDate(key.expires_at) : "sans expiration"}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="font-semibold text-ink-muted">Utilisateur</dt>
                  <dd className="font-bold break-all text-ink">{key.user_id}</dd>
                </div>
              </dl>
              <p className="mt-2.5 text-[10px] leading-relaxed font-medium text-ink-muted">
                {PGP_STATE[state].hint}
              </p>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button type="button" onClick={() => void runCopy(key.fingerprint, key.fingerprint)} className={ACTION}>
                  {copied === key.fingerprint ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied === key.fingerprint ? "Copiée" : "Empreinte"}
                </button>
                <button type="button" onClick={() => void runExport(key)} className={ACTION}>
                  <Download className="size-3.5" />
                  Exporter
                </button>
              </div>

              {armor ? (
                <div className="mt-2">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void runCopy(armor, `armor:${key.fingerprint}`)}
                      className={cn(ACTION, "flex-1")}
                    >
                      {copied === `armor:${key.fingerprint}` ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                      Copier la clé publique
                    </button>
                    <button
                      type="button"
                      onClick={() => downloadKey(armor, key.fingerprint)}
                      className={cn(ACTION, "flex-1")}
                    >
                      <Download className="size-3.5" />
                      Télécharger .asc
                    </button>
                  </div>
                  <p className="mt-1.5 font-mono text-[9.5px] leading-relaxed break-all text-ink-muted">
                    {armor.split("\n")[0]} · {armor.length} octets
                  </p>
                </div>
              ) : null}

              <div className="mt-3 border-t border-line/70 pt-2.5">
                {pending ? (
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 text-[10.5px] leading-snug font-semibold text-ink-soft">
                      Supprimer définitivement cette clé du trousseau ?
                    </p>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(null)}
                      className={cn(ACTION, "min-h-9 px-2.5")}
                    >
                      <X className="size-3.5" />
                      Annuler
                    </button>
                    <button
                      type="button"
                      onClick={() => void runDelete(key)}
                      className="focus-ring flex min-h-9 items-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-2.5 text-[11px] font-bold text-rose-700 dark:text-rose-300"
                    >
                      <Trash2 className="size-3.5" />
                      Supprimer
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(key.fingerprint)}
                    className="focus-ring flex min-h-11 items-center gap-1.5 text-[11px] font-bold text-rose-700 transition-colors hover:text-rose-600 dark:text-rose-300"
                  >
                    <Trash2 className="size-3.5" />
                    Supprimer la clé
                  </button>
                )}
              </div>
            </div>
          ) : null}
        </Card>
      </BlurFade>
    );
  };

  return (
    <div className="relative flex h-full flex-col bg-canvas">
      <MeshGlow className="h-40" />

      <header className="relative z-10 flex items-center gap-1 px-2.5 pt-3 pb-1">
        <IconButton aria-label="Retour" onClick={onClose}>
          <ArrowLeft className="size-4.5" />
        </IconButton>
        <h1 className="ml-1 text-[15px] font-bold tracking-tight text-ink">Chiffrement PGP</h1>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-1 text-[10px] font-bold text-ink-soft">
          <KeyRound className="size-3" />
          {keys === null ? "…" : `${list.length} clés`}
        </span>
        <IconButton aria-label="Recharger les clés" onClick={() => void load()} disabled={busy === "refresh"}>
          <RefreshCw className={cn("size-4.5", busy === "refresh" && "animate-spin")} />
        </IconButton>
      </header>

      <div className="relative flex-1 overflow-y-auto no-scrollbar pb-8">
        {error ? (
          <BlurFade delay={0.03}>
            <Card className="mx-4 mt-3 border-amber-500/40 bg-amber-500/[0.06] px-3.5 py-2.5">
              <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed font-semibold text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-px size-3.5 shrink-0" />
                {error}
              </p>
            </Card>
          </BlurFade>
        ) : null}

        <SectionTitle hint={keys === null ? "chargement" : `${secret.length} secrètes · ${contacts.length} publiques`}>
          Trousseau
        </SectionTitle>

        <div className="mx-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setPanel(panel === "generate" ? "none" : "generate")}
            aria-expanded={panel === "generate"}
            className={ACTION}
          >
            <Plus className="size-3.5" />
            Générer une clé
          </button>
          <button
            type="button"
            onClick={() => setPanel(panel === "import" ? "none" : "import")}
            aria-expanded={panel === "import"}
            className={ACTION}
          >
            <Upload className="size-3.5" />
            Importer
          </button>
        </div>

        {panel === "generate" ? (
          <BlurFade delay={0.05}>
            <Card className="mx-4 mt-2 px-3.5 py-3">
              <p className="flex items-center gap-1.5 text-[11px] font-bold text-ink">
                <KeyRound className="size-3.5 text-accent-ink" />
                Nouvelle paire de clés
              </p>
              <div className="mt-2.5 grid gap-2.5">
                <div>
                  <label className={LABEL} htmlFor="pgp-name">
                    Nom
                  </label>
                  <input
                    id="pgp-name"
                    className={cn(FIELD, "mt-1.5 text-[12.5px]")}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Roman"
                    autoComplete="name"
                  />
                </div>
                <div>
                  <label className={LABEL} htmlFor="pgp-email">
                    E-mail
                  </label>
                  <input
                    id="pgp-email"
                    type="email"
                    className={cn(FIELD, "mt-1.5 text-[12.5px]")}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="roman@lavande.mail"
                    autoComplete="email"
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={() => void runGenerate()}
                disabled={busy === "generate"}
                className="focus-ring mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent text-[12px] font-bold text-accent-contrast disabled:opacity-60"
              >
                {busy === "generate" ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
                {busy === "generate" ? "Génération en cours…" : "Générer"}
              </button>
              <p className="mt-1.5 text-[10px] leading-relaxed font-medium text-ink-muted">
                La clé privée est créée par le démon et conservée dans le trousseau du système.
              </p>
            </Card>
          </BlurFade>
        ) : null}

        {panel === "import" ? (
          <BlurFade delay={0.05}>
            <Card className="mx-4 mt-2 px-3.5 py-3">
              <label className="flex items-center gap-1.5 text-[11px] font-bold text-ink" htmlFor="pgp-armored">
                <Upload className="size-3.5 text-accent-ink" />
                Clé publique à importer
              </label>
              <textarea
                id="pgp-armored"
                value={armored}
                onChange={(event) => setArmored(event.target.value)}
                rows={6}
                spellCheck={false}
                placeholder={"-----BEGIN PGP PUBLIC KEY BLOCK-----\n…"}
                className="focus-ring mt-2 w-full resize-y rounded-xl border border-line bg-surface p-2.5 font-mono text-[10.5px] leading-relaxed text-ink-soft placeholder:text-ink-muted"
              />
              <button
                type="button"
                onClick={() => void runImport()}
                disabled={busy === "import"}
                className="focus-ring mt-2.5 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent text-[12px] font-bold text-accent-contrast disabled:opacity-60"
              >
                {busy === "import" ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                {busy === "import" ? "Import en cours…" : "Importer la clé"}
              </button>
            </Card>
          </BlurFade>
        ) : null}

        <div className="mx-4 mt-2 space-y-2">
          {keys === null ? (
            <Card className="flex items-center justify-center gap-2 px-3 py-6">
              <Loader2 className="size-4 animate-spin text-ink-muted" />
              <p className="text-[11.5px] font-semibold text-ink-muted">Lecture du trousseau…</p>
            </Card>
          ) : list.length === 0 ? (
            <Card className="px-3.5 py-5 text-center">
              <KeyRound className="mx-auto size-5 text-ink-muted" />
              <p className="mt-2 text-[12px] font-bold text-ink">Aucune clé dans le trousseau</p>
              <p className="mt-1 text-[10.5px] leading-relaxed font-medium text-ink-muted">
                Génère ta propre paire pour signer et déchiffrer, puis importe les clés publiques de tes
                destinataires.
              </p>
            </Card>
          ) : (
            list.map((key, index) => renderKey(key, index))
          )}
        </div>

        <SectionTitle>Par défaut</SectionTitle>
        <BlurFade delay={0.1}>
          <Card className="mx-4 divide-y divide-line/80 overflow-hidden">
            <ToggleRow
              icon={<Lock className="size-4" />}
              label="Chiffrer les messages"
              hint="Quand une clé valide et utilisable existe pour chaque destinataire"
              checked={pgpEncrypt}
              onChange={setPgpEncrypt}
            />
            <ToggleRow
              icon={<PenLine className="size-4" />}
              label="Signer mes messages"
              hint="Signature détachée, vérifiable"
              checked={pgpSign}
              onChange={setPgpSign}
            />
            <ToggleRow
              icon={<ShieldCheck className="size-4" />}
              label="Joindre ma clé publique"
              hint="Aux nouveaux destinataires"
              checked={attachPublicKey}
              onChange={setAttachPublicKey}
            />
          </Card>
        </BlurFade>

        <p className="mx-6 mt-5 text-center text-[10.5px] leading-relaxed font-medium text-ink-muted">
          Les clés privées restent dans le trousseau du système (Keychain / Keystore Android), jamais dans
          la base mail.
        </p>
      </div>
    </div>
  );
}
