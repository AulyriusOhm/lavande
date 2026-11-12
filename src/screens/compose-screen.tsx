import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ComposeDraft, DraftAttachment } from "@/lib/draft";
import { MAX_ATTACHMENT_BYTES, attachmentsSize, formatBytes, readAttachment } from "@/lib/draft";
import {
  Check,
  ChevronDown,
  Image,
  PenLine,
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
import { useMailStore } from "@/lib/store";
import { aiComposeReply, composeReply, replySuggestions, threadConversation, userPart, type ReplySuggestion } from "@/lib/assist";
import { llmReady } from "@/lib/llm";
import { ReplySuggestSheet, RewriteSheet } from "@/screens/assist-sheet";
import { IconButton } from "@/components/ui/primitives";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { RichEditor } from "@/components/ui/rich-editor";
import { ensureHtml, extractImageTokens, htmlToText, restoreImageTokens, textToHtml, isHtmlEmpty, sanitizeHtml } from "@/lib/rich-text";
import { activeSignature, resolvePgp, usePrefs } from "@/lib/prefs";

export type { ComposeDraft };

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;

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
  draft,
  onDraftChange,
  onSend,
  onMinimize,
  title = "Nouveau message",
  sent = false,
  sendError,
  headerActions,
  onHeaderPointerDown,
  onHeaderDoubleClick,
}: {
  onClose: () => void;
  draft: ComposeDraft;
  onDraftChange: (draft: ComposeDraft) => void;
  onSend?: (draft: ComposeDraft) => void;
  onMinimize?: () => void;
  title?: string;
  sent?: boolean;
  sendError?: string | null;
  headerActions?: ReactNode;
  onHeaderPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onHeaderDoubleClick?: () => void;
}) {
  const { accounts, mails, openThread, saveToDrafts } = useMailStore();
  const prefs = usePrefs();
  const { signatures, llm, aiReplyEnabled } = prefs;
  const accountSignature = activeSignature(signatures, draft.account);
  const [showCc, setShowCc] = useState(Boolean(draft.cc.trim()));
  const [showCci, setShowCci] = useState(Boolean(draft.cci.trim()));
  const [confirmSend, setConfirmSend] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(
    () => replySuggestions({ subject: draft.subject, to: draft.to, body: htmlToText(draft.body) }),
    [draft.subject, draft.to, draft.body],
  );
  const isReply = /^re\s*:/i.test(draft.subject) || Boolean(draft.quoted?.trim());
  const { text: rewriteText, images: rewriteImages } = useMemo(() => extractImageTokens(draft.body), [draft.body]);

  const update = (patch: Partial<ComposeDraft>) => {
    onDraftChange({ ...draft, ...patch });
  };

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const current = draft.attachments ?? [];
    const added: DraftAttachment[] = [];
    let failure: string | null = null;
    for (const file of Array.from(files)) {
      try {
        added.push(await readAttachment(file));
      } catch (error) {
        failure = error instanceof Error ? error.message : `lecture de « ${file.name} » impossible`;
      }
    }
    const joined = [...current, ...added];
    if (attachmentsSize(joined) > MAX_ATTACHMENT_BYTES) {
      setAttachmentError(
        `Pièces jointes trop lourdes : ${formatBytes(MAX_ATTACHMENT_BYTES)} au total maximum, « ${added
          .map((file) => file.filename)
          .join(", ")} » n'a pas été ajouté.`,
      );
      return;
    }
    setAttachmentError(failure);
    if (added.length) update({ attachments: joined });
  };

  const removeAttachment = (index: number) => {
    setAttachmentError(null);
    update({ attachments: (draft.attachments ?? []).filter((_, position) => position !== index) });
  };

  const invalid = invalidRecipients(draft);
  const hasRecipient = [draft.to, draft.cc, draft.cci].some((value) =>
    recipients(value).some((token) => EMAIL.test(token)),
  );
  const validRecipients = hasRecipient && invalid.length === 0;
  const dirty = Boolean(
    draft.to.trim() ||
      draft.cc.trim() ||
      draft.cci.trim() ||
      draft.subject.trim() ||
      draft.body.trim() ||
      draft.attachments?.length,
  );

  const send = () => {
    setConfirmSend(false);
    onSend?.(draft);
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

  const handleSaveDraft = async () => {
    setConfirmClose(false);
    if (await saveToDrafts(draft)) onClose();
  };

  const applySuggestion = (suggestion: ReplySuggestion) => {
    const suggestionHtml = textToHtml(suggestion.text);
    update({
      body: isHtmlEmpty(draft.body) ? suggestionHtml : suggestionHtml + ensureHtml(draft.body),
    });
    setSuggestOpen(false);
  };

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-line" />
      <div
        className={cn(
          "flex items-center gap-2 px-3 pt-2 pb-2",
          onHeaderPointerDown && "cursor-grab touch-none select-none active:cursor-grabbing",
        )}
        onPointerDown={onHeaderPointerDown}
        onDoubleClick={onHeaderDoubleClick}
      >
        <IconButton aria-label="Fermer" onClick={requestClose}>
          <X className="size-5" />
        </IconButton>
        <h2 className="text-[15px] font-bold tracking-tight text-ink">{title}</h2>
        <div className="ml-auto flex items-center gap-1">
          {headerActions}
          {onMinimize && (
            <IconButton aria-label="Réduire le brouillon" onClick={onMinimize}>
              <Minus className="size-4.5" />
            </IconButton>
          )}
          <IconButton
            aria-label="Joindre un fichier"
            disabled={sent}
            className="disabled:pointer-events-none disabled:opacity-40"
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip className="size-4.5" />
          </IconButton>
          <IconButton
            aria-label="Ajouter une image"
            disabled={sent}
            className="disabled:pointer-events-none disabled:opacity-40"
            onClick={() => imageInput.current?.click()}
          >
            <Image className="size-4.5" />
          </IconButton>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-testid="compose-attach-input"
            onChange={(event) => {
              void addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <input
            ref={imageInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            data-testid="compose-image-input"
            onChange={(event) => {
              void addFiles(event.target.files);
              event.target.value = "";
            }}
          />
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
            onChange={(event) => {
              const pgp = resolvePgp(prefs, event.target.value);
              update({ account: event.target.value, pgpEncrypt: pgp.encrypt, pgpSign: pgp.sign });
            }}
            className="min-w-0 flex-1 cursor-pointer bg-transparent text-[13px] font-semibold text-ink outline-none"
          >
            {accounts.map((entry) => (
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
            className="min-w-0 flex-1 bg-transparent text-[13.5px] font-medium text-ink outline-none placeholder:text-ink-soft"
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
              className="min-w-0 flex-1 bg-transparent text-[13.5px] font-medium text-ink outline-none placeholder:text-ink-soft"
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
              className="min-w-0 flex-1 bg-transparent text-[13.5px] font-medium text-ink outline-none placeholder:text-ink-soft"
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
            className="w-full bg-transparent text-[15px] font-bold tracking-tight text-ink outline-none placeholder:font-semibold placeholder:text-ink-soft"
          />
        </div>

        {draft.attachments?.length ? (
          <ul aria-label="Pièces jointes" className="flex flex-wrap gap-1.5 border-b border-line py-2">
            {draft.attachments.map((file, index) => (
              <li
                key={`${file.filename}-${index}`}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1"
              >
                <Paperclip className="size-3 shrink-0 text-ink-muted" />
                <span className="min-w-0 truncate text-[11.5px] font-semibold text-ink-soft">{file.filename}</span>
                <span className="shrink-0 text-[10.5px] font-medium text-ink-muted">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  aria-label={`Retirer ${file.filename}`}
                  onClick={() => removeAttachment(index)}
                  className="relative grid size-6 shrink-0 place-items-center rounded-full text-ink-muted transition-colors before:absolute before:-inset-2.5 before:rounded-full before:content-[''] hover:text-ink"
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {attachmentError && (
          <p role="alert" className="border-b border-line py-2 text-[11.5px] font-semibold text-red-600 dark:text-red-300">
            {attachmentError}
          </p>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => update({ pgpEncrypt: !draft.pgpEncrypt })}
            aria-pressed={draft.pgpEncrypt}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-bold transition-colors",
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
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-bold transition-colors",
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
        <RichEditor
          value={ensureHtml(draft.body)}
          onChange={(html) => update({ body: html })}
          placeholder="Écris ton message… (Markdown supporté : **gras**, # titre, - liste)"
          minHeight="11rem"
          className="mt-3 flex-1"
        />

        {accountSignature && draft.includeSignature !== false ? (
          <div className="mt-2 border-t border-line/60 pt-2.5" data-testid="signature-preview">
            <div
              className="text-[12.5px] leading-relaxed text-ink-soft [&_a]:text-accent-ink [&_img]:max-w-full"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(accountSignature) }}
            />
          </div>
        ) : null}

        {draft.quoted?.trim() ? (
          <div className="mt-2" data-testid="compose-quoted-block">
            <button
              type="button"
              onClick={() => setQuoteOpen((value) => !value)}
              aria-expanded={quoteOpen}
              aria-label={quoteOpen ? "Masquer la conversation précédente" : "Voir la conversation précédente"}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-accent-soft px-3 text-[11.5px] font-bold text-accent-ink transition-colors"
            >
              <ChevronDown
                className={cn("size-3.5 transition-transform", quoteOpen && "rotate-180")}
                strokeWidth={2.6}
              />
              {quoteOpen ? "Masquer la conversation précédente" : "Voir la conversation précédente"}
            </button>
            {quoteOpen && (
              <div
                data-testid="compose-quoted"
                className="pointer-events-none mt-2 rounded-2xl border border-line bg-surface-2 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-soft [&_a]:text-accent-ink [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-2.5 [&_img]:max-w-full"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(draft.quoted) }}
              />
            )}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 pb-4">
          {accountSignature ? (
            <button
              type="button"
              onClick={() => update({ includeSignature: draft.includeSignature === false })}
              aria-pressed={draft.includeSignature !== false}
              title={
                draft.includeSignature !== false
                  ? "Retirer la signature de ce message"
                  : "Ajouter la signature à ce message"
              }
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] font-bold transition-colors",
                draft.includeSignature !== false
                  ? "bg-accent-soft text-accent-ink"
                  : "border border-line text-ink-muted",
              )}
            >
              <PenLine className="size-3.5" strokeWidth={2.6} />
              {draft.includeSignature !== false ? "Signature activée" : "Signature désactivée"}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[11.5px] font-semibold text-ink-muted">
              <PenLine className="size-3.5" strokeWidth={2.6} />
              Aucune signature · à créer dans les réglages
            </span>
          )}
        </div>
      </div>

      <div className="border-t border-line/80 px-5 py-3 glass safe-bottom sm:pb-5">
        {sendError && (
          <p role="alert" className="mb-2 rounded-2xl bg-red-500/10 px-3 py-2 text-[11.5px] font-semibold text-red-600 dark:text-red-300">
            {sendError}
          </p>
        )}
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
              className="inline-flex min-h-11 items-center rounded-full px-3 text-[12px] font-bold text-ink-soft"
            >
              Annuler
            </button>
            <button
              type="button"
              onClick={send}
              className="inline-flex min-h-11 items-center rounded-full bg-accent px-3 text-[12px] font-bold text-accent-contrast"
            >
              Envoyer
            </button>
          </div>
        )}

        {confirmClose && (
          <div
            role="alertdialog"
            aria-label="Enregistrer ou supprimer le brouillon"
            className="mb-2 flex flex-wrap items-center gap-2 rounded-2xl bg-surface-2 px-3 py-2"
          >
            <p className="min-w-0 flex-1 text-[11.5px] font-semibold text-ink-soft">
              Enregistrer ce message avant de fermer ?
            </p>
            <button
              type="button"
              onClick={() => setConfirmClose(false)}
              className="inline-flex min-h-11 items-center rounded-full px-3 text-[12px] font-bold text-ink-soft"
            >
              Annuler
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex min-h-11 items-center rounded-full px-3 text-[12px] font-bold text-rose-700 dark:text-rose-300"
            >
              Supprimer
            </button>
            <button
              type="button"
              onClick={() => void handleSaveDraft()}
              className="inline-flex min-h-11 items-center rounded-full bg-accent px-3 text-[12px] font-bold text-accent-contrast"
            >
              Brouillons
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
            disabled={!userPart(htmlToText(draft.body)).trim() || sent}
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
        generate={async (brief) => {
          const input = { subject: draft.subject, to: draft.to, body: htmlToText(draft.body) };
          if (!llmReady(llm) || !aiReplyEnabled) return composeReply({ ...input, brief });
          const conversation = threadConversation(openThread?.messages, mails ?? [], draft.threadId);
          return aiComposeReply(llm, { ...input, conversation }, brief);
        }}
        onPick={applySuggestion}
        onClose={() => setSuggestOpen(false)}
      />
      <RewriteSheet
        open={rewriteOpen}
        body={rewriteText}
        onApply={(text) => {
          update({ body: restoreImageTokens(text, rewriteImages) });
          setRewriteOpen(false);
        }}
        onClose={() => setRewriteOpen(false)}
      />
    </div>
  );
}
