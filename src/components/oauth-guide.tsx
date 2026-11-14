import { useState } from "react";
import { ExternalLink, KeyRound } from "lucide-react";
import { openExternal } from "@/lib/open-external";

const AZURE = "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade";
const GOOGLE = "https://console.cloud.google.com/apis/credentials";

const STEP = "flex gap-2 text-[11px] leading-relaxed font-medium text-ink-muted";
const NUMBER =
  "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-accent-soft text-[9.5px] font-black text-accent-ink";

export function OAuthGuide({ redirectUri }: { redirectUri: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard?.writeText(redirectUri).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => setCopied(false),
    );
  };

  return (
    <details className="mt-2 rounded-xl border border-line bg-surface px-3 py-2">
      <summary className="flex cursor-pointer items-center gap-1.5 text-[11.5px] font-bold text-accent-ink">
        <KeyRound className="size-3.5" strokeWidth={2.6} />
        Comment obtenir ces identifiants ?
      </summary>

      <div className="mt-2.5 space-y-2 border-t border-line pt-2.5">
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 rounded-lg bg-surface-2 px-2 py-1 font-mono text-[11px] leading-snug break-all text-ink-soft">
            {redirectUri}
          </code>
          <button
            type="button"
            onClick={copy}
            className="focus-ring inline-flex min-h-11 shrink-0 items-center rounded-full border border-line px-3 text-[11.5px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
          >
            {copied ? "Copié" : "Copier"}
          </button>
        </div>
        <p className="text-[10.5px] leading-relaxed font-medium text-ink-muted">
          C'est l'adresse de retour à déclarer chez le fournisseur ; elle doit être identique, au
          caractère près.
        </p>

        <p className="pt-1 text-[10.5px] font-bold tracking-[0.12em] text-ink-muted uppercase">
          Microsoft (compte personnel ou pro)
        </p>
        <div className="space-y-1.5">
          <p className={STEP}>
            <span className={NUMBER}>1</span>
            <span>
              Portail Azure → <strong>App registrations</strong> → <strong>New registration</strong>,
              type de compte « annuaires organisationnels + comptes Microsoft personnels ».
            </span>
          </p>
          <p className={STEP}>
            <span className={NUMBER}>2</span>
            <span>
              Plateforme <strong>« Mobile and desktop applications »</strong>, redirection — l'adresse
              copiée ci-dessus.
            </span>
          </p>
          <p className={STEP}>
            <span className={NUMBER}>3</span>
            <span>
              Authentication → <strong>Allow public client flows</strong> = Oui (aucun secret n'est
              nécessaire).
            </span>
          </p>
          <p className={STEP}>
            <span className={NUMBER}>4</span>
            <span>
              API permissions → Office 365 Exchange Online → <strong>IMAP.AccessAsUser.All</strong> et{" "}
              <strong>SMTP.Send</strong>, puis copie l'<strong>Application (client) ID</strong>.
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => openExternal(AZURE)}
          className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[10.5px] font-bold text-ink transition-colors hover:border-accent-ring"
        >
          <ExternalLink className="size-3" strokeWidth={2.6} />
          Ouvrir le portail Azure
        </button>

        <p className="pt-1 text-[10.5px] font-bold tracking-[0.12em] text-ink-muted uppercase">Google</p>
        <div className="space-y-1.5">
          <p className={STEP}>
            <span className={NUMBER}>1</span>
            <span>
              Google Cloud Console → <strong>APIs & Services</strong> → <strong>Credentials</strong> →
              créer un <strong>ID client OAuth</strong> de type « Desktop app ».
            </span>
          </p>
          <p className={STEP}>
            <span className={NUMBER}>2</span>
            <span>
              La redirection loopback ci-dessus est acceptée d'office par ce type de client ; copie
              l'identifiant client <strong>et le secret du client</strong>.
            </span>
          </p>
          <p className={STEP}>
            <span className={NUMBER}>3</span>
            <span>
              Configure l'<strong>écran de consentement OAuth</strong> (mode test, avec ton compte en
              testeur), sinon Google refuse la connexion. Les comptes Gmail demandent aussi l'accès
              IMAP activé côté compte.
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => openExternal(GOOGLE)}
          className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[10.5px] font-bold text-ink transition-colors hover:border-accent-ring"
        >
          <ExternalLink className="size-3" strokeWidth={2.6} />
          Ouvrir la console Google
        </button>
      </div>
    </details>
  );
}
