import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEscapeLayer } from "@/desktop/escape";

const MARGIN = 8;

export type MenuAction = {
  label: string;
  icon: LucideIcon;
  run: () => void;
  danger?: boolean;
};

export function MenuItem({
  action,
  compact,
  onSelect,
}: {
  action: MenuAction;
  compact: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        action.run();
        onSelect?.();
      }}
      className={cn(
        "focus-ring flex w-full items-center gap-2.5 rounded-[12px] px-2.5 text-left font-semibold transition-colors hover:bg-surface-2",
        compact ? "min-h-9 text-[12.5px]" : "min-h-11 text-[13px]",
        action.danger ? "text-red-600 dark:text-red-300" : "text-ink-soft hover:text-ink",
      )}
    >
      <action.icon className="size-4 shrink-0" strokeWidth={2.2} />
      <span className="truncate">{action.label}</span>
    </button>
  );
}

/** Panneau flottant ancré à un point de clic, pour les menus contextuels du PC. */
export function AnchoredMenu({
  ancre,
  onClose,
  label,
  children,
  width = 236,
}: {
  ancre: { x: number; y: number };
  onClose: () => void;
  label: string;
  children: React.ReactNode;
  width?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState<{ x: number; y: number } | null>(null);

  useEscapeLayer(true, onClose);

  useEffect(() => {
    panelRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (!panelRef.current) return;
    const box = panelRef.current.getBoundingClientRect();
    setClamped({
      x: Math.max(MARGIN, Math.min(ancre.x, window.innerWidth - box.width - MARGIN)),
      y: Math.max(MARGIN, Math.min(ancre.y, window.innerHeight - box.height - MARGIN)),
    });
  }, [ancre.x, ancre.y]);

  useEffect(() => {
    const outside = (event: Event) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  };

  return (
    <motion.div
      ref={panelRef}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.12 }}
      style={{ left: (clamped ?? ancre).x, top: (clamped ?? ancre).y, width }}
      className="fixed z-[80] space-y-0.5 rounded-[18px] border border-line bg-canvas p-1 shadow-[0_30px_80px_-30px_var(--accent)]"
    >
      {children}
    </motion.div>
  );
}
