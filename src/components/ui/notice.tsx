import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";

export type NoticeData = {
  id: number;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};

const BASE_DURATION = 4200;
const MAX_DURATION = 10_000;
const COMFORT_CHARS = 48;
const MS_PER_EXTRA_CHAR = 80;

/** Un message long reste affiché plus longtemps : 4,2 s pour un court, 10 s au maximum. */
export function noticeDuration(message: string, base = BASE_DURATION): number {
  const extra = Math.max(0, message.length - COMFORT_CHARS) * MS_PER_EXTRA_CHAR;
  const cap = Math.max(base, MAX_DURATION);
  return Math.min(cap, base + extra);
}

export function Notice({
  notice,
  onClose,
  duration = BASE_DURATION,
}: {
  notice: NoticeData | null;
  onClose: () => void;
  duration?: number;
}) {
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(onClose, noticeDuration(notice.message, duration));
    return () => window.clearTimeout(timer);
  }, [notice, duration, onClose]);

  const long = notice !== null && notice.message.length > COMFORT_CHARS;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[44] flex justify-center px-4 pb-[calc(env(safe-area-inset-bottom,0px)+5.75rem)] sm:pb-[5.5rem]">
      <AnimatePresence>
        {notice && (
          <motion.div
            key={notice.id}
            role="status"
            aria-live="polite"
            onClick={onClose}
            initial={{ opacity: 0, y: 14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            className={cn(
              "pointer-events-auto flex w-fit max-w-[min(100%,34rem)] cursor-pointer items-center gap-3 border border-line pl-4",
              long ? "rounded-2xl py-2 pr-2" : "rounded-full py-1 pr-1",
              "glass shadow-[0_18px_40px_-22px_var(--accent)]",
            )}
          >
            <span className="min-w-0 text-left text-[12.5px] leading-snug font-semibold break-words whitespace-normal text-ink">
              {notice.message}
            </span>
            {notice.actionLabel && notice.onAction && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
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
