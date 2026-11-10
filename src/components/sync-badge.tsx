import { usePlanning } from "@/lib/planning-store";
import type { SyncPhase } from "@/lib/sync/engine";
import { cn } from "@/lib/utils";

const TONE: Record<SyncPhase, { dot: string; ring: string; surface: string; ink: string; label: string }> = {
  unconfigured: {
    dot: "bg-line",
    ring: "ring-line/60",
    surface: "bg-surface",
    ink: "text-ink-muted",
    label: "Locale",
  },
  offline: {
    dot: "bg-[#f5a623]",
    ring: "ring-[#f5a623]/25",
    surface: "bg-[#fff5e6]",
    ink: "text-[#8a5a13]",
    label: "Hors ligne",
  },
  syncing: {
    dot: "bg-accent",
    ring: "ring-accent/25",
    surface: "bg-accent-soft",
    ink: "text-accent-ink",
    label: "Synchro…",
  },
  synced: {
    dot: "bg-[#34c48b]",
    ring: "ring-[#34c48b]/25",
    surface: "bg-[#eefaf3]",
    ink: "text-[#1f7d58]",
    label: "À jour",
  },
  error: {
    dot: "bg-[#d1466b]",
    ring: "ring-[#d1466b]/25",
    surface: "bg-[#fdeef2]",
    ink: "text-[#a52a4d]",
    label: "Erreur",
  },
  read_only: {
    dot: "bg-[#d1466b]",
    ring: "ring-[#d1466b]/25",
    surface: "bg-[#fdeef2]",
    ink: "text-[#a52a4d]",
    label: "Lecture seule",
  },
};

export function syncBadgeLabel(phase: SyncPhase, pending: number): string {
  const tone = TONE[phase];
  if (pending > 0 && phase !== "read_only") {
    return `${pending} en attente`;
  }
  return tone.label;
}

export function SyncBadge({ onOpen, className }: { onOpen?: () => void; className?: string }) {
  const { sync } = usePlanning();
  const tone = TONE[sync.phase];
  const text = syncBadgeLabel(sync.phase, sync.pending);
  const interactive = onOpen !== undefined;

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!interactive}
      title={
        sync.lastSyncAt === undefined
          ? "Planification synchronisée — jamais synchronisée"
          : `Planification synchronisée — ${new Date(sync.lastSyncAt).toLocaleString("fr-FR")}`
      }
      aria-label={`Synchronisation : ${text}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[10.5px] font-bold ring-1 transition-transform",
        tone.surface,
        tone.ring,
        tone.ink,
        interactive && "active:scale-95",
        !interactive && "cursor-default",
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", tone.dot)} />
      {text}
    </button>
  );
}
