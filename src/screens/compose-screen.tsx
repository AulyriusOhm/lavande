import { useMemo, useState } from "react";
import {
  Check,
  Image,
  Link2,
  Lock,
  Minus,
  Paperclip,
  Send,
  ShieldCheck,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ACCOUNTS } from "@/lib/accounts";
import { composeReply, replySuggestions, rewriteBody, userPart, type ReplySuggestion } from "@/lib/assist";
import { ReplySuggestSheet, RewriteSheet } from "@/screens/assist-sheet";
import { IconButton } from "@/components/ui/primitives";
import { ShimmerButton } from "@/components/ui/shimmer-button";

export type ComposeDraft = {
  to: string;
  cc: string;
  cci: string;
  subject: string;
  body: string;
  account: string;
  pgpEncrypt: boolean;
  pgpSign: boolean;
  threadId?: string;
};

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;
const DEFAULT_ACCOUNT = ACCOUNTS[0].id;

const recipients = (value: string) =>
  value
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);

const invalidRecipients = (draft: ComposeDraft) =>
  [...recipients(draft.to), ...recipients(draft.cc), ...recipients(draft.cci)].filter(
    (token) => !EMAIL.test(token),
  );

export function ComposeScreen({
  onClose,
  initialDraft,
  onDraftChange,
  onSend,
  onMinimize,
  title = "Nouveau message",
}: {
  onClose: () => void;
  initialDraft?: Partial<ComposeDraft>;
  onDraftChange?: (draft: ComposeDraft) => void;
  onSend?: (draft: ComposeDraft) => void;
  onMinimize?: () => void;
  title?: string;
}) {
  const [draft, setDraft] = useState<ComposeDraft>(() => ({
    to: initialDraft?.to ?? "",
    cc: initialDraft?.cc ?? "",
    cci: initialDraft?.cci ?? "",
    subject: initialDraft?.subject ?? "",
    body: initialDraft?.body ?? "",
    account: initialDraft?.account ?? DEFAULT_ACCOUNT,
    pgpEncrypt: initialDraft?.pgpEncrypt ?? true,
    pgpSign: initialDraft?.pgpSign ?? true,
  }));
  const [showCc, setShowCc] = useState(Boolean(initialDraft?.cc?.trim()));
  const [showCci, setShowCci] = useState(Boolean(initialDraft?.cci?.trim()));
  const [confirmSend, setConfirmSend] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [sent, setSent] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [rewriteOpen, setRewriteOpen] = useState(false);

  const suggestions = useMemo(
    () => replySuggestions({ subject: draft.subject, to: draft.to, body: draft.body }),
    [draft.subject, draft.to, draft.body],
  );
  const isReply = /^re\s*:/i.test(draft.subject) || /a écrit\s*:/.test(draft.body);

  const update = (patch: Partial<ComposeDraft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onDraftChange?.(next);
  };

  const invalid = invalidRecipients(draft);
  const hasRecipient = [draft.to, draft.cc, draft.cci].some((value) =>
    recipients(value).some((token) => EMAIL.test(token)),
  );
  const validRecipients = hasRecipient && invalid.length === 0;
  const dirty = Boolean(
    draft.to.trim() || draft.cc.trim() || draft.cci.trim() || draft.subject.trim() || draft.body.trim(),
  );

  const send = () => {
    setConfirmSend(false);
    onSend?.(draft);
    setSent(true);
    if (!onSend) onClose();
  };

  const requestSend = () => {
    if (!validRecipients || sent) return;
    if (!draft.subject.trim() || !draft.body.trim()) {
      setConfirmSend(true);
      return;
    }
    send();
  };

  const requestClose = () => {
    if (dirty && !sent) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };

  const applySuggestion = (suggestion: ReplySuggestion) => {
    const rest = draft.body.trimStart();
    update({
      body:
        draft.body.trim() === ""
          ? suggestion.text
          : rest.startsWith("---")
            ? suggestion.text + "\n\n" + rest
            : suggestion.text + "\n\n" + draft.body,
    });
    setSuggestOpen(false);
  };

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-line" />
      <div className="flex items-center gap-2 px-3 pt-2 pb-2">
        <IconButton aria-label="Fermer" onClick={requestClose}>
          <X className="size-5" />
        </IconButton>
        <h2 className="text-[15px] font-bold tracking-tight text-ink">{title}</h2>
        <div className="ml-auto flex items-center gap-1">
          {onMinimize && (
            <IconButton aria-label="Réduire le brouillon" onClick={onMinimize}>
              <Minus className="size-4.5" />
            </IconButton>
          )}
          <IconButton aria-label="Joindre">
            <Paperclip className="size-4.5" />
          </IconButton>
          <IconButton aria-label="Ajouter une image">
            <Image className="size-4.5" />
          </IconButton>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto no-scrollbar px-5">
        <div className="flex items-center gap-2 border-b border-line py-3">
          <label htmlFor="compose-from" className="text-[12px] font-bold tracking-[0.1em] text-ink-muted uppercase">
            De
          </label>
          <select
            id="compose-from"
            value={draft.account}
            onChange={(event) => update({ account: event.target.value })}
            className="min-w-0 flex-1 cursor-pointer bg-transparent text-[13px] font-semibold text-ink outline-none"
          >
            {ACCOUNTS.map((entry) => (
              <option key={entry.id} value={entry.id} className="bg-surface text-ink">
                {entry.label} · {entry.email}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2 border-b border-line py-3">
          <label htmlFor="compose-to" className="text-[12px] font-bold tracking-[0.1em] text-ink-muted uppercase">
            À
          </label>
          <input
            id="compose-to"
            value={draft.to}
            onChange={(event) => update({ to: event.target.value })}
            placeholder="destinataire@mail.com"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] font-medium text-ink outline-none placeholder:text-ink-muted/70"
          />
          <button
            type="button"
            onClick={() => {
              if (showCc) update({ cc: "" });
              setShowCc((value) => !value);
            }}
            aria-pressed={showCc}
            aria-label={showCc ? "Masquer et vider le champ Cc" : "Afficher le champ Cc"}
            className={cn(
              "inline-flex min-h-11 items-center justify-center rounded-full px-2.5 text-[10.5px] font-bold transition-colors",
              showCc ? "bg-accent text-accent-contrast" : "bg-accent-soft text-accent-ink",
            )}
          >
            Cc
          </button>
          <button
            type="button"
            onClick={() => {
              if (showCci) update({ cci: "" });
              setShowCci((value) => !value);
            }}
            aria-pressed={showCci}
            aria-label={showCci ? "Masquer et vider le champ Cci" : "Afficher le champ Cci"}
            className={cn(
              "inline-flex min-h-11 items-center justify-center rounded-full px-2.5 text-[10.5px] font-bold transition-colors",
              showCci ? "bg-accent text-accent-contrast" : "bg-accent-soft text-accent-ink",
            )}
          >
            Cci
          </button>
        </div>

        {showCc && (
          <div className="flex items-center gap-2 border-b border-line py-3">
            <label htmlFor="compose-cc" className="text-[12px] font-bold tracking-[0.1em] text-ink-muted uppercase">
              Cc
            </label>
            <input
              id="compose-cc"
              value={draft.cc}
              onChange={(event) => update({ cc: event.target.value })}
              placeholder="copie@mail.com"
              className="min-w-0 flex-1 bg-transparent text-[13.5px] font-medium text-ink outline-none placeholder:text-ink-muted/70"
            />
          </div>
        )}

        {showCci && (
          <div className="flex items-center gap-2 border-b border-line py-3">
            <label htmlFor="compose-cci" className="text-[12px] font-bold tracking-[0.1em] text-ink-muted uppercase">
              Cci
            </label>
            <input
              id="compose-cci"
              value={draft.cci}
              onChange={(event) => update({ cci: event.target.value })}
              placeholder="copie cachée@mail.com"
              className="min-w-0 flex-1 bg-transparent text-[13.5px] font-medium text-ink outline-none placeholder:text-ink-muted/70"
            />
          </div>
        )}

        {invalid.length > 0 && (
          <p role="alert" className="border-b border-line py-2 text-[11.5px] font-semibold text-red-600 dark:text-red-300">
            Adresse{invalid.length > 1 ? "s" : ""} invalide{invalid.length > 1 ? "s" : ""} : {invalid.join(", ")}
          </p>
        )}

        <div className="border-b border-line py-3">
          <label htmlFor="compose-subject" className="sr-only">
            Objet
          </label>
          <input
            id="compose-subject"
            value={draft.subject}
            onChange={(event) => update({ subject: event.target.value })}
            placeholder="Objet du message"
            className="w-full bg-transparent text-[15px] font-bold tracking-tight text-ink outline-none placeholder:font-semibold placeholder:text-ink-muted/70"
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => update({ pgpEncrypt: !draft.pgpEncrypt })}
            aria-pressed={draft.pgpEncrypt}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10.5px] font-bold transition-colors",
              draft.pgpEncrypt
                ? "bg-accent-soft text-accent-ink ring-1 ring-accent-ring/60"
                : "border border-line text-ink-muted",
            )}
          >
            <Lock className="size-3" strokeWidth={2.6} />
            Chiffrer à l’envoi
          </button>
          <button
            type="button"
            onClick={() => update({ pgpSign: !draft.pgpSign })}
            aria-pressed={draft.pgpSign}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10.5px] font-bold transition-colors",
              draft.pgpSign
                ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500/30"
                : "border border-line text-ink-muted",
            )}
          >
            <ShieldCheck className="size-3" strokeWidth={2.6} />
            Signer à l’envoi
          </button>
        </div>

        <label htmlFor="compose-body" className="sr-only">
          Message
        </label>
        <textarea
          id="compose-body"
          value={draft.body}
          onChange={(event) => update({ body: event.target.value })}
          placeholder="Écris ton message…"
          className="mt-3 min-h-40 w-full flex-1 resize-none bg-transparent text-[13.5px] leading-[1.7] font-medium text-ink outline-none placeholder:text-ink-muted/70"
        />

        <div className="flex flex-wrap items-center gap-2 pb-4">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5 text-[11.5px] font-bold text-accent-ink">
            <Check className="size-3.5" strokeWidth={3} />
            Signature « Roman »
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[11.5px] font-semibold text-ink-soft"
          >
            <Link2 className="size-3.5" />
            Lien
          </button>
        </div>
      </div>

      <div className="border-t border-line/80 px-5 py-3 glass safe-bottom sm:pb-5">
        {confirmSend && (
          <div
            role="alertdialog"
            aria-label="Confirmer l'envoi sans objet ou sans message"
            className="mb-2 flex items-center gap-2 rounded-2xl bg-surface-2 px-3 py-2"
          >
            <p className="min-w-0 flex-1 text-[11.5px] font-semibold text-ink-soft">
              Objet ou message vide. Envoyer quand même ?
            </p>
            <button
              type="button"
              onClick={() => setConfirmSend(false)}
              className="rounded-full px-2.5 py-1 text-[11px] font-bold text-ink-soft"
            >
              Annuler
            </button>
            <button
              type="button"
              onClick={send}
              className="rounded-full bg-accent px-2.5 py-1 text-[11px] font-bold text-accent-contrast"
            >
              Envoyer
            </button>
          </div>
        )}

        {confirmClose && (
          <div
            role="alertdialog"
            aria-label="Confirmer la fermeture du brouillon"
            className="mb-2 flex items-center gap-2 rounded-2xl bg-surface-2 px-3 py-2"
          >
            <p className="min-w-0 flex-1 text-[11.5px] font-semibold text-ink-soft">
              Fermer et perdre ce message ?
            </p>
            <button
              type="button"
              onClick={() => setConfirmClose(false)}
              className="rounded-full px-2.5 py-1 text-[11px] font-bold text-ink-soft"
            >
              Annuler
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full bg-accent px-2.5 py-1 text-[11px] font-bold text-accent-contrast"
            >
              Fermer
            </button>
          </div>
        )}

        <div className="flex items-center gap-2">
          <ShimmerButton
            className="flex-1"
            disabled={!validRecipients || sent}
            aria-label={validRecipients ? "Envoyer le message" : "Envoyer, destinataire valide requis"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={requestSend}
          >
            {sent ? <Check className="size-4" /> : <Send className="size-4" />}
            {sent ? "Envoyé" : "Envoyer"}
          </ShimmerButton>
          {isReply && (
            <button
              type="button"
              aria-haspopup="dialog"
              aria-label="Suggestion de réponse"
              title="Suggestion de réponse"
              onClick={() => setSuggestOpen(true)}
              className="grid size-11 shrink-0 place-items-center rounded-full border border-accent-ring bg-accent-soft text-accent-ink transition-transform active:scale-95"
            >
              <Sparkles className="size-4.5" />
            </button>
          )}
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label="Corriger ou reformuler le message"
            title="Corriger / reformuler"
            disabled={!userPart(draft.body).trim() || sent}
            onClick={() => setRewriteOpen(true)}
            className="grid size-11 shrink-0 place-items-center rounded-full border border-line bg-surface text-ink-soft transition-transform active:scale-95 disabled:pointer-events-none disabled:opacity-40"
          >
            <WandSparkles className="size-4.5" />
          </button>
        </div>
      </div>

      <ReplySuggestSheet
        open={suggestOpen}
        suggestions={suggestions}
        generate={(brief) =>
          composeReply({ subject: draft.subject, to: draft.to, body: draft.body, brief })
        }
        onPick={applySuggestion}
        onClose={() => setSuggestOpen(false)}
      />
      <RewriteSheet
        open={rewriteOpen}
        body={draft.body}
        onApply={(id) => {
          update({ body: rewriteBody(id, draft.body) });
          setRewriteOpen(false);
        }}
        onClose={() => setRewriteOpen(false)}
      />
    </div>
  );
}
