import { useState } from "react";
import { ImageOff, Loader2 } from "lucide-react";
import { errorText } from "@/lib/api";
import type { MailSource } from "@/lib/mail";
import { htmlImagesOf } from "@/lib/mail-backend";
import { cn } from "@/lib/utils";

type Reveal = { key: string; html?: string; error?: string; busy?: boolean };

/**
 * Corps du message : le HTML est **déjà assaini côté service** (liste blanche
 * stricte, images de tracking retirées, liens `noopener`), on ne fait donc que
 * le rendre. Sans HTML, on retombe sur les paragraphes texte.
 *
 * Les images distantes restent masquées par défaut : le bandeau ne fait que
 * demander au service de relire ce message-ci, jamais d'office, et le markup qui
 * revient est assaini à nouveau là-bas.
 */
export function MailBody({
  html,
  paragraphs,
  source,
  className,
}: {
  html?: string;
  paragraphs: string[];
  source?: MailSource;
  className?: string;
}) {
  const [reveal, setReveal] = useState<Reveal | null>(null);

  const key = source ? `${source.accountId}:${source.folderPath}:${source.uid}` : undefined;
  const current = key && reveal?.key === key ? reveal : null;
  const body = current?.html ?? html;

  const showImages = async () => {
    if (!source || !key || current?.busy) return;
    setReveal({ key, busy: true });
    try {
      setReveal({ key, html: await htmlImagesOf(source) });
    } catch (error) {
      setReveal({ key, error: errorText(error) });
    }
  };

  if (!body) {
    return (
      <div className={cn("space-y-3.5", className)}>
        {paragraphs.map((paragraph, index) => (
          <p key={index} className="whitespace-pre-line">
            {paragraph}
          </p>
        ))}
      </div>
    );
  }

  const banner = Boolean(html) && Boolean(key) && !current?.html;

  return (
    <div className={className}>
      {banner && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <ImageOff className="size-3.5 shrink-0 text-ink-muted" aria-hidden />
          <span role="status" aria-live="polite" className="text-[10.5px] font-semibold text-ink-muted">
            {current?.error ? `Images non affichées · ${current.error}` : "Images masquées"}
          </span>
          {!current?.error && <span className="text-[10.5px] text-ink-muted/60">·</span>}
          <button
            type="button"
            disabled={current?.busy}
            onClick={() => void showImages()}
            aria-label="Afficher les images de ce message"
            className="focus-ring inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] font-bold text-accent-ink transition-colors hover:bg-accent-soft disabled:opacity-60"
          >
            {current?.busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
            {current?.busy ? "Chargement…" : current?.error ? "Réessayer" : "Afficher"}
          </button>
        </div>
      )}

      <div
        className="mail-html text-[13.5px] leading-[1.7] font-medium text-ink-soft"
        // HTML assaini par le service (aucun script, images masquées ou relues
        // et ré-assainies à la demande, liens sûrs).
        dangerouslySetInnerHTML={{ __html: body }}
      />
    </div>
  );
}
