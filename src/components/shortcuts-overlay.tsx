import { AnimatePresence, motion } from "motion/react";
import { Keyboard, X } from "lucide-react";
import { type ModKey, type Shortcut } from "@/lib/shortcuts";
import { Kbd } from "@/desktop/ui";
import { ShortcutList } from "@/components/shortcut-list";

export function ShortcutsOverlay({
  open,
  onClose,
  shortcuts,
  mod,
}: {
  open: boolean;
  onClose: () => void;
  shortcuts: readonly Shortcut[];
  mod: ModKey;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="shortcuts"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="absolute inset-0 z-[70] grid place-items-center p-6"
        >
          <button
            type="button"
            aria-label="Fermer les raccourcis clavier"
            onClick={onClose}
            className="absolute inset-0 cursor-default bg-ink/25 backdrop-blur-[2px]"
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcuts-title"
            data-testid="shortcuts-overlay"
            autoFocus
            tabIndex={-1}
            initial={{ opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="relative flex max-h-[min(620px,100%)] w-[min(560px,100%)] flex-col overflow-hidden rounded-[26px] border border-line bg-canvas shadow-[0_50px_120px_-50px_var(--accent)] outline-none"
          >
            <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-ink">
                <Keyboard className="size-4" strokeWidth={2.2} />
              </span>
              <div className="min-w-0 flex-1">
                <h2
                  id="shortcuts-title"
                  className="text-[14.5px] leading-tight font-extrabold tracking-[-0.02em] text-ink"
                >
                  Raccourcis clavier
                </h2>
                <p className="text-[11px] font-semibold text-ink-muted">
                  {mod === "meta" ? "⌘ sur Mac" : "Ctrl sur cet appareil"} · Échap pour fermer
                </p>
              </div>
              <Kbd>Échap</Kbd>
              <button
                type="button"
                onClick={onClose}
                aria-label="Fermer"
                className="focus-ring grid size-9 shrink-0 place-items-center rounded-full text-ink-soft transition-colors duration-200 hover:bg-surface-2 hover:text-ink"
              >
                <X className="size-4" strokeWidth={2.2} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <ShortcutList shortcuts={shortcuts} mod={mod} />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
