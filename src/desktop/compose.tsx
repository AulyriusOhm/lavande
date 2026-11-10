import { AnimatePresence, motion } from "motion/react";
import { PenLine, X } from "lucide-react";
import { useMailStore } from "@/lib/store";
import { ComposeScreen } from "@/screens/compose-screen";

const WINDOW =
  "absolute right-6 bottom-24 z-20 flex w-[600px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-[26px] border border-line bg-canvas shadow-[0_30px_80px_-40px_var(--accent)]";

const SLIDE = { duration: 0.22, ease: [0.22, 1, 0.36, 1] } as const;

export function DesktopCompose() {
  const {
    composeOpen,
    composeDraft,
    composeTitle,
    setComposeDraft,
    sendDraft,
    resumeCompose,
    minimizeCompose,
    closeCompose,
  } = useMailStore();

  return (
    <AnimatePresence initial={false}>
      {composeOpen ? (
        <motion.div
          key="compose"
          data-testid="desktop-compose"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 18 }}
          transition={SLIDE}
          className={`${WINDOW} h-[min(660px,calc(100%-9rem))]`}
        >
          <div className="min-h-0 flex-1">
            <ComposeScreen
              title={composeTitle}
              initialDraft={composeDraft ?? undefined}
              onDraftChange={setComposeDraft}
              onSend={sendDraft}
              onMinimize={minimizeCompose}
              onClose={closeCompose}
            />
          </div>
        </motion.div>
      ) : composeDraft ? (
        <motion.div
          key="compose-pill"
          data-testid="desktop-compose-pill"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 14 }}
          transition={SLIDE}
          className="absolute right-6 bottom-24 z-20 flex max-w-[calc(100vw-3rem)] items-center gap-1 rounded-full border border-line py-1 pr-1 pl-3.5 glass shadow-[0_18px_44px_-26px_var(--accent)]"
        >
          <button
            type="button"
            onClick={resumeCompose}
            aria-label="Reprendre le brouillon"
            className="focus-ring flex min-w-0 items-center gap-2 rounded-full py-1.5 text-left"
          >
            <PenLine className="size-4 shrink-0 text-accent-ink" strokeWidth={2.2} />
            <span className="max-w-[240px] truncate text-[12.5px] font-semibold text-ink">
              {composeDraft.subject.trim() || "Brouillon"}
            </span>
          </button>
          <button
            type="button"
            onClick={closeCompose}
            aria-label="Fermer le brouillon"
            title="Fermer le brouillon"
            className="focus-ring grid size-8 shrink-0 place-items-center rounded-full text-ink-muted transition-colors duration-200 hover:bg-surface-2 hover:text-ink"
          >
            <X className="size-3.5" strokeWidth={2.2} />
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
