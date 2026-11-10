import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";

export type NoticeData = {
  id: number;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};

export function Notice({
  notice,
  onClose,
  duration = 4200,
}: {
  notice: NoticeData | null;
  onClose: () => void;
  duration?: number;
}) {
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(onClose, duration);
    return () => window.clearTimeout(timer);
  }, [notice, duration, onClose]);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[44] flex justify-center px-4 pb-[calc(env(safe-area-inset-bottom,0px)+5.75rem)] sm:pb-[5.5rem]">
      <AnimatePresence>
        {notice && (
          <motion.div
            key={notice.id}
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: 14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            className={cn(
              "pointer-events-auto flex max-w-full items-center gap-3 rounded-full border border-line py-1 pr-1 pl-4",
              "glass shadow-[0_18px_40px_-22px_var(--accent)]",
            )}
          >
            <span className="truncate text-[12.5px] font-semibold text-ink">{notice.message}</span>
            {notice.actionLabel && notice.onAction && (
              <button
                type="button"
                onClick={() => {
                  notice.onAction?.();
                  onClose();
                }}
                className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-accent-soft px-3.5 text-[11.5px] font-bold text-accent-ink transition-transform duration-200 active:scale-95"
              >
                {notice.actionLabel}
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
