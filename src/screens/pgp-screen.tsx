import { useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Copy,
  Download,
  KeyRound,
  Lock,
  PenLine,
  Plus,
  RefreshCw,
} from "lucide-react";
import { CONTACT_KEYS, MY_KEY } from "@/lib/pgp";
import { cn } from "@/lib/utils";
import { Avatar, Card, IconButton, SectionTitle, Switch } from "@/components/ui/primitives";
import { BlurFade } from "@/components/ui/blur-fade";
import { MeshGlow } from "@/components/ui/backdrops";

const TRUST_LABEL = { ultimate: "ultime", full: "complet", marginal: "marginal" } as const;

export function PgpScreen({ onClose }: { onClose: () => void }) {
  const [encryptByDefault, setEncryptByDefault] = useState(true);
  const [signByDefault, setSignByDefault] = useState(true);
  const [attachKey, setAttachKey] = useState(false);

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
                  expire {MY_KEY.expires}
                </span>
                <span className="rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                  confiance {TRUST_LABEL[MY_KEY.trust]}
                </span>
              </div>

              <div className="mt-3.5 flex gap-2">
                <button
                  type="button"
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-line bg-surface py-2 text-[11.5px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
                >
                  <Copy className="size-3.5" />
                  Copier
                </button>
                <button
                  type="button"
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-line bg-surface py-2 text-[11.5px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
                >
                  <Download className="size-3.5" />
                  Exporter
                </button>
              </div>
            </div>
          </Card>
        </BlurFade>

        <SectionTitle>Par défaut</SectionTitle>
        <BlurFade delay={0.1}>
          <Card className="mx-4 divide-y divide-line/80">
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="grid size-8 place-items-center rounded-xl bg-surface-2 text-ink-soft">
                <Lock className="size-4" />
              </span>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="text-[12.5px] font-bold text-ink">Chiffrer les messages</p>
                <p className="text-[10.5px] font-medium text-ink-muted">Quand une clé du destinataire existe</p>
              </div>
              <Switch checked={encryptByDefault} onChange={setEncryptByDefault} label="Chiffrer" />
            </div>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="grid size-8 place-items-center rounded-xl bg-surface-2 text-ink-soft">
                <PenLine className="size-4" />
              </span>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="text-[12.5px] font-bold text-ink">Signer mes messages</p>
                <p className="text-[10.5px] font-medium text-ink-muted">Signature détachée, vérifiable</p>
              </div>
              <Switch checked={signByDefault} onChange={setSignByDefault} label="Signer" />
            </div>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="grid size-8 place-items-center rounded-xl bg-surface-2 text-ink-soft">
                <KeyRound className="size-4" />
              </span>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="text-[12.5px] font-bold text-ink">Joindre ma clé publique</p>
                <p className="text-[10.5px] font-medium text-ink-muted">Aux nouveaux destinataires</p>
              </div>
              <Switch checked={attachKey} onChange={setAttachKey} label="Joindre la clé" />
            </div>
          </Card>
        </BlurFade>

        <SectionTitle hint={`${CONTACT_KEYS.length} clés`}>Destinataires</SectionTitle>
        <div className="mx-4 space-y-2">
          {CONTACT_KEYS.map((key, index) => {
            const expired = key.expires.endsWith("2026") && !key.verified;
            return (
              <BlurFade key={key.id} delay={0.15 + index * 0.05} yOffset={10}>
                <Card
                  className={cn(
                    "flex items-center gap-3 p-3",
                    expired && "border-amber-500/40 bg-amber-500/[0.04]",
                  )}
                >
                  <Avatar name={key.name} size={38} tone={index + 1} />
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="truncate text-[12.5px] font-bold text-ink">{key.name}</p>
                    <p className="truncate font-mono text-[10px] font-medium text-ink-muted">
                      {key.fingerprint.slice(0, 24)}…
                    </p>
                    <p className="mt-0.5 flex items-center gap-1 text-[10px] font-semibold text-ink-muted">
                      {key.verified ? (
                        <>
                          <BadgeCheck className="size-3 text-emerald-600 dark:text-emerald-400" />
                          vérifiée · {TRUST_LABEL[key.trust]}
                        </>
                      ) : (
                        <>
                          <AlertTriangle className="size-3 text-amber-600 dark:text-amber-400" />
                          non vérifiée · expire {key.expires}
                        </>
                      )}
                    </p>
                  </div>
                  {expired ? (
                    <IconButton aria-label="Demander une mise à jour" className="bg-amber-500/10 text-amber-700 dark:text-amber-300">
                      <RefreshCw className="size-4" />
                    </IconButton>
                  ) : null}
                </Card>
              </BlurFade>
            );
          })}

          <button
            type="button"
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line py-3 text-[12px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
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
