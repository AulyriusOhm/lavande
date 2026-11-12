import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";

const ARM_WINDOW_MS = 5000;

const SHAPES = {
  desktop: "h-9 rounded-[11px] px-2 text-[11.5px]",
  mobile: "rounded-2xl px-3 py-2.5 text-[12.5px]",
} as const;

/**
 * Enveloppe une ligne de dossier personnalisé : la corbeille n'apparaît qu'à
 * côté d'un dossier supprimable, et le nom du dossier est écrit avant l'appel.
 */
export function FolderDeleteRow({
  label,
  onConfirm,
  variant = "desktop",
  children,
}: {
  label: string;
  onConfirm: () => void;
  variant?: "desktop" | "mobile";
  children: React.ReactNode;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), ARM_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  if (armed) {
    return (
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`Confirmer la suppression du dossier ${label}`}
          onClick={() => {
            setArmed(false);
            onConfirm();
          }}
          className={cn(
            "focus-ring flex flex-1 items-center justify-center gap-2 border border-rose-400/70 bg-rose-500/10 font-bold text-rose-700 transition-colors hover:bg-rose-500/15 dark:text-rose-300",
            SHAPES[variant],
          )}
        >
          <Trash2 className="size-3.5 shrink-0" />
          <span className="truncate">Supprimer « {label} »</span>
        </button>
        <button
          type="button"
          aria-label="Annuler la suppression du dossier"
          onClick={() => setArmed(false)}
          className={cn(
            "focus-ring grid shrink-0 place-items-center border border-line bg-surface-2 text-ink-soft transition-colors hover:text-ink",
            variant === "desktop" ? "size-9 rounded-[11px]" : "size-11 rounded-2xl",
          )}
        >
          <X className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1">{children}</div>
      <button
        type="button"
        aria-label={`Supprimer le dossier ${label}`}
        title={`Supprimer le dossier ${label}`}
        onClick={() => setArmed(true)}
        className={cn(
          "focus-ring grid shrink-0 place-items-center rounded-[11px] text-ink-muted transition-colors hover:bg-rose-500/10 hover:text-rose-700 dark:hover:text-rose-300",
          variant === "desktop" ? "size-7" : "size-9",
        )}
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}
