import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

const ARM_WINDOW_MS = 5000;

const SHAPES = {
  mobile: "rounded-2xl py-2.5 text-[12.5px]",
  desktop: "h-8 rounded-[11px] px-2 text-[11.5px]",
} as const;

export function EmptyTrashButton({
  count,
  onConfirm,
  variant = "mobile",
}: {
  count: number;
  onConfirm: () => void;
  variant?: "mobile" | "desktop";
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), ARM_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  if (count === 0) return null;

  const label = `Confirmer · ${count} message${count > 1 ? "s" : ""}`;

  return (
    <button
      type="button"
      aria-label={
        armed ? `Supprimer définitivement ${count} message${count > 1 ? "s" : ""} de la corbeille` : "Vider la corbeille"
      }
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      className={cn(
        "focus-ring flex w-full items-center justify-center gap-2 border font-bold transition-colors",
        SHAPES[variant],
        armed
          ? "border-rose-400/70 bg-rose-500/10 text-rose-700 dark:text-rose-300"
          : "border-line bg-surface-2 text-ink-soft hover:border-accent-ring hover:text-accent-ink",
      )}
    >
      <Trash2 className="size-3.5 shrink-0" />
      {armed ? label : "Vider la corbeille"}
    </button>
  );
}
