import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { errorText, mailApi } from "@/lib/api";
import type { MailMode } from "@/lib/demo-mode";
import type { ComposeDraft } from "@/lib/draft";
import { accountDecrypts, messageToMail, threadMails, type FolderRecord } from "@/lib/mail-backend";
import { MAILS, type Mail } from "@/lib/mail";
import { buildThreads } from "@/lib/threads";
import { cn } from "@/lib/utils";
import { MailBody, MailBodyLoading } from "@/components/mail-body";
import { QuotedBlock } from "@/components/quoted-block";

type BodyState = { mail?: Mail; loading?: boolean; error?: string };

function demoThread(account: string, threadId: string): Mail[] {
  return buildThreads(MAILS).find((thread) => thread.id === `${account}:${threadId}`)?.messages ?? [];
}

function chronological(mails: Mail[]): Mail[] {
  return [...mails].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

/**
 * Le fil complet d'un brouillon, en lecture seule et replié : la rédaction
 * n'affiche plus une longue citation mais la conversation, tous dossiers du
 * compte confondus. Sans fil disponible, la citation classique prend le relais.
 */
export function ConversationPanel({
  draft,
  mode,
  records,
}: {
  draft: ComposeDraft;
  mode: MailMode;
  records: FolderRecord[];
}) {
  const { account, threadId } = draft;
  const [messages, setMessages] = useState<Mail[]>([]);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [bodies, setBodies] = useState<Record<string, BodyState>>({});

  useEffect(() => {
    setMessages([]);
    setOpen(false);
    setExpanded([]);
    setBodies({});
    if (!threadId) return;
    if (mode !== "api") {
      setMessages(chronological(demoThread(account, threadId)));
      return;
    }
    let cancelled = false;
    threadMails(account, threadId, records)
      .then((mails) => {
        if (!cancelled) setMessages(chronological(mails));
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [account, mode, records, threadId]);

  const readBody = (mail: Mail) => {
    if (mode !== "api" || !mail.source || mail.bodyFetched) return;
    if (mail.pgp === "encrypted" && !accountDecrypts(mail.account)) return;
    const source = mail.source;
    setBodies((current) => ({ ...current, [mail.id]: { loading: true } }));
    mailApi
      .message(source.accountId, source.folderPath, source.uid)
      .then((message) => {
        const fetched = messageToMail(message, records);
        setBodies((current) => ({ ...current, [mail.id]: { mail: fetched } }));
      })
      .catch((error: unknown) => {
        setBodies((current) => ({ ...current, [mail.id]: { error: errorText(error) } }));
      });
  };

  const toggleMessage = (mail: Mail) => {
    const isOpen = expanded.includes(mail.id);
    setExpanded(isOpen ? expanded.filter((id) => id !== mail.id) : [...expanded, mail.id]);
    if (!isOpen) readBody(mail);
  };

  if (!threadId || messages.length === 0) return <QuotedBlock quoted={draft.quoted} />;

  const summary = `Voir la conversation · ${messages.length} message${messages.length > 1 ? "s" : ""}`;

  return (
    <div className="mt-2" data-testid="conversation-panel">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "Masquer la conversation" : summary}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-accent-soft px-3 text-[11.5px] font-bold text-accent-ink transition-colors"
      >
        <ChevronDown
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
          strokeWidth={2.6}
        />
        {open ? "Masquer la conversation" : summary}
      </button>

      {open && (
        <div data-testid="conversation-messages" className="mt-2 space-y-1.5">
          {messages.map((mail) => {
            const state = bodies[mail.id] ?? {};
            const shown = state.mail ?? mail;
            const isOpen = expanded.includes(mail.id);
            const hasBody = shown.body.length > 0 || Boolean(shown.html);
            const locked = shown.pgp === "encrypted" && !accountDecrypts(shown.account);
            return (
              <div
                key={mail.id}
                data-testid="conversation-message"
                className="overflow-hidden rounded-2xl border border-line bg-surface-2"
              >
                <button
                  type="button"
                  onClick={() => toggleMessage(mail)}
                  aria-expanded={isOpen}
                  className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left"
                >
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-[12px] font-bold text-ink">
                      {mail.folder === "sent" ? "Moi" : mail.name} · {mail.date ?? mail.time}
                    </span>
                    <span className="block truncate text-[12px] font-medium text-ink-muted">
                      {mail.preview}
                    </span>
                  </span>
                  <ChevronDown
                    className={cn(
                      "size-3.5 shrink-0 text-ink-muted transition-transform",
                      isOpen && "rotate-180",
                    )}
                  />
                </button>
                {isOpen && (
                  <div className="px-3 pb-3">
                    {state.loading ? (
                      <MailBodyLoading className="mt-2" />
                    ) : state.error ? (
                      <p className="mt-2 text-[12.5px] leading-snug font-medium text-ink-muted">
                        Corps indisponible · {state.error}
                      </p>
                    ) : hasBody ? (
                      <MailBody
                        className="mt-2 text-[13px] leading-[1.7] font-medium text-ink-soft"
                        html={shown.html}
                        paragraphs={shown.body}
                        source={shown.source}
                        encrypted={shown.pgp === "encrypted"}
                      />
                    ) : locked ? (
                      <p className="mt-2 text-[12.5px] leading-snug font-medium text-ink-muted">
                        Message chiffré · PGP désactivé pour ce compte
                      </p>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
