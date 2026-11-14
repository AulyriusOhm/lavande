import { AnimatePresence, motion } from "motion/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { Icon } from "@/components/icons";
import type { Theme } from "@/hooks/useTheme";

export const SHOTS = [
  { name: "pc-inbox", label: "Boîte de réception", device: "Ordinateur", w: 1600, h: 1000 },
  { name: "pc-agenda", label: "Agenda", device: "Ordinateur", w: 1600, h: 1000 },
  { name: "pc-planning", label: "Planification", device: "Ordinateur", w: 1600, h: 1000 },
  { name: "pc-compose", label: "Rédaction", device: "Ordinateur", w: 1600, h: 1000 },
  { name: "pc-settings", label: "Réglages", device: "Ordinateur", w: 1600, h: 1000 },
  { name: "mobile-inbox", label: "Boîte de réception", device: "Téléphone", w: 780, h: 1688 },
  { name: "mobile-agenda", label: "Agenda", device: "Téléphone", w: 780, h: 1688 },
  { name: "mobile-settings", label: "Réglages", device: "Téléphone", w: 780, h: 1688 },
] as const;

interface LightboxApi {
  open: (name: string) => void;
}

const LightboxContext = createContext<LightboxApi | null>(null);

export function useLightbox(): LightboxApi {
  const ctx = useContext(LightboxContext);
  if (!ctx) throw new Error("useLightbox doit être utilisé dans LightboxProvider");
  return ctx;
}

export function LightboxProvider({ children }: { children: ReactNode }) {
  const [index, setIndex] = useState<number | null>(null);
  const open = useCallback((name: string) => {
    const i = SHOTS.findIndex((shot) => shot.name === name);
    setIndex(i >= 0 ? i : 0);
  }, []);

  return (
    <LightboxContext.Provider value={{ open }}>
      {children}
      <Viewer index={index} setIndex={setIndex} />
    </LightboxContext.Provider>
  );
}

function Viewer({
  index,
  setIndex,
}: {
  index: number | null;
  setIndex: React.Dispatch<React.SetStateAction<number | null>>;
}) {
  const [variant, setVariant] = useState<Theme>("dark");
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const open = index !== null;
  const shot = open ? SHOTS[index] : null;
  const total = SHOTS.length;
  const base = import.meta.env.BASE_URL;

  useEffect(() => {
    if (open) {
      setVariant(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIndex(null);
      } else if (event.key === "ArrowRight") {
        setIndex((i) => (i === null ? i : (i + 1) % total));
      } else if (event.key === "ArrowLeft") {
        setIndex((i) => (i === null ? i : (i - 1 + total) % total));
      } else if (event.key === "Tab") {
        const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button, a[href], [tabindex]:not([tabindex="-1"])',
        );
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus?.();
    };
  }, [open, total, setIndex]);

  const step = (delta: number) => setIndex((i) => (i === null ? i : (i + delta + total) % total));

  return createPortal(
    <AnimatePresence>
      {open && shot ? (
        <motion.div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={`Capture grand format : ${shot.label}, ${shot.device}`}
          className="fixed inset-0 z-[100] flex flex-col"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <button
            type="button"
            aria-label="Fermer la visionneuse"
            onClick={() => setIndex(null)}
            className="absolute inset-0 cursor-zoom-out bg-canvas/95 backdrop-blur-md"
          />

          <div className="relative z-10 flex items-center justify-between gap-3 border-b border-line/60 bg-surface/70 px-4 py-3 backdrop-blur sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-surface-2 text-accent">
                <Icon name={shot.device === "Téléphone" ? "smartphone" : "monitor"} className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[0.95rem] font-bold text-ink">{shot.label}</span>
                <span className="block text-[0.72rem] font-semibold tracking-wide text-ink-muted uppercase">
                  {shot.device} · {index + 1} / {total}
                </span>
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setVariant((v) => (v === "dark" ? "light" : "dark"))}
                aria-label={variant === "dark" ? "Afficher la capture en thème clair" : "Afficher la capture en thème sombre"}
                className="grid size-10 place-items-center rounded-full border border-line-strong bg-surface/80 text-ink-soft transition-colors hover:border-accent-ring hover:text-accent active:scale-95"
              >
                <Icon name={variant === "dark" ? "sun" : "moon"} className="size-4" />
              </button>
              <a
                href={`${base}shots/${shot.name}-${variant}.webp`}
                download={`${shot.name}-${variant}.webp`}
                aria-label="Télécharger la capture"
                className="grid size-10 place-items-center rounded-full border border-line-strong bg-surface/80 text-ink-soft transition-colors hover:border-accent-ring hover:text-accent active:scale-95"
              >
                <Icon name="download" className="size-4" />
              </a>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setIndex(null)}
                aria-label="Fermer"
                className="grid size-10 place-items-center rounded-full border border-line-strong bg-surface/80 text-ink transition-colors hover:border-accent-ring hover:text-accent active:scale-95"
              >
                <Icon name="close" className="size-4" />
              </button>
            </div>
          </div>

          <div className="pointer-events-none relative z-[5] flex flex-1 items-center justify-center overflow-hidden p-4 sm:p-8">
            <AnimatePresence mode="wait">
              <motion.img
                key={`${shot.name}-${variant}`}
                src={`${base}shots/${shot.name}-${variant}.webp`}
                alt={`${shot.label} — ${shot.device}, capture grand format`}
                width={shot.w}
                height={shot.h}
                className="pointer-events-auto max-h-full max-w-full rounded-xl border border-line-strong object-contain shadow-[0_40px_120px_-40px_rgba(0,0,0,0.7)]"
                initial={{ opacity: 0, scale: 0.985 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.985 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
              />
            </AnimatePresence>
          </div>

          <button
            type="button"
            onClick={() => step(-1)}
            aria-label="Capture précédente"
            className="absolute top-1/2 left-3 z-10 grid size-12 -translate-y-1/2 place-items-center rounded-full border border-line-strong bg-surface/85 text-ink shadow-[var(--shadow-soft)] backdrop-blur transition-all hover:border-accent-ring hover:text-accent active:scale-95 sm:left-5"
          >
            <Icon name="chevronLeft" className="size-5" />
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            aria-label="Capture suivante"
            className="absolute top-1/2 right-3 z-10 grid size-12 -translate-y-1/2 place-items-center rounded-full border border-line-strong bg-surface/85 text-ink shadow-[var(--shadow-soft)] backdrop-blur transition-all hover:border-accent-ring hover:text-accent active:scale-95 sm:right-5"
          >
            <Icon name="chevronRight" className="size-5" />
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
