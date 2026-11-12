import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { animate, motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { Archive, ChevronDown, ChevronUp, Inbox, Loader2, PenLine, Plus, RotateCcw, Search, RefreshCw, Send, ShieldAlert, Sparkles, Trash2 } from "lucide-react";
import type { FolderId, Mail } from "@/lib/mail";
import { folderLabel } from "@/lib/mail";
import { threadsInFolder } from "@/lib/threads";
import { ALL_ACCOUNTS } from "@/lib/accounts";
import { useMailStore } from "@/lib/store";
import type { MailNavigation } from "@/lib/app-shortcuts";
import { accentContrast } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Avatar, Chip, IconButton } from "@/components/ui/primitives";
import { AnimatedGradientText } from "@/components/ui/animated-text";
import { BorderBeam } from "@/components/ui/border-beam";
import { NumberTicker } from "@/components/ui/number-ticker";
import { MeshGlow } from "@/components/ui/backdrops";
import { ThreadRow } from "@/components/thread-row";
import { EmptyTrashButton } from "@/components/empty-trash";

type Filter = "all" | "unread" | "starred" | "encrypted";

const INTRO_HOLD_MS = 2000;

export function InboxScreen({
  mails,
  account,
  folder,
  active,
  navigationRef,
  onOpenAccounts,
  onOpenFolders,
  onOpen,
  onToggleStar,
  onSearch,
  onMailAction,
  onReply,
  onNotSpam,
  onRestore,
  onForward,
}: {
  mails: Mail[];
  account: string;
  folder: FolderId;
  active: boolean;
  navigationRef: RefObject<MailNavigation | null>;
  onOpenAccounts: () => void;
  onOpenFolders: () => void;
  onOpen: (mail: Mail) => void;
  onToggleStar: (id: string) => void;
  onSearch: () => void;
  onMailAction: (kind: "delete" | "archive" | "read", mail: Mail) => void;
  onReply: (mail: Mail) => void;
  onForward?: (mail: Mail) => void;
  onNotSpam?: (mail: Mail) => void;
  onRestore?: (mail: Mail) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [compact, setCompact] = useState(false);
  const [sizes, setSizes] = useState({ hero: 0, card: 0, bar: 0 });
  const [cursor, setCursor] = useState<number | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  const focusRow = useCallback((id: string | null) => {
    if (!id || !rowsRef.current) return;
    const row = Array.from(rowsRef.current.querySelectorAll<HTMLElement>("[data-mail-row]")).find(
      (element) => element.dataset.mailRow === id,
    );
    if (!row) return;
    row.focus({ preventScroll: true });
    row.scrollIntoView?.({ block: "nearest" });
  }, []);

  const {
    mode,
    syncing,
    syncFolder,
    threadsLoading,
    hasMore,
    loadMore,
    folderPath,
    folderOptions,
    accountById,
    folderStats,
    summary,
    summaryLoading,
    refreshSummary,
    openMail,
    closeMessage,
  } = useMailStore();

  useEffect(() => {
    setFilter("all");
  }, [folder, folderPath, account]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const raw = useMotionValue(0);
  const progress = useSpring(raw, { stiffness: 200, damping: 28, mass: 0.9 });

  const heroHeight = useTransform(progress, [0, 0.7], [sizes.hero, 0]);
  const heroOpacity = useTransform(progress, [0, 0.45], [1, 0]);
  const heroScale = useTransform(progress, [0, 1], [1, 0.96]);
  const cardHeight = useTransform(progress, [0, 0.9], [sizes.card, 50]);
  const cardBody = useTransform(progress, [0, 0.45], [1, 0]);
  const barOpacity = useTransform(progress, [0.55, 0.95], [0, 1]);
  const barY = useTransform(progress, [0.55, 0.95], [-14, 0]);
  const barSpace = useTransform(progress, [0.5, 1], [0, sizes.bar + 14]);
  const cardCompact = useTransform(progress, [0.35, 0.85], [0, 1]);
  const cardExpand = useTransform(progress, [0, 0.35], [1, 0]);

  useLayoutEffect(() => {
    const measure = () =>
      setSizes({
        hero: heroRef.current?.offsetHeight ?? 0,
        card: cardRef.current?.offsetHeight ?? 0,
        bar: barRef.current?.offsetHeight ?? 0,
      });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const collapse = useCallback(() => {
    setCompact(true);
    animate(raw, 1, { duration: 0.9, ease: [0.22, 1, 0.36, 1] });
  }, [raw]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      raw.set(1);
      setCompact(true);
      return;
    }

    const timer = window.setTimeout(collapse, INTRO_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [collapse, raw]);

  const expand = () => {
    setCompact(false);
    animate(raw, 0, { duration: 0.7, ease: [0.22, 1, 0.36, 1] });
  };

  const threads = threadsInFolder(mails, folder, account);
  const heading =
    folderOptions.find((entry) => entry.id === folder && entry.path === folderPath)?.label ??
    folderLabel(folder);
  const unreadCount = threads.filter((thread) => thread.unread > 0).length;
  const starredCount = threads.filter((thread) => thread.starred).length;
  const encryptedCount = threads.filter((thread) => thread.encrypted > 0).length;
  const attachmentThreads = threads.filter((thread) => thread.attachments > 0).length;
  const current = accountById(account);

  const visible = threads.filter((thread) => {
    if (filter === "unread") return thread.unread > 0;
    if (filter === "starred") return thread.starred;
    if (filter === "encrypted") return thread.encrypted > 0;
    return true;
  });

  const currentIndex = useMemo(() => {
    if (openMail) {
      const index = visible.findIndex((thread) => thread.messages.some((message) => message.id === openMail.id));
      if (index >= 0) return index;
    }
    return cursor;
  }, [openMail, visible, cursor]);
  const selectedThreadId = currentIndex === null ? null : (visible[currentIndex]?.id ?? null);
  const navState = useRef({ visible, currentIndex, active, openMail });
  navState.current = { visible, currentIndex, active, openMail };

  useEffect(() => {
    setCursor(null);
  }, [filter, folder, folderPath, account]);

  useEffect(() => {
    const available = () => {
      const state = navState.current;
      return state.active && !state.openMail && state.visible.length > 0;
    };

    const selected = () => {
      const state = navState.current;
      if (state.openMail) return state.openMail;
      if (state.currentIndex === null) return null;
      return state.visible[state.currentIndex]?.primary ?? null;
    };

    const threadIdOf = (mail: Mail) =>
      navState.current.visible.find((thread) =>
        thread.messages.some((message) => message.id === mail.id),
      )?.id ?? null;

    const advance = (removed: string | null) => {
      const state = navState.current;
      const index = state.currentIndex ?? 0;
      const remaining = state.visible.filter((thread) => thread.id !== removed).length;
      setCursor(remaining === 0 ? null : Math.min(index, remaining - 1));
      if (state.openMail) closeMessage();
    };

    const guarded = (run: (mail: Mail) => void) => {
      const mail = selected();
      if (!mail) return null;
      run(mail);
      return mail;
    };

    const move = (step: number) => {
      const state = navState.current;
      if (state.visible.length === 0) return;
      const base = state.currentIndex ?? (step > 0 ? -1 : state.visible.length);
      const index = Math.min(state.visible.length - 1, Math.max(0, base + step));
      const thread = state.visible[index];
      if (!thread) return;
      setCursor(index);
      focusRow(thread.id);
    };

    navigationRef.current = {
      canMove: available,
      canOpen: available,
      canAct: () => navState.current.active && selected() !== null,
      current: selected,
      next: () => move(1),
      previous: () => move(-1),
      open: () => {
        const state = navState.current;
        const index = state.currentIndex ?? 0;
        const thread = state.visible[index];
        if (!thread) return;
        setCursor(index);
        onOpen(thread.primary);
      },
      deleteSelected: () => {
        const mail = guarded((entry) => onMailAction("delete", entry));
        if (mail) advance(threadIdOf(mail));
      },
      archiveSelected: () => {
        const mail = guarded((entry) => onMailAction("archive", entry));
        if (mail) advance(threadIdOf(mail));
      },
      toggleStarSelected: () => {
        guarded((entry) => onToggleStar(entry.id));
      },
      toggleReadSelected: () => {
        guarded((entry) => onMailAction("read", entry));
      },
      replySelected: () => {
        guarded(onReply);
      },
      forwardSelected: () => {
        if (onForward) guarded(onForward);
      },
    };

    return () => {
      navigationRef.current = null;
    };
  }, [navigationRef, onOpen, onMailAction, onToggleStar, onReply, onForward, closeMessage, focusRow]);

  useEffect(() => {
    if (wasOpen.current && !openMail && cursor !== null) focusRow(selectedThreadId);
    wasOpen.current = Boolean(openMail);
  }, [openMail, cursor, selectedThreadId, focusRow]);

  return (
    <div className="relative h-full">
      <div ref={scrollRef} className="h-full overflow-y-auto no-scrollbar pb-32">
        <MeshGlow className="h-56" />

        <motion.div style={{ height: heroHeight, opacity: heroOpacity }} className="overflow-hidden">
          <motion.div ref={heroRef} style={{ scale: heroScale }} className="origin-top px-5 pt-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2.5">
                <IconButton
                  aria-label="Ouvrir les dossiers"
                  onClick={onOpenFolders}
                  className="size-9 bg-accent-soft text-accent-ink hover:bg-accent-soft"
                >
                  <Inbox className="size-[18px]" strokeWidth={2.2} />
                </IconButton>
                <Avatar
                  name="Roman"
                  size={40}
                  rounded="rounded-full"
                  className="ring-2 ring-accent-ring ring-offset-2 ring-offset-canvas"
                />
                <h1 className="text-[24px] leading-[1.05] font-extrabold tracking-[-0.035em] text-ink">
                  {folder === "inbox" ? (
                    <>
                      Boîte de
                      <br />
                      <AnimatedGradientText>réception</AnimatedGradientText>
                    </>
                  ) : (
                    <AnimatedGradientText>{heading}</AnimatedGradientText>
                  )}
                </h1>
              </div>
              <div className="flex items-center gap-1">
                <IconButton aria-label="Rechercher" onClick={onSearch}>
                  <Search className="size-4" />
                </IconButton>
                <IconButton
                  aria-label={syncing ? "Synchronisation en cours" : "Synchroniser le dossier"}
                  aria-busy={syncing}
                  onClick={syncFolder}
                  disabled={syncing}
                >
                  <RefreshCw className={cn("size-4", syncing && "animate-spin")} />
                </IconButton>
              </div>
            </div>

            <button
              type="button"
              onClick={onOpenAccounts}
              className={cn(
                "mt-2.5 mb-4 inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface py-1 pr-2.5 pl-1",
                "text-left transition-colors hover:border-accent-ring",
              )}
            >
              <span
                className="grid size-6 place-items-center rounded-full text-[10px] font-black"
                style={{
                  backgroundColor: current?.color ?? "var(--accent)",
                  color: current ? accentContrast(current.color) : "var(--accent-contrast)",
                }}
              >
                {current ? current.label[0] : "∀"}
              </span>
              <span className="text-[11.5px] font-bold text-ink">
                {current ? current.label : "Tous les comptes"}
              </span>
              <span
                aria-hidden
                className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-bold text-accent-ink"
              >
                <NumberTicker value={unreadCount} /> non lus
              </span>
              <span className="sr-only">
                {unreadCount} conversation{unreadCount > 1 ? "s" : ""} non lue{unreadCount > 1 ? "s" : ""}
              </span>
              <ChevronDown className="size-3.5 text-ink-muted" />
            </button>
          </motion.div>
        </motion.div>

        <motion.div style={{ height: barSpace }} />

        {folder === "inbox" && (
          <>
            <motion.div
              style={{ height: cardHeight }}
              className="relative mx-5 overflow-hidden rounded-[26px] bg-accent-soft ring-1 ring-accent-ring/40"
            >
              <BorderBeam duration={9} />

              <motion.button
                type="button"
                onClick={collapse}
                aria-label="Réduire le résumé"
                style={{ opacity: cardExpand }}
                className={cn(
                  "absolute top-2.5 right-2.5 z-10 grid size-7 place-items-center rounded-full bg-surface/80 text-accent-ink before:absolute before:-inset-2 before:rounded-full before:content-['']",
                  compact && "pointer-events-none",
                )}
              >
                <ChevronUp className="size-3.5" />
              </motion.button>

              {summary ? (
                <motion.button
                  type="button"
                  onClick={() => void refreshSummary(true)}
                  disabled={summaryLoading}
                  aria-label="Régénérer le résumé"
                  style={{ opacity: cardExpand }}
                  className={cn(
                    "absolute top-2.5 right-11 z-10 grid size-7 place-items-center rounded-full bg-surface/80 text-accent-ink before:absolute before:-inset-2 before:rounded-full before:content-['']",
                    compact && "pointer-events-none",
                  )}
                >
                  <RefreshCw className={cn("size-3.5", summaryLoading && "animate-spin")} />
                </motion.button>
              ) : null}

              <motion.div ref={cardRef} style={{ opacity: cardBody }} className="p-4">
                <div className="flex items-center gap-2 pr-16">
                  <span className="grid size-6 place-items-center rounded-full bg-accent/15">
                    <Sparkles className="size-3.5 text-accent-ink" strokeWidth={2.4} />
                  </span>
                  <p className="text-[10.5px] font-bold tracking-[0.14em] text-accent-ink uppercase">
                    {summary?.period.label ?? "Résumé du matin"}
                  </p>
                  {summary ? (
                    <span
                      data-testid="summary-source-mobile"
                      className="ml-auto rounded-full bg-surface px-2 py-0.5 text-[10px] font-bold text-accent-ink"
                    >
                      {summary.source === "llm" ? "IA" : "local"}
                    </span>
                  ) : null}
                </div>
                {summary ? (
                  <p className="mt-2 text-[12.5px] leading-relaxed font-medium text-ink">
                    {summary.text}
                  </p>
                ) : (
                  <p className="mt-2 text-[12.5px] leading-relaxed font-medium text-ink">
                    <span className="font-bold">
                      {unreadCount} conversation{unreadCount > 1 ? "s" : ""} non lue{unreadCount > 1 ? "s" : ""}
                    </span>{" "}
                    {mode === "api"
                      ? `dans « ${heading} ».`
                      : "dans ta boîte de réception. Camille veut un retour sur les maquettes v3 avant vendredi."}
                  </p>
                )}
                <div className="mt-3 flex gap-1.5">
                  <span className="rounded-full bg-surface px-2.5 py-1 text-[10.5px] font-bold text-accent-ink">
                    {attachmentThreads} conversation{attachmentThreads > 1 ? "s" : ""} avec pièce
                    {attachmentThreads > 1 ? "s" : ""} jointe{attachmentThreads > 1 ? "s" : ""}
                  </span>
                  <span className="rounded-full bg-surface px-2.5 py-1 text-[10.5px] font-bold text-accent-ink">
                    {encryptedCount} chiffré{encryptedCount > 1 ? "s" : ""}
                  </span>
                </div>
              </motion.div>

              <motion.button
                type="button"
                onClick={expand}
                aria-label={`Réafficher le ${(summary?.period.label ?? "Résumé du matin").toLowerCase()}`}
                style={{ opacity: cardCompact }}
                className="absolute inset-0 flex w-full items-center gap-2 px-4 text-left"
              >
                <Sparkles className="size-3.5 shrink-0 text-accent-ink" strokeWidth={2.4} />
                <p className="truncate text-[11px] font-bold text-accent-ink">
                  {summary?.period.label ?? "Résumé du matin"}
                </p>
                <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[10px] font-bold text-accent-ink">
                  {summary ? `${summary.mailCount} mail${summary.mailCount > 1 ? "s" : ""}` : `${unreadCount} non lus`}
                </span>
                <ChevronDown className="ml-auto size-3.5 shrink-0 text-accent-ink/70" />
              </motion.button>
            </motion.div>
          </>
        )}

        <div className="mt-5 flex gap-2 overflow-x-auto px-5 pb-1 no-scrollbar">
          <Chip active={filter === "all"} onClick={() => setFilter("all")}>
            Tous
          </Chip>
          <Chip active={filter === "unread"} onClick={() => setFilter("unread")}>
            Non lus
            <span
              aria-hidden
              className={cn(
                "rounded-full px-1.5 text-[10px] font-bold",
                filter === "unread" ? "bg-ink/10 text-accent-contrast" : "bg-accent-soft text-accent-ink",
              )}
            >
              {unreadCount}
            </span>
            <span className="sr-only">
              {unreadCount} conversation{unreadCount > 1 ? "s" : ""} non lue{unreadCount > 1 ? "s" : ""}
            </span>
          </Chip>
          <Chip active={filter === "starred"} onClick={() => setFilter("starred")}>
            Étoilés
            <span
              aria-hidden
              className={cn(
                "rounded-full px-1.5 text-[10px] font-bold",
                filter === "starred" ? "bg-ink/10 text-accent-contrast" : "bg-accent-soft text-accent-ink",
              )}
            >
              {starredCount}
            </span>
            <span className="sr-only">
              {starredCount} conversation{starredCount > 1 ? "s" : ""} étoilée{starredCount > 1 ? "s" : ""}
            </span>
          </Chip>
          <Chip active={filter === "encrypted"} onClick={() => setFilter("encrypted")}>
            Chiffrés
            <span
              aria-hidden
              className={cn(
                "rounded-full px-1.5 text-[10px] font-bold",
                filter === "encrypted" ? "bg-ink/10 text-accent-contrast" : "bg-accent-soft text-accent-ink",
              )}
            >
              {encryptedCount}
            </span>
            <span className="sr-only">
              {encryptedCount} conversation{encryptedCount > 1 ? "s" : ""} chiffrée{encryptedCount > 1 ? "s" : ""}
            </span>
          </Chip>
        </div>

        <div ref={rowsRef} className="mt-3 space-y-1 px-1">
          {visible.map((thread, index) => (
            <div
              key={thread.id}
              data-mail-row={thread.id}
              tabIndex={-1}
              aria-current={selectedThreadId === thread.id}
              className={cn(
                "rounded-[18px] transition-colors duration-200",
                selectedThreadId === thread.id && "bg-accent-soft ring-1 ring-accent-ring",
              )}
            >
              <ThreadRow
                thread={thread}
                delay={Math.min(0.4, 0.16 + index * 0.05)}
                showAccount={account === ALL_ACCOUNTS}
                onOpen={() => onOpen(thread.primary)}
                onToggleStar={() => onToggleStar(thread.primary.id)}
                onDelete={() => onMailAction("delete", thread.primary)}
                onArchive={() => onMailAction("archive", thread.primary)}
                onToggleRead={() => onMailAction("read", thread.primary)}
                onReply={() => onReply(thread.primary)}
                onNotSpam={onNotSpam ? () => onNotSpam(thread.primary) : undefined}
                onRestore={onRestore ? () => onRestore(thread.primary) : undefined}
              />
            </div>
          ))}
          {threadsLoading && visible.length === 0 && (
            <div className="flex items-center justify-center gap-2 px-6 py-10 text-[12px] font-semibold text-ink-muted">
              <Loader2 className="size-4 animate-spin" />
              Chargement des messages…
            </div>
          )}
          {visible.length === 0 && !threadsLoading && (
            <div className="px-6 py-12 text-center">
              <p className="text-[13px] font-bold text-ink">Aucun message</p>
              <p className="mt-1 text-[11.5px] leading-relaxed font-medium text-ink-muted">
                {filter !== "all"
                  ? "Aucune conversation ne correspond à ce filtre."
                  : mode === "api"
                    ? "Ce dossier est vide. Lance une synchronisation pour récupérer les messages du serveur."
                    : "Rien ici pour le moment."}
              </p>
              {filter !== "all" && (
                <button
                  type="button"
                  onClick={() => setFilter("all")}
                  className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-2 text-[12px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
                >
                  <RotateCcw className="size-3.5" />
                  Réinitialiser le filtre
                </button>
              )}
              {filter === "all" && mode === "api" && (
                <button
                  type="button"
                  onClick={syncFolder}
                  disabled={syncing}
                  className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-full bg-accent px-3.5 py-2 text-[12px] font-bold text-accent-contrast transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={cn("size-3.5", syncing && "animate-spin")} />
                  Synchroniser
                </button>
              )}
            </div>
          )}
          {mode === "api" && hasMore && !threadsLoading && (
            <div className="flex justify-center py-4">
              <button
                type="button"
                onClick={loadMore}
                className="focus-ring inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-3.5 py-2 text-[12px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
              >
                Charger plus
              </button>
            </div>
          )}
        </div>
      </div>

      <motion.div
        ref={barRef}
        style={{ opacity: barOpacity, y: barY }}
        className={cn("absolute inset-x-0 top-0 z-30", compact ? "" : "pointer-events-none")}
      >
        <div className="glass flex items-center gap-2.5 border-b border-line/70 px-4 pt-2.5 pb-2">
          <IconButton
            aria-label="Ouvrir les dossiers"
            onClick={onOpenFolders}
            className="bg-accent-soft text-accent-ink hover:bg-accent-soft"
          >
            <Inbox className="size-[18px]" strokeWidth={2.2} />
          </IconButton>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[12.5px] font-bold text-ink">{heading}</p>
            <p className="truncate text-[10px] font-semibold text-ink-muted">
              {threads.length} conversation{threads.length > 1 ? "s" : ""} · {unreadCount} non lues ·{" "}
              {folderStats("spam").unread} spam
            </p>
          </div>
          <IconButton aria-label="Rechercher" onClick={onSearch}>
            <Search className="size-4" />
          </IconButton>
          <IconButton aria-label="Changer de compte" onClick={onOpenAccounts}>
            <span
              className="grid size-5 place-items-center rounded-full text-[10px] font-black"
              style={{
                backgroundColor: current?.color ?? "var(--accent)",
                color: current ? accentContrast(current.color) : "var(--accent-contrast)",
              }}
            >
              {current ? current.label[0] : "∀"}
            </span>
          </IconButton>
        </div>
      </motion.div>
    </div>
  );
}

export function AccountSwitchSheet({
  active,
  onSelect,
  onClose,
}: {
  active: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { accounts, mode, openConnect, accountUnread } = useMailStore();
  const rows = [
    ...(mode === "demo" || accounts.length > 1
      ? [
          {
            id: ALL_ACCOUNTS,
            label: "Tous les comptes",
            email: "Boîte unifiée",
            color: "var(--accent)",
            glyph: "∀",
          },
        ]
      : []),
    ...accounts.map((account) => ({
      id: account.id,
      label: account.label,
      email: account.email,
      color: account.color,
      glyph: account.label[0] ?? "?",
    })),
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-line" />
      <div className="flex items-baseline justify-between px-5 pt-3 pb-2">
        <h2 className="text-[15px] font-bold tracking-tight text-ink">Comptes</h2>
        <button type="button" onClick={onClose} className="text-[11.5px] font-bold text-accent-ink">
          Fermer
        </button>
      </div>

      <div className="flex-1 space-y-1.5 overflow-y-auto no-scrollbar px-3 pb-4">
        {rows.map((row) => {
          const isActive = row.id === active;
          const unread = accountUnread(row.id);
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => {
                onSelect(row.id);
                onClose();
              }}
              className={cn(
                "flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors",
                isActive ? "bg-accent-soft ring-1 ring-accent-ring/60" : "hover:bg-surface-2",
              )}
            >
              <span
                className="grid size-9 shrink-0 place-items-center rounded-xl text-[12px] font-black"
                style={{ backgroundColor: row.color, color: accentContrast(row.color) }}
              >
                {row.glyph}
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-[13px] font-bold text-ink">{row.label}</span>
                <span className="block truncate text-[11px] font-medium text-ink-muted">{row.email}</span>
              </span>
              {unread > 0 && (
                <span className="rounded-full bg-accent px-2 py-0.5 text-[10.5px] font-bold text-accent-contrast">
                  {unread}
                </span>
              )}
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => {
            onClose();
            openConnect();
          }}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line py-3 text-[12.5px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
        >
          <Plus className="size-4" />
          Ajouter un compte
        </button>
      </div>
    </div>
  );
}

const FOLDER_ICONS = {
  inbox: Inbox,
  sent: Send,
  drafts: PenLine,
  archive: Archive,
  spam: ShieldAlert,
  trash: Trash2,
  other: Inbox,
} as const;

export function MailboxSheet({
  folder,
  onSelect,
  onClose,
}: {
  folder: FolderId;
  onSelect: (id: FolderId, path: string | null) => void;
  onClose: () => void;
}) {
  const { folderOptions, folderPath, emptyTrash, folderStats } = useMailStore();
  const trashCount = folderStats("trash").total;

  return (
    <div className="flex h-full flex-col">
      <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-line" />
      <div className="flex items-baseline justify-between px-5 pt-3 pb-2">
        <h2 className="text-[15px] font-bold tracking-tight text-ink">Dossiers</h2>
        <button type="button" onClick={onClose} className="text-[11.5px] font-bold text-accent-ink">
          Fermer
        </button>
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto no-scrollbar px-3 pb-4">
        {folderOptions.map((entry) => {
          const Icon = FOLDER_ICONS[entry.id];
          const stats = folderStats(entry.id, entry.path);
          const isActive = entry.id === folder && (entry.id !== "other" || entry.path === folderPath);
          return (
            <button
              key={`${entry.id}:${entry.path}`}
              type="button"
              onClick={() => {
                onSelect(entry.id, entry.id === "other" ? entry.path : null);
                onClose();
              }}
              className={cn(
                "flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors",
                isActive ? "bg-accent-soft ring-1 ring-accent-ring/60" : "hover:bg-surface-2",
              )}
            >
              <span
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-xl",
                  isActive ? "bg-surface text-accent-ink" : "bg-surface-2 text-ink-soft",
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-ink">{entry.label}</span>
              <span className="shrink-0 text-[10.5px] font-semibold text-ink-muted">{stats.total}</span>
              {stats.unread > 0 && (
                <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[10.5px] font-bold text-accent-contrast">
                  {stats.unread}
                </span>
              )}
            </button>
          );
        })}

        {trashCount > 0 && (
          <div className="pt-1">
            <EmptyTrashButton count={trashCount} onConfirm={emptyTrash} variant="mobile" />
          </div>
        )}
      </div>
    </div>
  );
}
