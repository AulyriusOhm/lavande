import { useEffect, useState } from "react";
import { Eye, EyeOff, Trash2, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const ARM_WINDOW_MS = 5000;

const SHAPES = {
  desktop: "h-9 rounded-[11px] px-2 text-[11.5px]",
  mobile: "rounded-2xl px-3 py-2.5 text-[12.5px]",
} as const;

/**
 * Enveloppe une ligne de dossier personnalisé : chaque action n'apparaît que si
 * elle est permise, et la suppression demande confirmation avec le nom écrit.
 */
export function FolderRow({
  label,
  onDelete,
  onHide,
  onUnhide,
  variant = "desktop",
  children,
}: {
  label: string;
  onDelete?: () => void;
  onHide?: () => void;
  onUnhide?: () => void;
  variant?: "desktop" | "mobile";
  children: React.ReactNode;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), ARM_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  if (armed && onDelete) {
    return (
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`Confirmer la suppression du dossier ${label}`}
          onClick={() => {
            setArmed(false);
            onDelete();
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
      {onUnhide && (
        <RowAction
          icon={Eye}
          label={`Réafficher le dossier ${label}`}
          onClick={onUnhide}
          variant={variant}
        />
      )}
      {onHide && (
        <RowAction
          icon={EyeOff}
          label={`Masquer le dossier ${label}`}
          onClick={onHide}
          variant={variant}
        />
      )}
      {onDelete && (
        <RowAction
          icon={Trash2}
          label={`Supprimer le dossier ${label}`}
          onClick={() => setArmed(true)}
          variant={variant}
          danger
        />
      )}
    </div>
  );
}

function RowAction({
  icon: Icon,
  label,
  onClick,
  variant,
  danger = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  variant: "desktop" | "mobile";
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "focus-ring grid shrink-0 place-items-center rounded-[11px] text-ink-muted transition-colors",
        danger
          ? "hover:bg-rose-500/10 hover:text-rose-700 dark:hover:text-rose-300"
          : "hover:bg-surface-2 hover:text-ink",
        variant === "desktop" ? "size-7" : "size-9",
      )}
    >
      <Icon className="size-3.5" />
    </button>
  );
}

/**
 * Dossiers masqués : un lien discret compte les dossiers retirés de la liste et
 * les révèle en lecture, le masquage se règle dans les réglages.
 */
export function HiddenFoldersRail({
  count,
  variant = "desktop",
  children,
}: {
  count: number;
  variant?: "desktop" | "mobile";
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  if (count === 0) return null;

  return (
    <div className={variant === "desktop" ? "pt-0.5" : undefined}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "focus-ring flex w-full items-center gap-2 font-bold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink",
          variant === "desktop"
            ? "h-7 rounded-[11px] px-2.5 text-[11px]"
            : "rounded-2xl px-3 py-1.5 text-[11.5px]",
        )}
      >
        <EyeOff className="size-3.5 shrink-0" />
        <span className="truncate">
          {count} masqué
          {count > 1 ? "s" : ""}
        </span>
        <span className="ml-auto text-accent-ink">{open ? "Replier" : "Afficher"}</span>
      </button>
      {open ? children : null}
    </div>
  );
}
