import { ImageOff, X } from "lucide-react";
import { usePrefs } from "@/lib/prefs";

export function ImagesAllowedSection({ readOnly = false }: { readOnly?: boolean }) {
  const { imagesAllowedSenders, setImagesAllowedSenders } = usePrefs();

  const remove = (sender: string) => {
    setImagesAllowedSenders(imagesAllowedSenders.filter((item) => item !== sender));
  };

  return (
    <div className="space-y-2 border-t border-line/70 pt-3">
      <div className="flex items-center gap-1.5">
        <ImageOff className="size-3.5 text-accent-ink" strokeWidth={2.2} />
        <span className="text-[10.5px] font-bold tracking-[0.14em] text-ink-muted uppercase">
          Images autorisées par expéditeur
        </span>
      </div>
      <p className="text-[11px] font-medium text-ink-muted">
        Liste locale à cet appareil · ces expéditeurs n'affichent plus le bandeau d'images masquées.
      </p>
      {imagesAllowedSenders.length === 0 ? (
        <p className="text-[11px] font-medium text-ink-muted">
          Aucun expéditeur autorisé · les images distantes restent masquées, message par message.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {imagesAllowedSenders.map((sender) => (
            <span
              key={sender}
              className="inline-flex items-center gap-1 rounded-full border border-accent-ring/50 bg-accent-soft px-2.5 py-0.5 text-[11px] font-bold text-accent-ink"
            >
              <span>{sender}</span>
              {readOnly ? null : (
                <button
                  type="button"
                  aria-label={`Retirer ${sender}`}
                  onClick={() => remove(sender)}
                  className="focus-ring grid size-4 place-items-center rounded-full hover:bg-surface/60"
                >
                  <X className="size-3" strokeWidth={2.5} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
