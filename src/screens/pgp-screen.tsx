import { useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Check,
  ChevronDown,
  Copy,
  Download,
  KeyRound,
  Lock,
  PenLine,
  Plus,
  RefreshCw,
} from "lucide-react";
import { CONTACT_KEYS, MY_KEY, PGP_STATE, isExpired, keyState } from "@/lib/pgp";
import { usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { Avatar, Card, IconButton, SectionTitle, ToggleRow } from "@/components/ui/primitives";
import { BlurFade } from "@/components/ui/blur-fade";
import { MeshGlow } from "@/components/ui/backdrops";

const TRUST_LABEL = { ultimate: "ultime", full: "complète", marginal: "marginale" } as const;

export function PgpScreen({ onClose }: { onClose: () => void }) {
  const {
    pgpEncrypt,
    pgpSign,
    attachPublicKey,
    setPgpEncrypt,
    setPgpSign,
    setAttachPublicKey,
  } = usePrefs();
  const [copied, setCopied] = useState(false);
  const [exported, setExported] = useState(false);
  const [requestedKey, setRequestedKey] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const myState = keyState(MY_KEY);

  const copyFingerprint = async () => {
    try {
      await navigator.clipboard.writeText(MY_KEY.fingerprint);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="relative flex h-full flex-col bg-canvas">
      <MeshGlow className="h-40" />

      <header className="relative z-10 flex items-center gap-1 px-2.5 pt-3 pb-1">
        <IconButton aria-label="Retour" onClick={onClose}>
          <ArrowLeft className="size-4.5" />
        </IconButton>
        <h1 className="ml-1 text-[15px] font-bold tracking-tight text-ink">Chiffrement PGP</h1>
        <span className="ml-auto mr-2 inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-1 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
          <BadgeCheck className="size-3" />
          actif
        </span>
      </header>

      <div className="relative flex-1 overflow-y-auto no-scrollbar pb-8">
        <BlurFade delay={0.04}>
          <Card className="mx-4 mt-3 overflow-hidden p-0">
            <div className="flex items-center gap-2 border-b border-line/70 bg-accent-soft px-4 py-2.5">
              <KeyRound className="size-3.5 text-accent-ink" />
              <p className="text-[10.5px] font-bold tracking-[0.14em] text-accent-ink uppercase">Ma clé</p>
              <span className="ml-auto rounded-full bg-surface px-2 py-0.5 text-[9.5px] font-bold text-accent-ink">
                secrète
              </span>
            </div>

            <div className="px-4 py-3.5">
              <p className="text-[13.5px] font-bold text-ink">
                {MY_KEY.name} <span className="font-medium text-ink-soft">{"<" + MY_KEY.email + ">"}</span>
              </p>
              <p className="mt-2 font-mono text-[10.5px] leading-relaxed font-semibold break-all text-ink-soft">
                {MY_KEY.fingerprint}
              </p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-bold text-ink-soft">
                  {MY_KEY.algorithm}
                </span>
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-bold text-ink-soft">
                  expire le {MY_KEY.expires}
                </span>
                <span className="rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                  empreinte vérifiée
                </span>
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-bold text-ink-soft">
                  confiance {TRUST_LABEL[MY_KEY.trust]}
                </span>
              </div>

              <div className="mt-3.5 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={copyFingerprint}
                  className="focus-ring flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[11.5px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied ? "Empreinte copiée" : "Copier l'empreinte"}
                </button>
                <button
                  type="button"
                  onClick={() => setExported(true)}
                  className="focus-ring flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[11.5px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
                >
                  {exported ? <Check className="size-3.5" /> : <Download className="size-3.5" />}
                  {exported ? "Export délégué au trousseau" : "Exporter la clé publique"}
                </button>
              </div>

              {copied ? (
                <p className="mt-2 text-[10px] leading-relaxed font-medium text-ink-soft">
                  Empreinte copiée. {PGP_STATE[myState].hint}
                  {myState === "valid" ? ` Valide jusqu'au ${MY_KEY.expires}.` : ""}
                </p>
              ) : null}
              {exported ? (
                <p className="mt-2 text-[10px] leading-relaxed font-medium text-ink-soft">
                  Maquette : le trousseau système prendra en charge l'export public et produira le
                  bloc ASCII armor de la clé.
                </p>
              ) : null}
            </div>
          </Card>
        </BlurFade>

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
              icon={<KeyRound className="size-4" />}
              label="Joindre ma clé publique"
              hint="Aux nouveaux destinataires"
              checked={attachPublicKey}
              onChange={setAttachPublicKey}
            />
          </Card>
        </BlurFade>

        <SectionTitle hint={`${CONTACT_KEYS.length} clés`}>Destinataires</SectionTitle>
        <div className="mx-4 space-y-2">
          {CONTACT_KEYS.map((key, index) => {
            const expired = isExpired(key);
            const state = keyState(key);
            const open = openKey === key.id;
            return (
              <BlurFade key={key.id} delay={0.15 + index * 0.05} yOffset={10}>
                <Card
                  className={cn(
                    "overflow-hidden",
                    expired && "border-amber-500/40 bg-amber-500/[0.04]",
                  )}
                >
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpenKey(open ? null : key.id)}
                    className="focus-row flex w-full items-center gap-3 p-3 text-left"
                  >
                    <Avatar name={key.name} size={38} tone={key.tone ?? 0} />
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block text-[12.5px] font-bold text-ink">{key.name}</span>
                      <span className="mt-0.5 block font-mono text-[10px] font-medium text-ink-muted">
                        {key.fingerprint.slice(0, 24)}…
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-1">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-bold",
                            key.verified
                              ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                              : "bg-amber-500/12 text-amber-700 dark:text-amber-300",
                          )}
                        >
                          {key.verified ? (
                            <BadgeCheck className="size-3" />
                          ) : (
                            <AlertTriangle className="size-3" />
                          )}
                          {key.verified ? "empreinte vérifiée" : "empreinte non vérifiée"}
                        </span>
                        <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[9.5px] font-bold text-ink-soft">
                          confiance {TRUST_LABEL[key.trust]}
                        </span>
                        <span
                          className={cn(
                            "rounded-full px-1.5 py-0.5 text-[9.5px] font-bold",
                            expired
                              ? "bg-amber-500/12 text-amber-700 dark:text-amber-300"
                              : "bg-surface-2 text-ink-muted",
                          )}
                        >
                          {expired ? `expirée le ${key.expires}` : `expire le ${key.expires}`}
                        </span>
                      </span>
                    </span>
                    <ChevronDown
                      className={cn(
                        "size-4 shrink-0 text-ink-muted transition-transform",
                        open && "rotate-180",
                      )}
                    />
                  </button>

                  {open ? (
                    <div className="border-t border-line/70 px-3.5 py-3">
                      <p className="text-[9.5px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                        Empreinte complète
                      </p>
                      <p className="mt-1 font-mono text-[10.5px] leading-relaxed font-semibold break-all text-ink-soft">
                        {key.fingerprint}
                      </p>
                      <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10.5px]">
                        <div>
                          <dt className="font-semibold text-ink-muted">Algorithme</dt>
                          <dd className="font-bold text-ink">{key.algorithm}</dd>
                        </div>
                        <div>
                          <dt className="font-semibold text-ink-muted">Créée le</dt>
                          <dd className="font-bold text-ink">{key.created}</dd>
                        </div>
                        <div>
                          <dt className="font-semibold text-ink-muted">Validité</dt>
                          <dd className="font-bold text-ink">
                            {expired ? `expirée le ${key.expires}` : `expire le ${key.expires}`}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-semibold text-ink-muted">Confiance</dt>
                          <dd className="font-bold text-ink">{TRUST_LABEL[key.trust]}</dd>
                        </div>
                        {key.email ? (
                          <div className="col-span-2">
                            <dt className="font-semibold text-ink-muted">E-mail</dt>
                            <dd className="font-bold break-all text-ink">{key.email}</dd>
                          </div>
                        ) : null}
                      </dl>
                      <p className="mt-2.5 text-[10px] leading-relaxed font-medium text-ink-muted">
                        {PGP_STATE[state].hint}
                      </p>
                      {expired ? (
                        <div className="mt-2.5">
                          <button
                            type="button"
                            onClick={() => setRequestedKey(key.id)}
                            className="focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 text-[11px] font-bold text-amber-700 transition-colors dark:text-amber-300"
                          >
                            {requestedKey === key.id ? (
                              <Check className="size-3.5" />
                            ) : (
                              <RefreshCw className="size-3.5" />
                            )}
                            {requestedKey === key.id
                              ? "Demande préparée"
                              : "Demander une mise à jour"}
                          </button>
                          {requestedKey === key.id ? (
                            <p className="mt-1.5 text-[10px] leading-relaxed font-medium text-ink-muted">
                              Préparation dans la maquette : rien n'est envoyé au destinataire.
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </Card>
              </BlurFade>
            );
          })}

          <button
            type="button"
            className="focus-ring flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line py-3 text-[12px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
          >
            <Plus className="size-4" />
            Importer une clé publique
          </button>
        </div>

        <p className="mx-6 mt-5 text-center text-[10.5px] leading-relaxed font-medium text-ink-muted">
          Les clés privées restent dans le trousseau du système (Keychain / Keystore Android),
          jamais dans la base mail.
        </p>
      </div>
    </div>
  );
}
