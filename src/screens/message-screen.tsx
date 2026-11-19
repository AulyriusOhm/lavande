import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  Archive,
  ChevronDown,
  ChevronRight,
  CornerUpLeft,
  CornerUpRight,
  Download,
  Loader2,
  Lock,
  Paperclip,
  PenLine,
  RotateCcw,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import { downloadAttachment } from "@/lib/attachments";
import type { Mail, MailAttachment } from "@/lib/mail";
import { folderLabel } from "@/lib/mail";
import { messagePgpStatus } from "@/lib/pgp";
import { resolvePgp, usePrefs } from "@/lib/prefs";
import type { Thread } from "@/lib/threads";
import { cn } from "@/lib/utils";
import { Avatar, IconButton } from "@/components/ui/primitives";
import { BlurFade } from "@/components/ui/blur-fade";
import { MailBody, MailBodyLoading } from "@/components/mail-body";
import { MailRecipients } from "@/components/mail-recipients";
import { PgpNotice, PgpStatusBadge } from "@/components/ui/pgp-badge";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { MeshGlow } from "@/components/ui/backdrops";

export function MessageScreen({
  thread,
  onClose,
  onToggleStar,
  onReply,
  onForward,
  onAnalyse,
  onResume,
  onArchive,
  onDelete,
  onNotSpam,
  onRestore,
  onOpenPgp,
  onFetchBody,
  bodyFetching = null,
  readOnly = false,
}: {
  thread: Thread;
  onClose: () => void;
  onToggleStar: () => void;
  onReply: (mail: Mail) => void;
  onForward?: (mail: Mail) => void;
  /** Analyse à la demande du mail ouvert. */
  onAnalyse?: (mail: Mail) => void;
  onResume?: (mail: Mail) => void;
  onArchive?: (mail: Mail) => void;
  onDelete?: (mail: Mail) => void;
  onNotSpam?: (mail: Mail) => void;
  onRestore?: (mail: Mail) => void;
  onOpenPgp?: () => void;
  /** Lit le corps d'un message antérieur déplié, resté en-têtes seuls. */
  onFetchBody?: (mail: Mail) => void;
  /** Message dont le corps est en cours de lecture sur le serveur. */
  bodyFetching?: string | null;
  /** Démo vitrine : le lecteur affiche, il ne modifie rien. */
  readOnly?: boolean;
}) {
  const prefs = usePrefs();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [download, setDownload] = useState<{ mailId: string; file: string } | null>(null);
  const [hint, setHint] = useState<{ mailId: string; text: string } | null>(null);

  const mail = thread.primary;
  const bodyLoading = bodyFetching === mail.id;
  const previous = thread.messages.slice(0, -1);
  const oldest = thread.messages[0];
  const folderMail = thread.messages.find((message) => message.folder !== "sent") ?? mail;
  const inSpam = folderMail.folder === "spam";
  const inTrash = folderMail.folder === "trash";
  const inArchive = folderMail.folder === "archive";

  const mailPgp = messagePgpStatus(mail);
  const pgpLocked =
    mail.pgp === "encrypted" && !mail.bodyFetched && !resolvePgp(prefs, mail.account).enabled;

  const pgpBanner = (message: Mail) => {
    const status = messagePgpStatus(message);
    return status ? <PgpNotice status={status} /> : null;
  };

  const runDownload = async (message: Mail, file: MailAttachment) => {
    setDownload({ mailId: message.id, file: file.name });
    setHint({ mailId: message.id, text: `Téléchargement de « ${file.name} »…` });
    const text = await downloadAttachment(message, file);
    setHint({ mailId: message.id, text });
    setDownload(null);
  };

  const attachmentList = (message: Mail) => {
    if (!message.attachments?.length) return null;
    const hintText = hint?.mailId === message.id ? hint.text : null;

    return (
      <div className="mt-4 space-y-2">
        {message.attachments.map((file, index) => {
          const busy = download?.mailId === message.id && download.file === file.name;
          return (
            <button
              key={`${file.name}-${index}`}
              type="button"
              disabled={busy}
              onClick={() => void runDownload(message, file)}
              aria-label={`Télécharger ${file.name} (${file.size})`}
              className="flex w-full items-center gap-3 rounded-2xl border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-accent-ring disabled:opacity-60"
            >
              <span className="grid size-9 place-items-center rounded-xl bg-accent-soft text-accent-ink">
                <Paperclip className="size-4" />
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-[12.5px] font-bold text-ink">{file.name}</span>
                <span className="block text-[11px] text-ink-muted">{file.size}</span>
              </span>
              {busy ? (
                <Loader2 className="size-4 animate-spin text-ink-muted" />
              ) : (
                <Download className="size-4 text-ink-muted" />
              )}
            </button>
          );
        })}
        <p role="status" aria-live="polite" className="px-1 text-[12px] leading-snug font-medium text-ink-muted">
          {hintText ?? "Les fichiers sont relus sur le serveur au moment du téléchargement."}
        </p>
      </div>
    );
  };

  const participantTones = thread.participants.map(
    (name) => thread.messages.find((message) => message.name === name)?.tone ?? 0,
  );

  return (
    <div className="relative flex h-full flex-col bg-canvas">
      <MeshGlow className="h-40" />

      <header className="relative z-10 flex items-center gap-1 px-2.5 pt-3 pb-1">
        <IconButton aria-label="Retour" onClick={onClose}>
          <ArrowLeft className="size-4.5" />
        </IconButton>
        <div className={cn("ml-auto flex items-center", readOnly && "hidden")}>
          {inTrash ? (
            onRestore && (
              <IconButton aria-label="Restaurer" onClick={() => onRestore(mail)}>
                <RotateCcw className="size-4.5" />
              </IconButton>
            )
          ) : inSpam ? (
            onNotSpam && (
              <IconButton aria-label="Non spam" onClick={() => onNotSpam(mail)}>
                <ShieldCheck className="size-4.5" />
              </IconButton>
            )
          ) : inArchive ? (
            onRestore && (
              <IconButton aria-label="Désarchiver" onClick={() => onRestore(mail)}>
                <RotateCcw className="size-4.5" />
              </IconButton>
            )
          ) : (
            onArchive && (
              <IconButton aria-label="Archiver" onClick={() => onArchive(mail)}>
                <Archive className="size-4.5" />
              </IconButton>
            )
          )}
          {onDelete && (
            <IconButton
              aria-label={inTrash ? "Supprimer définitivement" : "Supprimer"}
              onClick={() => onDelete(mail)}
            >
              <Trash2 className="size-4.5" />
            </IconButton>
          )}
          <IconButton
            aria-label={mail.starred ? "Retirer l'étoile" : "Marquer d'une étoile"}
            aria-pressed={mail.starred}
            onClick={onToggleStar}
            className={mail.starred ? "text-amber-400" : undefined}
          >
            <Star className={cn("size-4.5", mail.starred && "fill-amber-400")} />
          </IconButton>
        </div>
      </header>

      <div className="relative flex-1 overflow-y-auto no-scrollbar px-5 pb-6">
        <BlurFade yOffset={6}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-accent-soft px-2.5 py-1 text-[10.5px] font-bold text-accent-ink">
              {folderLabel(folderMail.folder)}
            </span>
            {thread.attachments > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-[10.5px] font-semibold text-ink-soft">
                <Paperclip className="size-3" />
                {thread.attachments} pièce{thread.attachments > 1 ? "s" : ""} jointe
                {thread.attachments > 1 ? "s" : ""}
              </span>
            ) : null}
          </div>

          <h1 className="mt-3 text-[22px] leading-[1.25] font-extrabold tracking-[-0.02em] text-ink">
            {thread.subject}
          </h1>
        </BlurFade>

        {thread.count > 1 && (
          <BlurFade delay={0.04}>
            <button
              type="button"
              onClick={() => setHistoryOpen((value) => !value)}
              aria-expanded={historyOpen}
              aria-label={
                historyOpen
                  ? "Replier les messages antérieurs"
                  : `Déplier les ${previous.length} message${previous.length > 1 ? "s" : ""} antérieur${
                      previous.length > 1 ? "s" : ""
                    }`
              }
              className="mt-3 flex w-full items-center gap-3 rounded-2xl border border-line bg-surface-2/70 px-3 py-2.5 text-left"
            >
              <span className="flex shrink-0 items-center">
                {thread.participants.slice(0, 2).map((name, index) => (
                  <Avatar
                    key={name}
                    name={name}
                    tone={participantTones[index]}
                    size={28}
                    rounded="rounded-full"
                    className={index > 0 ? "-ml-2 ring-2 ring-surface-2" : undefined}
                  />
                ))}
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block text-[12.5px] font-bold text-ink">
                  {previous.length} message{previous.length > 1 ? "s" : ""} antérieur
                  {previous.length > 1 ? "s" : ""}
                </span>
                <span className="block truncate text-[10.5px] font-medium text-ink-muted">
                  {thread.participants.join(", ")} · depuis {oldest.time.toLowerCase()}
                </span>
              </span>
              <ChevronDown
                className={cn(
                  "size-4 shrink-0 text-ink-muted transition-transform duration-300",
                  historyOpen && "rotate-180",
                )}
              />
            </button>

            <AnimatePresence initial={false}>
              {historyOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 space-y-1.5">
                    {previous.map((message) => {
                      const expanded = expandedId === message.id;
                      return (
                        <div
                          key={message.id}
                          className="overflow-hidden rounded-2xl border border-line bg-surface"
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setExpandedId(expanded ? null : message.id);
                              if (!expanded) onFetchBody?.(message);
                            }}
                            aria-expanded={expanded}
                            aria-label={
                              expanded
                                ? `Replier le message de ${message.name}`
                                : `Afficher le message de ${message.name}`
                            }
                            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
                          >
                            <Avatar name={message.name} tone={message.tone} size={34} rounded="rounded-full" />
                            <span className="min-w-0 flex-1 leading-tight">
                              <span className="block truncate text-[12px] font-bold text-ink">
                                {message.folder === "sent" ? "Moi" : message.name} · {message.time}
                              </span>
                              <span className="block truncate text-[12.5px] text-ink-muted">{message.body[0]}</span>
                            </span>
                            <ChevronDown
                              className={cn(
                                "size-3.5 shrink-0 text-ink-muted transition-transform",
                                expanded && "rotate-180",
                              )}
                            />
                          </button>

                          <AnimatePresence initial={false}>
                            {expanded && (
                              <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: "auto", opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                                className="overflow-hidden"
                              >
                                <div className="px-3 pb-3">
                                  {pgpBanner(message)}
                                  {bodyFetching === message.id ? (
                                    <MailBodyLoading className="mt-2" />
                                  ) : message.body.length > 0 || message.html ? (
                                    <MailBody
                                      className="mt-2 text-[13px] leading-[1.7] font-medium text-ink-soft"
                                      html={message.html}
                                      paragraphs={message.body}
                                      source={message.source}
                                      encrypted={message.pgp === "encrypted"}
                                    />
                                  ) : message.pgp === "encrypted" &&
                                    !resolvePgp(prefs, message.account).enabled ? (
                                    <p className="mt-2 text-[12.5px] leading-snug font-medium text-ink-muted">
                                      Message chiffré · PGP désactivé pour ce compte
                                    </p>
                                  ) : null}
                                  {attachmentList(message)}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      );
                    })}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </BlurFade>
        )}

        <BlurFade delay={0.06}>
          <div className="mt-4 flex items-center gap-3">
            <Avatar name={mail.name} tone={mail.tone} size={40} rounded="rounded-full" />
            <button
              type="button"
              onClick={() => setDetailsOpen((value) => !value)}
              aria-expanded={detailsOpen}
              aria-label={
                detailsOpen ? "Masquer le détail de l'expéditeur" : "Afficher le détail de l'expéditeur"
              }
              className="min-w-0 flex-1 text-left leading-tight"
            >
              <span className="flex items-center gap-1">
                <span className="truncate text-[13px] font-bold text-ink">{mail.name}</span>
                <ChevronDown
                  className={cn(
                    "size-3.5 shrink-0 text-ink-muted transition-transform",
                    detailsOpen && "rotate-180",
                  )}
                />
              </span>
              <span className="block break-all text-left text-[12px] font-medium text-ink-muted">
                {mail.time}
              </span>
            </button>
            {readOnly ? null : (
              <IconButton
                aria-label={mail.folder === "drafts" ? "Reprendre le brouillon" : "Répondre"}
                onClick={() => (mail.folder === "drafts" ? onResume?.(mail) : onReply(mail))}
                className="bg-accent-soft text-accent-ink"
              >
                {mail.folder === "drafts" ? <PenLine className="size-4" /> : <CornerUpLeft className="size-4" />}
              </IconButton>
            )}
          </div>

          <MailRecipients mail={mail} className="mt-2" />

          {detailsOpen && (
            <dl className="mt-2 space-y-1 rounded-2xl bg-surface-2/70 px-3 py-2 text-[11.5px] font-medium text-ink-soft">
              <div className="flex gap-2">
                <dt className="shrink-0 font-bold text-ink-muted">De</dt>
                <dd className="min-w-0 break-all">
                  {mail.name} &lt;{mail.email}&gt;
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 font-bold text-ink-muted">À</dt>
                <dd className="min-w-0 break-all">{mail.to ?? "moi"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 font-bold text-ink-muted">Date</dt>
                <dd className="min-w-0">{mail.date ?? mail.time}</dd>
              </div>
            </dl>
          )}
        </BlurFade>

        {mailPgp && (
          <BlurFade delay={0.09}>
            <div className="mt-3 flex items-center gap-2">
              <PgpStatusBadge status={mailPgp} />
              <span className="text-[10.5px] font-semibold text-ink-muted">
                {mail.pgp === "encrypted" ? "message chiffré" : "message signé"}
              </span>
            </div>
            <PgpNotice status={mailPgp} />
          </BlurFade>
        )}

        {pgpLocked ? (
          <BlurFade delay={0.1}>
            <div
              role="status"
              className="mt-3 flex items-start gap-2.5 rounded-2xl border border-accent-ring/50 bg-surface-2 px-3.5 py-3"
            >
              <ShieldOff className="mt-0.5 size-4 shrink-0 text-accent-ink" strokeWidth={2.4} />
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] leading-snug font-bold text-ink">
                  Message chiffré · PGP désactivé pour ce compte
                </p>
                <p className="mt-1 text-[11.5px] leading-snug font-medium text-ink-soft">
                  Active PGP pour ce compte dans les réglages pour le déchiffrer.
                </p>
                {onOpenPgp ? (
                  <button
                    type="button"
                    onClick={onOpenPgp}
                    className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-full bg-accent-soft px-3 text-[12px] font-bold text-accent-ink transition-transform duration-200 active:scale-95"
                  >
                    Ouvrir les réglages
                    <ChevronRight className="size-3.5" />
                  </button>
                ) : null}
              </div>
            </div>
          </BlurFade>
        ) : null}

        <BlurFade delay={0.12}>
          {bodyLoading ? (
            <MailBodyLoading className="mt-5" />
          ) : (
            <MailBody
              className="mt-5"
              html={mail.html}
              paragraphs={mail.body}
              source={mail.source}
              encrypted={mail.pgp === "encrypted"}
            />
          )}
        </BlurFade>

        {mail.attachments?.length ? <BlurFade delay={0.18}>{attachmentList(mail)}</BlurFade> : null}
      </div>

      <div className="relative border-t border-line/80 px-5 py-3 glass safe-bottom sm:pb-5">
        {readOnly ? (
          <p className="flex items-center justify-center gap-1.5 text-[11.5px] font-semibold text-ink-muted">
            <Lock className="size-3.5" strokeWidth={2.4} />
            Démo · données d'exemple
          </p>
        ) : (
        <div className="flex items-center gap-2">
          {mail.folder === "drafts" ? (
            <ShimmerButton
              onClick={() => onResume?.(mail)}
              className="flex-1"
              shimmerDuration={4}
              disabled={!onResume}
            >
              <PenLine className="size-4" />
              Reprendre le brouillon
            </ShimmerButton>
          ) : (
            <>
              <ShimmerButton onClick={() => onReply(mail)} className="flex-1" shimmerDuration={4}>
                <CornerUpLeft className="size-4" />
                Répondre
              </ShimmerButton>
              <button
                type="button"
                onClick={() => onForward?.(mail)}
                disabled={!onForward}
                className="grid size-11 place-items-center rounded-full border border-line bg-surface text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink disabled:pointer-events-none disabled:opacity-40"
                aria-label="Transférer"
              >
                <CornerUpRight className="size-4.5" />
              </button>
              <button
                type="button"
                onClick={() => onAnalyse?.(mail)}
                disabled={!onAnalyse}
                className="grid size-11 place-items-center rounded-full border border-line bg-surface text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink disabled:pointer-events-none disabled:opacity-40"
                aria-label="Analyse"
              >
                <Sparkles className="size-4.5" />
              </button>
            </>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
