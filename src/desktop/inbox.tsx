import { useState } from "react";
import {
  Archive,
  BellRing,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CornerUpLeft,
  CornerUpRight,
  Forward,
  Inbox,
  Lock,
  Mail as MailIcon,
  MailOpen,
  Moon,
  Paperclip,
  PenLine,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { FolderId, Mail } from "@/lib/mail";
import { FOLDERS, folderLabel } from "@/lib/mail";
import type { Thread } from "@/lib/threads";
import { threadsInFolder } from "@/lib/threads";
import { ACCOUNTS, ALL_ACCOUNTS, accountById } from "@/lib/accounts";
import { MY_KEY, PGP_STATE, keyState } from "@/lib/pgp";
import { useMailStore } from "@/lib/store";
import { useEscapeLayer } from "@/desktop/escape";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/primitives";
import { BlurFade } from "@/components/ui/blur-fade";
import { BorderBeam } from "@/components/ui/border-beam";
import { NumberTicker } from "@/components/ui/number-ticker";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import {
  Badge,
  DButton,
  DChip,
  DIconButton,
  EmptyState,
  Kbd,
  PaneTitle,
  SectionLabel,
  Surface,
  TextInput,
} from "@/desktop/ui";

type Filter = "all" | "unread" | "starred" | "encrypted" | "attachments";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Tous" },
  { id: "unread", label: "Non lus" },
  { id: "starred", label: "Étoilés" },
  { id: "encrypted", label: "Chiffrés" },
  { id: "attachments", label: "Fichiers" },
];

const FILTER_MATCH: Record<Filter, (thread: Thread) => boolean> = {
  all: () => true,
  unread: (thread) => thread.unread > 0,
  starred: (thread) => thread.starred,
  encrypted: (thread) => thread.encrypted > 0,
  attachments: (thread) => thread.attachments > 0,
};

const FOLDER_ICONS: Record<FolderId, LucideIcon> = {
  inbox: Inbox,
  sent: Forward,
  archive: Archive,
  spam: ShieldCheck,
  trash: Trash2,
};

const ACCOUNT_TONE: Record<Mail["account"], "accent" | "sky" | "rose"> = {
  perso: "accent",
  pro: "sky",
  gmail: "rose",
};

const EMPTY_ACCOUNT = { label: "", email: "", provider: "" };

const TO_DO = 3;

const SUMMARY_ACTIONS: { label: string; hint: string; icon: LucideIcon; target: string }[] = [
  { label: "Répondre à Camille", hint: "Maquettes mobiles — version 3", icon: CornerUpLeft, target: "1" },
  { label: "Valider la v3", hint: "avant vendredi", icon: CheckCircle2, target: "1" },
  { label: "Relancer Marc", hint: "accès serveur", icon: BellRing, target: "3" },
];

type QuickAction = { label: string; icon: LucideIcon; filled?: boolean; run: () => void };

function ActionIcon({ action, size }: { action: QuickAction; size: string }) {
  return <action.icon className={cn(size, action.filled && "fill-amber-400 text-amber-400")} />;
}

function RailItem({
  active,
  icon,
  label,
  count,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active}
      className={cn(
        "focus-ring flex h-9 w-full items-center gap-2.5 rounded-[11px] px-2.5 text-[12.5px] font-semibold transition-colors duration-200",
        active ? "bg-accent-soft text-accent-ink" : "text-ink-soft hover:bg-surface-2 hover:text-ink",
      )}
    >
      <span className="grid w-4 shrink-0 place-items-center">{icon}</span>
      <span className="truncate">{label}</span>
      {count > 0 ? (
        <span
          className={cn(
            "ml-auto rounded-full px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums",
            active ? "bg-surface text-accent-ink" : "bg-surface-2 text-ink-muted",
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

function MorningSummary({
  open,
  unread,
  attachments,
  encrypted,
  onToggle,
  onOpen,
}: {
  open: boolean;
  unread: number;
  attachments: number;
  encrypted: number;
  onToggle: () => void;
  onOpen: (id: string) => void;
}) {
  if (!open) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label="Déplier le résumé du matin"
        className="focus-ring flex h-[52px] w-full items-center gap-2 rounded-full border border-accent-ring/60 bg-accent-soft px-4 text-[11.5px] font-bold text-accent-ink transition-colors duration-200 hover:border-accent-ring"
      >
        <Sparkles className="size-4 shrink-0" strokeWidth={2.4} />
        <span className="truncate">Résumé du matin · {TO_DO} à traiter</span>
        <ChevronDown className="ml-auto size-4 shrink-0" />
      </button>
    );
  }

  return (
    <div
      data-testid="morning-summary"
      className="relative overflow-hidden rounded-[20px] border border-accent-ring/60 bg-[linear-gradient(105deg,var(--surface),var(--accent-soft))]"
    >
      <BorderBeam duration={9} />

      <div className="relative px-4 pt-3 pb-1">
        <div className="flex items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-accent text-accent-contrast">
            <Sparkles className="size-4" strokeWidth={2.4} />
          </span>
          <p className="min-w-0 truncate text-[11px] font-bold tracking-[0.16em] text-accent-ink uppercase">
            Résumé du matin
          </p>
          <span className="shrink-0 text-[11px] font-semibold text-ink-muted">
            <NumberTicker value={unread} /> non lus
          </span>
          <span className="ml-auto shrink-0 rounded-full border border-accent-ring/60 bg-surface/80 px-2 py-0.5 text-[10px] font-bold text-accent-ink">
            {TO_DO} à traiter
          </span>
          <DIconButton label="Replier le résumé du matin" onClick={onToggle} className="size-7">
            <ChevronUp className="size-4" />
          </DIconButton>
        </div>

        <p className="mt-1 line-clamp-2 text-[12.5px] leading-[1.55] font-medium text-ink-soft">
          <span className="font-bold text-ink">{unread} conversations non lues</span>, {attachments} avec des pièces
          jointes, {encrypted} chiffrées. Camille attend un retour sur la v3 avant vendredi.
        </p>
      </div>

      <div className="relative divide-y divide-accent-ring/20 border-t border-accent-ring/20">
        {SUMMARY_ACTIONS.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={() => onOpen(action.target)}
            aria-label={`${action.label} — ${action.hint}`}
            className="focus-ring flex h-9 w-full items-center gap-2.5 px-4 text-left transition-colors duration-200 hover:bg-surface/70"
          >
            <action.icon className="size-4 shrink-0 text-accent-ink" strokeWidth={2.4} />
            <span className="shrink-0 text-[12px] font-bold text-ink">{action.label}</span>
            <span className="truncate text-[10.5px] font-semibold text-ink-muted/80">{action.hint}</span>
            <ChevronRight className="ml-auto size-3.5 shrink-0 text-ink-muted" />
          </button>
        ))}
      </div>
    </div>
  );
}

function ThreadRow({
  thread,
  selected,
  delay,
  onOpen,
  onStar,
  onRead,
  onArchive,
  onDelete,
  onRestore,
  onNotSpam,
}: {
  thread: Thread;
  selected: boolean;
  delay: number;
  onOpen: () => void;
  onStar: () => void;
  onRead: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onNotSpam: () => void;
}) {
  const mail = thread.primary;
  const account = accountById(mail.account);
  const sender = mail.folder === "sent" && mail.to ? `À ${mail.to}` : mail.name;
  const name =
    thread.count > 1 && thread.participants.length
      ? `${thread.participants.slice(0, 2).join(", ")}${
          thread.participants.length > 2 ? ` +${thread.participants.length - 2}` : ""
        }`
      : sender;
  const unread = thread.unread > 0;

  const quick: QuickAction[] = [
    {
      label: thread.starred ? "Retirer l'étoile" : "Marquer d'une étoile",
      icon: Star,
      filled: thread.starred,
      run: onStar,
    },
    {
      label: unread ? "Marquer comme lu" : "Marquer comme non lu",
      icon: unread ? MailOpen : MailIcon,
      run: onRead,
    },
    mail.folder === "spam"
      ? { label: "Non spam", icon: ShieldCheck, run: onNotSpam }
      : mail.folder === "trash" || mail.folder === "archive"
        ? { label: "Restaurer", icon: RotateCcw, run: onRestore }
        : { label: "Archiver", icon: Archive, run: onArchive },
    {
      label: mail.folder === "trash" ? "Supprimer définitivement" : "Supprimer",
      icon: Trash2,
      run: onDelete,
    },
  ];

  return (
    <BlurFade delay={delay} yOffset={10}>
      <div
        className={cn(
          "group relative rounded-[16px] transition-colors duration-200",
          selected ? "bg-accent-soft ring-1 ring-accent-ring" : "hover:bg-surface-2",
        )}
      >
        <button
          type="button"
          onClick={onOpen}
          aria-current={selected}
          aria-label={`${name} — ${thread.subject}${thread.count > 1 ? ` · ${thread.count} messages` : ""}${
            unread ? " · non lu" : ""
          }`}
          className="focus-ring absolute inset-0 rounded-[16px]"
        />

        <div className="pointer-events-none relative flex gap-3 px-3 py-3.5">
          <Avatar name={name} tone={mail.tone} size={40} rounded="rounded-full" />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <p
                className={cn(
                  "min-w-0 truncate text-[13px] leading-tight",
                  unread ? "font-extrabold text-ink" : "font-semibold text-ink-soft",
                )}
              >
                {name}
              </p>
              {account ? <Badge tone={ACCOUNT_TONE[mail.account]}>{account.label}</Badge> : null}
              {mail.pgp === "encrypted" ? (
                <Lock className="size-3.5 shrink-0 text-emerald-600" strokeWidth={2.6} />
              ) : mail.pgp === "signed" ? (
                <ShieldCheck className="size-3.5 shrink-0 text-sky-500" strokeWidth={2.6} />
              ) : null}
              <span className="ml-auto shrink-0 text-[11px] font-bold tabular-nums text-ink-muted">{thread.time}</span>
            </div>

            <p
              className={cn(
                "mt-1 truncate text-[13px] text-ink",
                unread ? "font-bold" : "font-semibold",
              )}
            >
              {thread.subject}
            </p>

            <p className="mt-1 line-clamp-3 text-[12.5px] leading-[1.5] text-ink-muted">{thread.preview}</p>

            {thread.count > 1 || thread.attachments > 0 ? (
              <div className="mt-1.5 flex items-center gap-1">
                {thread.count > 1 ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold text-ink-soft">
                    {thread.count} messages
                  </span>
                ) : null}
                {thread.attachments > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold text-ink-soft">
                    <Paperclip className="size-2.5" />
                    {thread.attachments}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div
          className={cn(
            "glass absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-full p-0.5",
            "pointer-events-none opacity-0 transition-opacity duration-200",
            "group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100",
          )}
        >
          {quick.map((action) => (
            <DIconButton key={action.label} label={action.label} onClick={action.run} className="size-6">
              <ActionIcon action={action} size="size-3.5" />
            </DIconButton>
          ))}
        </div>
      </div>
    </BlurFade>
  );
}

export function DesktopInbox({ onOpenSearch }: { onOpenSearch: () => void }) {
  const {
    mails,
    account,
    folder,
    openMail,
    openThread,
    setAccount,
    setFolder,
    toggleStar,
    mailAction,
    moveToInbox,
    restoreMail,
    openMessage,
    closeMessage,
    replyTo,
    forwardMail,
    notify,
  } = useMailStore();
  const { dark, setDark } = useTheme();
  const [filter, setFilter] = useState<Filter>("all");
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_ACCOUNT);
  const [collapsedPrevious, setCollapsedPrevious] = useState<string[]>([]);

  useEscapeLayer(addOpen || Boolean(openMail), () => {
    if (addOpen) setAddOpen(false);
    else closeMessage();
  });

  const threads = threadsInFolder(mails, folder, account);
  const visible = threads.filter(FILTER_MATCH[filter]);
  const unreadCount = mails.filter(
    (mail) => mail.folder === folder && mail.unread && (account === ALL_ACCOUNTS || mail.account === account),
  ).length;
  const unreadThreads = threads.filter((thread) => thread.unread > 0).length;
  const attachmentThreads = threads.filter((thread) => thread.attachments > 0).length;
  const encryptedThreads = threads.filter((thread) => thread.encrypted > 0).length;

  const unreadFor = (id: string) =>
    mails.filter((mail) => mail.folder === "inbox" && mail.unread && (id === ALL_ACCOUNTS || mail.account === id))
      .length;
  const countFor = (id: FolderId) =>
    mails.filter(
      (mail) =>
        mail.folder === id && (account === ALL_ACCOUNTS || mail.account === account) && (id !== "inbox" || mail.unread),
    ).length;

  const openById = (id: string) => {
    const mail = mails.find((entry) => entry.id === id);
    if (mail) openMessage(mail);
  };

  const submitAccount = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    notify("Compte ajouté — maquette");
    setForm(EMPTY_ACCOUNT);
    setAddOpen(false);
  };

  const pgpState = keyState(MY_KEY);
  const pgpTone: "green" | "amber" | "rose" = pgpState === "valid" ? "green" : pgpState === "expired" ? "amber" : "rose";

  const mail = openMail;
  const previous = openThread && mail ? openThread.messages.filter((message) => message.id !== mail.id) : [];
  const allExpanded = previous.every((message) => !collapsedPrevious.includes(message.id));

  const togglePrevious = (id: string) =>
    setCollapsedPrevious((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  const toggleAllPrevious = () =>
    setCollapsedPrevious(allExpanded ? previous.map((message) => message.id) : []);

  const readerActions: QuickAction[] = mail
    ? [
        {
          label: mail.starred ? "Retirer l'étoile" : "Marquer d'une étoile",
          icon: Star,
          filled: mail.starred,
          run: () => toggleStar(mail.id),
        },
        mail.folder === "spam"
          ? {
              label: "Non spam",
              icon: ShieldCheck,
              run: () => {
                moveToInbox(mail);
                closeMessage();
              },
            }
          : mail.folder === "archive" || mail.folder === "trash"
            ? {
                label: "Restaurer",
                icon: RotateCcw,
                run: () => {
                  restoreMail(mail);
                  closeMessage();
                },
              }
            : {
                label: "Archiver",
                icon: Archive,
                run: () => {
                  mailAction("archive", mail);
                  closeMessage();
                },
              },
        {
          label: mail.folder === "trash" ? "Supprimer définitivement" : "Supprimer",
          icon: Trash2,
          run: () => {
            mailAction("delete", mail);
            closeMessage();
          },
        },
      ]
    : [];

  const renderAction = (action: QuickAction) => (
    <DIconButton key={action.label} label={action.label} onClick={action.run}>
      <ActionIcon action={action} size="size-4" />
    </DIconButton>
  );

  return (
    <>
      <div className="grid h-full min-h-0 grid-cols-[248px_420px_minmax(0,1fr)]" data-testid="desktop-inbox">
        <aside className="flex min-h-0 flex-col border-r border-line">
          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2.5 pt-4 pb-[104px]">
            <div className="flex min-h-full flex-col">
              <div className="flex items-center gap-2 px-1.5">
                <span
                  aria-hidden
                  className="size-[22px] rounded-[8px] bg-gradient-to-br from-accent-ring to-accent shadow-[0_7px_16px_-7px_var(--accent)]"
                />
                <p className="text-[15px] font-extrabold tracking-[-0.035em] text-ink">Lavande</p>
                <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold text-accent-ink">PC</span>
                <DIconButton
                  label={dark ? "Passer en thème clair" : "Passer en thème sombre"}
                  onClick={() => setDark(!dark)}
                  className="ml-auto size-7"
                >
                  {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
                </DIconButton>
              </div>

              <SectionLabel className="mt-4 mb-1.5 px-2.5">Comptes</SectionLabel>
              <div className="space-y-0.5">
                <RailItem
                  active={account === ALL_ACCOUNTS}
                  onClick={() => setAccount(ALL_ACCOUNTS)}
                  label="Tous les comptes"
                  count={unreadFor(ALL_ACCOUNTS)}
                  icon={<span className="size-2 rounded-full bg-accent" />}
                />
                {ACCOUNTS.map((entry) => (
                  <RailItem
                    key={entry.id}
                    active={account === entry.id}
                    onClick={() => setAccount(entry.id)}
                    label={entry.label}
                    count={unreadFor(entry.id)}
                    icon={<span className="size-2 rounded-full" style={{ backgroundColor: entry.color }} />}
                  />
                ))}
                <button
                  type="button"
                  onClick={() => setAddOpen(true)}
                  className="focus-ring flex h-9 w-full items-center gap-2.5 rounded-[11px] px-2.5 text-[12.5px] font-semibold text-ink-muted transition-colors duration-200 hover:bg-surface-2 hover:text-ink"
                >
                  <span className="grid w-4 shrink-0 place-items-center">
                    <PenLine className="size-4" />
                  </span>
                  <span className="truncate">Ajouter un compte</span>
                </button>
              </div>

              <SectionLabel className="mt-4 mb-1.5 px-2.5">Dossiers</SectionLabel>
              <div className="space-y-0.5">
                {FOLDERS.map((entry) => {
                  const Icon = FOLDER_ICONS[entry.id];
                  return (
                    <RailItem
                      key={entry.id}
                      active={folder === entry.id}
                      onClick={() => setFolder(entry.id)}
                      label={entry.label}
                      count={countFor(entry.id)}
                      icon={<Icon className="size-4" />}
                    />
                  );
                })}
              </div>

              <div className="mt-auto pt-4">
                <div className="rounded-[16px] border border-line bg-surface-2/60 p-2.5">
                  <div className="flex items-center gap-1.5">
                    <Lock className="size-3.5 shrink-0 text-accent-ink" strokeWidth={2.6} />
                    <p className="text-[11px] font-bold text-ink">PGP</p>
                    <Badge tone={pgpTone} className="ml-auto">
                      {PGP_STATE[pgpState].label}
                    </Badge>
                  </div>
                  <p className="mt-1.5 truncate text-[10.5px] font-semibold text-ink-muted">
                    {MY_KEY.name} · <span className="tabular-nums">{MY_KEY.fingerprint.slice(-9)}</span>
                  </p>
                  <p className="mt-0.5 text-[10px] font-medium text-ink-muted">Expire le {MY_KEY.expires}</p>
                  {pgpState !== "valid" ? (
                    <p
                      className={cn(
                        "mt-1.5 text-[10px] font-semibold",
                        pgpTone === "amber" ? "text-amber-700" : "text-rose-600",
                      )}
                    >
                      {PGP_STATE[pgpState].hint}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </aside>

        <section className="flex min-h-0 flex-col border-r border-line">
          <div className="shrink-0 px-4 pt-4 pb-2">
            <PaneTitle
              hint={
                folder === "inbox" ? (
                  <>
                    <NumberTicker value={unreadCount} /> non lus
                  </>
                ) : (
                  `${visible.length} conversation${visible.length > 1 ? "s" : ""}`
                )
              }
            >
              {folderLabel(folder)}
            </PaneTitle>

            <button
              type="button"
              onClick={onOpenSearch}
              aria-label="Ouvrir la recherche globale"
              className="focus-ring mt-3 flex h-9 w-full items-center gap-2 rounded-full border border-line bg-surface-2 px-3 text-[12px] font-semibold text-ink-muted transition-colors duration-200 hover:border-accent-ring hover:text-ink-soft"
            >
              <Search className="size-3.5 shrink-0" />
              <span className="truncate">Rechercher dans tous les mails…</span>
              <span className="ml-auto shrink-0">
                <Kbd>⌘K</Kbd>
              </span>
            </button>

            <div className="mt-2.5 flex flex-wrap gap-1.5 pb-1">
              {FILTERS.map((entry) => (
                <DChip key={entry.id} active={filter === entry.id} onClick={() => setFilter(entry.id)}>
                  {entry.label}
                </DChip>
              ))}
            </div>
          </div>

          {folder === "inbox" ? (
            <div className="shrink-0 px-4">
              <MorningSummary
                open={summaryOpen}
                unread={unreadThreads}
                attachments={attachmentThreads}
                encrypted={encryptedThreads}
                onToggle={() => setSummaryOpen(!summaryOpen)}
                onOpen={openById}
              />
            </div>
          ) : null}

          <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-[104px]">
            {visible.map((thread, index) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                selected={mail !== null && thread.messages.some((message) => message.id === mail.id)}
                delay={Math.min(0.4, 0.06 + index * 0.04)}
                onOpen={() => openMessage(thread.primary)}
                onStar={() => toggleStar(thread.primary.id)}
                onRead={() => mailAction("read", thread.primary)}
                onArchive={() => mailAction("archive", thread.primary)}
                onDelete={() => mailAction("delete", thread.primary)}
                onRestore={() => restoreMail(thread.primary)}
                onNotSpam={() => moveToInbox(thread.primary)}
              />
            ))}

            {visible.length === 0 ? (
              <div className="px-3 py-8">
                <EmptyState
                  icon={<MailIcon className="size-5" />}
                  title="Aucun message ici"
                  hint={
                    filter === "all"
                      ? "Cette boîte est vide pour le compte sélectionné."
                      : "Aucune conversation ne correspond à ce filtre."
                  }
                />
                {filter !== "all" ? (
                  <div className="mt-3 flex justify-center">
                    <DButton size="sm" variant="ghost" onClick={() => setFilter("all")}>
                      <RotateCcw className="size-3.5" />
                      Réinitialiser le filtre
                    </DButton>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>

        <section className="flex min-h-0 flex-col">
          {mail ? (
            <>
              <div className="sticky top-0 z-20 shrink-0">
                <header className="flex items-start gap-3 bg-surface/85 px-8 pt-4 pb-3 backdrop-blur">
                  <div className="min-w-0 flex-1">
                    <h1 className="text-[24px] leading-[1.22] font-extrabold tracking-[-0.035em] text-ink">
                      {mail.subject}
                    </h1>
                    <p className="mt-1 truncate text-[12px] font-semibold text-ink-muted">
                      {folderLabel(mail.folder)}
                      {openThread && openThread.count > 1 ? ` · ${openThread.count} messages` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">{readerActions.map(renderAction)}</div>
                </header>

                <div className="flex items-center gap-2 border-b border-line bg-surface/70 px-5 py-2.5 backdrop-blur">
                  <ShimmerButton
                    size="sm"
                    onClick={() => replyTo(mail)}
                    shimmerDuration={4}
                    className="h-8 rounded-lg px-3 text-[12px]"
                  >
                    <CornerUpLeft className="size-3.5" />
                    Répondre
                  </ShimmerButton>
                  <DButton variant="ghost" size="sm" onClick={() => forwardMail(mail)}>
                    <CornerUpRight className="size-3.5" />
                    Transférer
                  </DButton>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6 pb-[120px]">
                <BlurFade yOffset={6}>
                  <div className="flex items-center gap-3">
                    <Avatar
                      name={mail.folder === "sent" ? "Moi" : mail.name}
                      tone={mail.tone}
                      size={44}
                      rounded="rounded-full"
                    />
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[14px] font-extrabold text-ink">
                          {mail.folder === "sent" ? "Moi" : mail.name}
                        </p>
                        {accountById(mail.account) ? (
                          <Badge tone={ACCOUNT_TONE[mail.account]}>{accountById(mail.account)?.label}</Badge>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate text-[12px] font-medium text-ink-muted">
                        {mail.folder === "sent" ? `à ${mail.to ?? "destinataire"}` : mail.email} ·{" "}
                        {mail.date ?? mail.time}
                      </p>
                    </div>
                  </div>

                  {mail.pgp !== "none" ? (
                    <div className="mt-3.5 flex items-center gap-2.5 rounded-[14px] border border-emerald-500/25 bg-emerald-500/10 px-3.5 py-2.5 text-emerald-700">
                      {mail.pgp === "encrypted" ? (
                        <Lock className="size-4 shrink-0" strokeWidth={2.6} />
                      ) : (
                        <ShieldCheck className="size-4 shrink-0" strokeWidth={2.6} />
                      )}
                      <p className="text-[12.5px] font-semibold">
                        {mail.pgp === "encrypted" ? "Chiffré de bout en bout" : "Signature vérifiée"} ·{" "}
                        <span className="tabular-nums">{MY_KEY.fingerprint.slice(-9)}</span>
                      </p>
                    </div>
                  ) : null}

                  {mail.attachments?.length ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {mail.attachments.map((file) => (
                        <div
                          key={file.name}
                          className="flex items-center gap-2.5 rounded-[14px] border border-line bg-surface px-3.5 py-2.5"
                        >
                          <Paperclip className="size-3.5 shrink-0 text-ink-muted" />
                          <span className="text-[12.5px] font-semibold text-ink-soft">{file.name}</span>
                          <span className="text-[11px] font-semibold text-ink-muted">{file.size}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <div className="mt-6 max-w-[80ch] space-y-3.5">
                    {mail.body.map((paragraph, index) => (
                      <p
                        key={index}
                        className="text-[14.5px] leading-[1.78] font-medium whitespace-pre-line text-ink-soft"
                      >
                        {paragraph}
                      </p>
                    ))}
                  </div>

                  {previous.length > 0 ? (
                    <div className="mt-7 border-t border-line pt-4">
                      <div className="flex items-center gap-2">
                        <SectionLabel>
                          {previous.length} message{previous.length > 1 ? "s" : ""} antérieur
                          {previous.length > 1 ? "s" : ""}
                        </SectionLabel>
                        <button
                          type="button"
                          onClick={toggleAllPrevious}
                          aria-label={allExpanded ? "Tout replier les messages antérieurs" : "Tout déplier les messages antérieurs"}
                          className="focus-ring ml-auto rounded-full px-2 py-0.5 text-[11px] font-bold text-ink-muted transition-colors duration-200 hover:bg-surface-2 hover:text-ink"
                        >
                          {allExpanded ? "Tout replier" : "Tout déplier"}
                        </button>
                      </div>

                      <div className="mt-2.5 space-y-2.5">
                        {previous.map((message) => {
                          const expanded = !collapsedPrevious.includes(message.id);
                          const who = message.folder === "sent" ? "Moi" : message.name;
                          return (
                            <div
                              key={message.id}
                              className="overflow-hidden rounded-[18px] border border-line bg-surface"
                            >
                              <button
                                type="button"
                                onClick={() => togglePrevious(message.id)}
                                aria-expanded={expanded}
                                aria-label={
                                  expanded ? `Replier le message de ${who}` : `Déplier le message de ${who}`
                                }
                                className="focus-ring flex w-full items-center gap-2.5 px-4 py-2.5 text-left"
                              >
                                <Avatar name={who} tone={message.tone} size={32} rounded="rounded-full" />
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-center gap-1.5">
                                    <span className="truncate text-[12.5px] font-bold text-ink">{who}</span>
                                    {accountById(message.account) ? (
                                      <Badge tone={ACCOUNT_TONE[message.account]}>
                                        {accountById(message.account)?.label}
                                      </Badge>
                                    ) : null}
                                    {message.pgp === "encrypted" ? (
                                      <Lock className="size-3 shrink-0 text-emerald-600" strokeWidth={2.6} />
                                    ) : message.pgp === "signed" ? (
                                      <ShieldCheck className="size-3 shrink-0 text-sky-500" strokeWidth={2.6} />
                                    ) : null}
                                    <span className="ml-auto shrink-0 text-[11.5px] font-semibold text-ink-muted">
                                      {message.date ?? message.time}
                                    </span>
                                  </span>
                                </span>
                                <ChevronDown
                                  className={cn(
                                    "size-4 shrink-0 text-ink-muted transition-transform duration-300",
                                    expanded && "rotate-180",
                                  )}
                                />
                              </button>

                              {expanded ? (
                                <div className="max-w-[78ch] space-y-2.5 px-4 pb-4">
                                  {message.body.map((paragraph, index) => (
                                    <p
                                      key={index}
                                      className="text-[13.5px] leading-[1.7] font-medium whitespace-pre-line text-ink-soft"
                                    >
                                      {paragraph}
                                    </p>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </BlurFade>
              </div>
            </>
          ) : (
            <div className="min-h-0 flex-1">
              <EmptyState
                icon={<MailIcon className="size-5" />}
                title="Sélectionne un message"
                hint="La conversation s'ouvre ici, sans quitter ta boîte."
              />
            </div>
          )}
        </section>
      </div>

      {addOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Ajouter un compte"
          className="absolute inset-0 z-40 grid place-items-center bg-ink/25 p-6"
        >
          <Surface className="w-[330px] p-5 shadow-[0_30px_70px_-40px_var(--accent)]">
            <form onSubmit={submitAccount} className="space-y-2.5">
              <SectionLabel>Ajouter un compte</SectionLabel>
              <TextInput
                aria-label="Libellé"
                placeholder="Libellé — ex. Travail"
                value={form.label}
                onChange={(event) => setForm({ ...form, label: event.target.value })}
                required
              />
              <TextInput
                aria-label="Adresse e-mail"
                type="email"
                placeholder="prenom@exemple.fr"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
                required
              />
              <TextInput
                aria-label="Fournisseur"
                placeholder="Fournisseur — IMAP, OAuth…"
                value={form.provider}
                onChange={(event) => setForm({ ...form, provider: event.target.value })}
              />
              <div className="flex gap-2 pt-1">
                <DButton type="button" variant="ghost" className="flex-1" onClick={() => setAddOpen(false)}>
                  Annuler
                </DButton>
                <DButton type="submit" variant="primary" className="flex-1">
                  Ajouter
                </DButton>
              </div>
            </form>
          </Surface>
        </div>
      ) : null}
    </>
  );
}
