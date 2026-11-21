import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type PanInfo,
} from "motion/react";
import {
  Archive,
  ArrowLeft,
  Check,
  ExternalLink,
  Layers,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import type { CustomCategory, DecisionThresholds, MailDecision } from "@/lib/decision";
import {
  decisionDb,
  type CleanupAction,
  type CleanupReview,
  type DecisionCacheStore,
} from "@/lib/decision-db";
import type { Mail } from "@/lib/mail";
import {
  applyCleanupStat,
  buildCleanupDeck,
  countCleanupByFilter,
  emptyCleanupStats,
  formatCleanupSize,
  groupCleanupBySender,
  type CleanupCard,
  type CleanupFilter,
  type CleanupSenderGroup,
} from "@/lib/cleanup";
import { cn } from "@/lib/utils";
import { Avatar, Card, Chip, IconButton } from "@/components/ui/primitives";

export type CleanupScreenProps = {
  mails: Mail[];
  decisions: Record<string, MailDecision>;
  thresholds: DecisionThresholds;
  customCategories?: CustomCategory[];
  onTrash: (mails: Mail[]) => Promise<void> | void;
  onArchive: (mails: Mail[]) => Promise<void> | void;
  onRestore?: (mails: Mail[]) => Promise<void> | void;
  onOpenMail?: (mail: Mail) => void;
  onScanMore?: () => Promise<void> | void;
  scanning?: boolean;
  onClose: () => void;
  db?: DecisionCacheStore;
};

type ViewMode = "individual" | "grouped";

type UndoEntry = {
  action: CleanupAction;
  cards: CleanupCard[];
  protectedEmail?: string;
};

type ProtectProposal = {
  senderEmail: string;
  senderName: string;
};

const FILTERS: { id: CleanupFilter; label: string }[] = [
  { id: "all", label: "Tout nettoyable" },
  { id: "promo", label: "Pub & Promos" },
  { id: "old_totp", label: "Vieux TOTP" },
  { id: "notifications", label: "Notifications" },
];

const SWIPE_THRESHOLD = 84;

const ACTION_LABEL: Record<CleanupAction, string> = {
  trashed: "mis à la corbeille",
  kept: "conservé",
  archived: "archivé",
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

export function CleanupScreen({
  mails,
  decisions,
  thresholds,
  customCategories = [],
  onTrash,
  onArchive,
  onRestore,
  onOpenMail,
  onScanMore,
  scanning = false,
  onClose,
  db,
}: CleanupScreenProps) {
  const store = useMemo(() => db ?? decisionDb(), [db]);
  const reduceMotion = useReducedMotion();

  const [filter, setFilter] = useState<CleanupFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("individual");
  const [reviews, setReviews] = useState<CleanupReview[]>([]);
  const [protectedSenders, setProtectedSenders] = useState<string[]>([]);
  const [stats, setStats] = useState(emptyCleanupStats);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [protectProposal, setProtectProposal] = useState<ProtectProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([store.listCleanupReviews(), store.listProtectedSenders()])
      .then(([loadedReviews, loadedProtected]) => {
        if (cancelled) return;
        setReviews(loadedReviews);
        setProtectedSenders(loadedProtected);
      })
      .catch(() => {
        // Repli silencieux : l'état local reste opérationnel.
      });
    return () => {
      cancelled = true;
    };
  }, [store]);

  const now = useMemo(() => Date.now(), [mails, decisions, reviews, protectedSenders, filter]);

  const counts = useMemo(
    () =>
      countCleanupByFilter(
        mails,
        decisions,
        reviews,
        protectedSenders,
        thresholds,
        now,
        customCategories,
      ),
    [mails, decisions, reviews, protectedSenders, thresholds, now, customCategories],
  );

  const deck = useMemo(
    () =>
      buildCleanupDeck(
        mails,
        decisions,
        reviews,
        protectedSenders,
        thresholds,
        filter,
        now,
        customCategories,
      ),
    [mails, decisions, reviews, protectedSenders, thresholds, filter, now, customCategories],
  );

  const groups = useMemo(() => groupCleanupBySender(deck), [deck]);

  const currentCard: CleanupCard | null = viewMode === "individual" ? (deck[0] ?? null) : null;
  const currentGroup: CleanupSenderGroup | null = viewMode === "grouped" ? (groups[0] ?? null) : null;
  const hasCurrentItem = viewMode === "individual" ? currentCard !== null : currentGroup !== null;
  const remainingCount = viewMode === "individual" ? deck.length : groups.length;

  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotate = useTransform(x, [-220, 220], reduceMotion ? [0, 0] : [-7, 7]);
  const trashBadgeOpacity = useTransform(x, [-110, -28], [1, 0]);
  const keepBadgeOpacity = useTransform(x, [28, 110], [0, 1]);
  const archiveBadgeOpacity = useTransform(y, [-110, -28], [1, 0]);

  const resetCardPosition = useCallback(() => {
    if (reduceMotion) {
      x.set(0);
      y.set(0);
      return;
    }
    animate(x, 0, { type: "spring", stiffness: 420, damping: 32 });
    animate(y, 0, { type: "spring", stiffness: 420, damping: 32 });
  }, [reduceMotion, x, y]);

  useEffect(() => {
    x.set(0);
    y.set(0);
  }, [currentCard?.mailKey, currentGroup?.senderEmail, viewMode, filter, x, y]);

  const applyAction = useCallback(
    async (action: CleanupAction) => {
      if (busy) return;
      const cards =
        viewMode === "individual"
          ? currentCard
            ? [currentCard]
            : []
          : currentGroup
            ? currentGroup.cards
            : [];
      if (cards.length === 0) return;

      setBusy(true);
      setErrorMessage(null);
      setProtectProposal(null);

      try {
        const targetMails = cards.map((card) => card.mail);
        if (action === "trashed") {
          await onTrash(targetMails);
        } else if (action === "archived") {
          await onArchive(targetMails);
        }

        const reviewedAt = Date.now();
        const createdReviews: CleanupReview[] = cards.map((card) => ({
          mailKey: card.mailKey,
          ...(card.mail.messageId ? { messageId: card.mail.messageId } : {}),
          action,
          reviewedAt,
        }));

        await Promise.all(createdReviews.map((review) => store.putCleanupReview(review)));
        if (!mountedRef.current) return;

        setReviews((prev) => {
          const map = new Map(prev.map((item) => [item.mailKey, item]));
          for (const item of createdReviews) map.set(item.mailKey, item);
          return [...map.values()];
        });
        setStats((prev) => applyCleanupStat(prev, action, cards.length, 1));
        setUndoStack((prev) => [...prev, { action, cards }]);

        if (action === "kept" && viewMode === "grouped" && currentGroup?.senderEmail) {
          setProtectProposal({
            senderEmail: currentGroup.senderEmail,
            senderName: currentGroup.senderName,
          });
        }
      } catch (error) {
        if (!mountedRef.current) return;
        setErrorMessage(
          error instanceof Error && error.message
            ? error.message
            : "Impossible d'appliquer l'action pour le moment.",
        );
      } finally {
        if (mountedRef.current) {
          setBusy(false);
          x.set(0);
          y.set(0);
        }
      }
    },
    [busy, viewMode, currentCard, currentGroup, onTrash, onArchive, store, x, y],
  );

  const handleProtectSender = useCallback(
    async (proposal: ProtectProposal) => {
      if (busy) return;
      setBusy(true);
      setErrorMessage(null);
      try {
        await store.setSenderProtected(proposal.senderEmail, true);
        if (!mountedRef.current) return;
        const norm = proposal.senderEmail.trim().toLowerCase();
        setProtectedSenders((prev) => (prev.includes(norm) ? prev : [...prev, norm].sort()));
        setProtectProposal(null);
        setUndoStack((prev) => {
          if (prev.length === 0) return prev;
          const copy = [...prev];
          const top = copy[copy.length - 1];
          copy[copy.length - 1] = { ...top, protectedEmail: norm };
          return copy;
        });
      } catch (error) {
        if (!mountedRef.current) return;
        setErrorMessage(
          error instanceof Error && error.message
            ? error.message
            : "Impossible de protéger cet expéditeur.",
        );
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, store],
  );

  const handleUndo = useCallback(async () => {
    if (busy || undoStack.length === 0) return;
    const entry = undoStack[undoStack.length - 1];
    setBusy(true);
    setErrorMessage(null);
    setProtectProposal(null);

    try {
      await Promise.all(entry.cards.map((card) => store.deleteCleanupReview(card.mailKey)));
      if (entry.protectedEmail) {
        await store.setSenderProtected(entry.protectedEmail, false);
      }
      if ((entry.action === "trashed" || entry.action === "archived") && onRestore) {
        await onRestore(entry.cards.map((card) => card.mail));
      }
      if (!mountedRef.current) return;

      const removedKeys = new Set(entry.cards.map((card) => card.mailKey));
      setReviews((prev) => prev.filter((item) => !removedKeys.has(item.mailKey)));
      if (entry.protectedEmail) {
        setProtectedSenders((prev) => prev.filter((email) => email !== entry.protectedEmail));
      }
      setStats((prev) => applyCleanupStat(prev, entry.action, entry.cards.length, -1));
      setUndoStack((prev) => prev.slice(0, -1));
    } catch (error) {
      if (!mountedRef.current) return;
      setErrorMessage(
        error instanceof Error && error.message
          ? error.message
          : "Impossible d'annuler la dernière action.",
      );
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, undoStack, store, onRestore]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.altKey) return;

      const key = event.key;
      if ((key === "z" || key === "Z") && (!event.shiftKey || event.ctrlKey || event.metaKey)) {
        if (undoStack.length > 0) {
          event.preventDefault();
          void handleUndo();
        }
        return;
      }

      if (event.ctrlKey || event.metaKey) return;

      if (key === "ArrowLeft" && hasCurrentItem) {
        event.preventDefault();
        void applyAction("trashed");
      } else if (key === "ArrowRight" && hasCurrentItem) {
        event.preventDefault();
        void applyAction("kept");
      } else if (key === "ArrowUp" && hasCurrentItem) {
        event.preventDefault();
        void applyAction("archived");
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyAction, handleUndo, hasCurrentItem, undoStack.length]);

  const handleDragEnd = useCallback(
    (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      const { offset } = info;
      if (offset.y < -SWIPE_THRESHOLD && Math.abs(offset.y) >= Math.abs(offset.x)) {
        void applyAction("archived");
        return;
      }
      if (offset.x < -SWIPE_THRESHOLD) {
        void applyAction("trashed");
        return;
      }
      if (offset.x > SWIPE_THRESHOLD) {
        void applyAction("kept");
        return;
      }
      resetCardPosition();
    },
    [applyAction, resetCardPosition],
  );

  const lastUndo = undoStack[undoStack.length - 1] ?? null;
  const activeKey =
    viewMode === "individual"
      ? (currentCard?.mailKey ?? "empty")
      : (currentGroup?.senderEmail ?? "empty");

  return (
    <section
      aria-label="Mode nettoyage de boîte"
      className="flex h-full min-h-0 flex-col bg-canvas text-ink"
    >
      {/* En-tête */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface/85 px-4 py-3 backdrop-blur-md md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <IconButton onClick={onClose} aria-label="Retour à la boîte">
            <ArrowLeft className="size-5" strokeWidth={2} />
          </IconButton>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[20px] font-extrabold tracking-[-0.035em] text-ink">
                Nettoyage
              </h1>
              <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[11px] font-bold text-accent-ink tabular-nums">
                {stats.processed} {stats.processed > 1 ? "traités" : "traité"}
              </span>
            </div>
            <p className="text-[12px] font-medium text-ink-muted">
              {stats.trashed > 0
                ? `${stats.trashed} à la corbeille · ${formatCleanupSize(stats.trashed)} libérés`
                : "Aucune suppression automatique · tout passe par votre geste"}
            </p>
          </div>
        </div>

        {/* Bascule Individuel vs Par expéditeur */}
        <div
          role="group"
          aria-label="Mode d'affichage du nettoyage"
          className="inline-flex rounded-full border border-line bg-surface-2 p-1"
        >
          <button
            type="button"
            aria-pressed={viewMode === "individual"}
            onClick={() => setViewMode("individual")}
            className={cn(
              "focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold transition-colors",
              viewMode === "individual"
                ? "bg-surface text-ink shadow-xs"
                : "text-ink-soft hover:text-ink",
            )}
          >
            <Layers className="size-3.5" strokeWidth={2} />
            <span>Individuel</span>
          </button>
          <button
            type="button"
            aria-pressed={viewMode === "grouped"}
            onClick={() => setViewMode("grouped")}
            className={cn(
              "focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold transition-colors",
              viewMode === "grouped"
                ? "bg-surface text-ink shadow-xs"
                : "text-ink-soft hover:text-ink",
            )}
          >
            <Users className="size-3.5" strokeWidth={2} />
            <span>Par expéditeur</span>
          </button>
        </div>
      </header>

      {/* Puces de filtre */}
      <div className="flex items-center gap-2 overflow-x-auto border-b border-line/70 px-4 py-2.5 md:px-6">
        {FILTERS.map((item) => {
          const active = filter === item.id;
          return (
            <Chip
              key={item.id}
              active={active}
              onClick={() => setFilter(item.id)}
              className="shrink-0"
            >
              <span>{item.label}</span>
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums",
                  active ? "bg-ink/10 text-accent-contrast" : "bg-surface-2 text-ink-muted",
                )}
              >
                {counts[item.id]}
              </span>
            </Chip>
          );
        })}
      </div>

      {/* Corps principal */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-between gap-4 overflow-y-auto px-4 py-5 md:px-6">
        {/* Bandeau d'erreur ou de proposition de protection */}
        <div className="w-full max-w-lg space-y-2">
          {errorMessage ? (
            <div
              role="alert"
              className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-[12.5px] font-semibold text-rose-700 dark:text-rose-300"
            >
              {errorMessage}
            </div>
          ) : null}

          {protectProposal ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-accent-ring bg-accent-soft px-3.5 py-2.5">
              <div className="flex min-w-0 items-center gap-2 text-[12.5px] font-semibold text-accent-ink">
                <ShieldCheck className="size-4 shrink-0" strokeWidth={2.2} />
                <span className="truncate">
                  {protectProposal.senderName} conservé · ne plus proposer ses mails ?
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleProtectSender(protectProposal)}
                  className="focus-ring inline-flex min-h-9 items-center gap-1 rounded-full bg-accent px-3 text-[12px] font-bold text-accent-contrast transition-transform active:scale-95"
                >
                  Protéger l&apos;expéditeur
                </button>
                <button
                  type="button"
                  onClick={() => setProtectProposal(null)}
                  className="focus-ring inline-flex min-h-9 items-center rounded-full px-2.5 text-[12px] font-semibold text-ink-soft hover:text-ink"
                >
                  Ignorer
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Zone carte swipable ou état vide */}
        {hasCurrentItem ? (
          <div className="relative flex w-full max-w-lg flex-1 flex-col items-center justify-center">
            <div className="mb-2 flex w-full items-center justify-between px-1 text-[11.5px] font-semibold text-ink-muted">
              <span>
                {viewMode === "individual"
                  ? `${remainingCount} mail${remainingCount > 1 ? "s" : ""} dans la pile`
                  : `${remainingCount} expéditeur${remainingCount > 1 ? "s" : ""} à trier`}
              </span>
              <span className="hidden sm:inline">← Corbeille · ↑ Archiver · → Garder</span>
            </div>

            <div className="relative w-full">
              {/* Carte suivante en arrière-plan pour la profondeur */}
              {remainingCount > 1 ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-3 top-3 bottom-0 rounded-[28px] border border-line bg-surface-2/80 opacity-70"
                />
              ) : null}

              <motion.div
                key={activeKey}
                data-swipe="true"
                drag={!busy}
                dragConstraints={{ left: 0, right: 0, top: 0, bottom: 0 }}
                dragElastic={0.65}
                dragMomentum={false}
                style={{ x, y, rotate }}
                onDragEnd={handleDragEnd}
                className="relative cursor-grab touch-none active:cursor-grabbing"
              >
                {/* Timbres directionnels pendant le swipe */}
                <motion.div
                  aria-hidden
                  style={{ opacity: trashBadgeOpacity }}
                  className="pointer-events-none absolute top-5 right-5 z-10 rounded-full border border-rose-500/40 bg-rose-500/15 px-3 py-1 text-[11px] font-extrabold tracking-wide text-rose-700 uppercase dark:text-rose-300"
                >
                  Corbeille
                </motion.div>
                <motion.div
                  aria-hidden
                  style={{ opacity: keepBadgeOpacity }}
                  className="pointer-events-none absolute top-5 left-5 z-10 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-3 py-1 text-[11px] font-extrabold tracking-wide text-emerald-700 uppercase dark:text-emerald-300"
                >
                  Garder
                </motion.div>
                <motion.div
                  aria-hidden
                  style={{ opacity: archiveBadgeOpacity }}
                  className="pointer-events-none absolute bottom-5 left-1/2 z-10 -translate-x-1/2 rounded-full border border-accent-ring bg-accent-soft px-3 py-1 text-[11px] font-extrabold tracking-wide text-accent-ink uppercase"
                >
                  Archiver
                </motion.div>

                {currentCard ? (
                  <IndividualCleanupCard card={currentCard} onOpenMail={onOpenMail} />
                ) : currentGroup ? (
                  <GroupedCleanupCard group={currentGroup} onOpenMail={onOpenMail} />
                ) : null}
              </motion.div>
            </div>
          </div>
        ) : (
          <Card className="flex w-full max-w-lg flex-col items-center gap-4 p-8 text-center">
            <div className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent-ink">
              <Sparkles className="size-7" strokeWidth={2} />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-[20px] font-extrabold tracking-[-0.03em] text-ink">
                Tout est propre !
              </h2>
              <p className="text-[13.5px] leading-relaxed text-ink-soft">
                {stats.processed > 0
                  ? `${stats.processed} mail${stats.processed > 1 ? "s" : ""} trié${stats.processed > 1 ? "s" : ""} durant cette session${stats.trashed > 0 ? ` (${formatCleanupSize(stats.trashed)} libérés)` : ""}.`
                  : "Aucun mail nettoyable ne correspond à ce filtre pour le moment."}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
              {filter !== "all" && counts.all > 0 ? (
                <button
                  type="button"
                  onClick={() => setFilter("all")}
                  className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface-2 px-4 text-[13px] font-bold text-ink transition-colors hover:border-accent-ring"
                >
                  Voir tout ce qui est nettoyable ({counts.all})
                </button>
              ) : null}

              {onScanMore ? (
                <button
                  type="button"
                  disabled={scanning}
                  onClick={() => void onScanMore()}
                  className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-full bg-accent px-5 text-[13px] font-bold text-accent-contrast shadow-[0_8px_20px_-10px_var(--accent)] transition-transform hover:brightness-105 active:scale-95 disabled:opacity-60"
                >
                  {scanning ? (
                    <>
                      <Loader2 className="size-4 animate-spin" strokeWidth={2.2} />
                      <span>Analyse en cours…</span>
                    </>
                  ) : (
                    <span>Analyser 50 mails plus anciens</span>
                  )}
                </button>
              ) : null}
            </div>
          </Card>
        )}

        {/* Barre d'actions + Undo */}
        <footer className="flex w-full max-w-lg flex-col gap-3">
          {hasCurrentItem ? (
            <div className="grid grid-cols-3 gap-2.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => void applyAction("trashed")}
                aria-label="Corbeille (Flèche gauche)"
                className="focus-ring flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-rose-500/25 bg-rose-500/10 px-3 text-[13px] font-bold text-rose-700 transition-transform hover:bg-rose-500/15 active:scale-95 disabled:opacity-50 dark:text-rose-300"
              >
                <Trash2 className="size-4" strokeWidth={2.2} />
                <span>Corbeille</span>
              </button>

              <button
                type="button"
                disabled={busy}
                onClick={() => void applyAction("archived")}
                aria-label="Archiver (Flèche haut)"
                className="focus-ring flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-line bg-surface px-3 text-[13px] font-bold text-ink-soft transition-transform hover:border-accent-ring hover:text-ink active:scale-95 disabled:opacity-50"
              >
                <Archive className="size-4" strokeWidth={2.2} />
                <span>Archiver</span>
              </button>

              <button
                type="button"
                disabled={busy}
                onClick={() => void applyAction("kept")}
                aria-label="Garder (Flèche droite)"
                className="focus-ring flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-accent px-3 text-[13px] font-bold text-accent-contrast shadow-[0_8px_20px_-10px_var(--accent)] transition-transform hover:brightness-105 active:scale-95 disabled:opacity-50"
              >
                <Check className="size-4" strokeWidth={2.4} />
                <span>Garder</span>
              </button>
            </div>
          ) : null}

          <div className="flex items-center justify-between rounded-2xl border border-line bg-surface px-3.5 py-2">
            <span className="truncate text-[12px] font-medium text-ink-muted">
              {lastUndo
                ? `Dernière action : ${lastUndo.cards.length} ${ACTION_LABEL[lastUndo.action]}`
                : "Aucune action récente à annuler"}
            </span>
            <button
              type="button"
              disabled={busy || undoStack.length === 0}
              onClick={() => void handleUndo()}
              aria-label="Annuler la dernière action"
              className="focus-ring inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-[12px] font-bold text-ink transition-colors hover:bg-accent-soft hover:text-accent-ink disabled:cursor-not-allowed disabled:opacity-45"
            >
              <RotateCcw className="size-3.5" strokeWidth={2.2} />
              <span>Annuler</span>
            </button>
          </div>
        </footer>
      </div>
    </section>
  );
}

function IndividualCleanupCard({
  card,
  onOpenMail,
}: {
  card: CleanupCard;
  onOpenMail?: (mail: Mail) => void;
}) {
  const { mail, reason } = card;
  const excerpt = mail.preview?.trim() || mail.body[0]?.trim() || "";
  return (
    <Card className="rounded-[28px] p-5 shadow-[0_14px_34px_-22px_var(--accent)]">
      <div className="flex items-start gap-3">
        <Avatar name={card.senderName} tone={mail.tone} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-[14px] font-bold text-ink">{card.senderName}</p>
            <span className="shrink-0 text-[11.5px] font-medium text-ink-muted">
              {mail.date ?? mail.time}
            </span>
          </div>
          <p className="truncate text-[12px] font-medium text-ink-muted">{mail.email}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full bg-accent-soft px-3 py-1 text-[11.5px] font-bold text-accent-ink">
          {reason}
        </span>
      </div>

      <h2 className="mt-3 text-[17px] leading-snug font-extrabold tracking-[-0.02em] text-ink">
        {mail.subject || "(Sans objet)"}
      </h2>

      {excerpt ? (
        <p className="mt-2 line-clamp-4 text-[13.5px] leading-relaxed text-ink-soft">{excerpt}</p>
      ) : null}

      {onOpenMail ? (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => onOpenMail(mail)}
            className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 text-[12px] font-semibold text-ink-soft transition-colors hover:border-accent-ring hover:text-ink"
          >
            <ExternalLink className="size-3.5" strokeWidth={2} />
            <span>Ouvrir le mail</span>
          </button>
        </div>
      ) : null}
    </Card>
  );
}

function GroupedCleanupCard({
  group,
  onOpenMail,
}: {
  group: CleanupSenderGroup;
  onOpenMail?: (mail: Mail) => void;
}) {
  const previewMails = group.mails.slice(0, 4);
  const remaining = group.mails.length - previewMails.length;
  return (
    <Card className="rounded-[28px] p-5 shadow-[0_14px_34px_-22px_var(--accent)]">
      <div className="flex items-start gap-3">
        <Avatar name={group.senderName} tone={group.tone} size={44} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-bold text-ink">{group.senderName}</p>
          <p className="truncate text-[12px] font-medium text-ink-muted">{group.senderEmail}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full bg-accent px-3 py-1 text-[12px] font-extrabold text-accent-contrast">
          {group.summaryLabel}
        </span>
        <span className="inline-flex items-center rounded-full bg-accent-soft px-3 py-1 text-[11.5px] font-bold text-accent-ink">
          {group.primaryReason}
        </span>
      </div>

      <ul className="mt-4 space-y-2">
        {previewMails.map((mail) => (
          <li
            key={mail.id}
            className="flex items-center justify-between gap-2 rounded-2xl bg-surface-2/80 px-3 py-2 text-[12.5px]"
          >
            <span className="min-w-0 truncate font-semibold text-ink">
              {mail.subject || "(Sans objet)"}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-[11px] text-ink-muted">{mail.time}</span>
              {onOpenMail ? (
                <button
                  type="button"
                  aria-label={`Ouvrir ${mail.subject}`}
                  onClick={() => onOpenMail(mail)}
                  className="focus-ring grid size-7 place-items-center rounded-full text-ink-soft hover:bg-surface hover:text-ink"
                >
                  <ExternalLink className="size-3.5" strokeWidth={2} />
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {remaining > 0 ? (
        <p className="mt-2.5 text-center text-[11.5px] font-semibold text-ink-muted">
          + {remaining} autre{remaining > 1 ? "s" : ""} message{remaining > 1 ? "s" : ""}
        </p>
      ) : null}
    </Card>
  );
}
