import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ComposeDraft, DraftAttachment } from "@/lib/draft";
import { MAX_ATTACHMENT_BYTES, attachmentsSize, formatBytes, readAttachment } from "@/lib/draft";
import {
  Check,
  ChevronDown,
  Image,
  PenLine,
  Loader2,
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
import {
  aiComposeReply,
  composeReply,
  replySuggestions,
  sentSamples,
  styleProfile,
  threadConversation,
  userPart,
  type ReplySuggestion,
} from "@/lib/assist";
import { teamContextOf, teamPromptBlock } from "@/lib/team";
import { llmReady } from "@/lib/llm";
import { ReplySuggestSheet, RewriteSheet } from "@/screens/assist-sheet";
import { IconButton } from "@/components/ui/primitives";
import { useEscapeLayer } from "@/desktop/escape";
import { useBackLayer } from "@/lib/back";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { RichEditor } from "@/components/ui/rich-editor";
import { ensureHtml, extractImageTokens, htmlToText, restoreImageTokens, textToHtml, isHtmlEmpty, sanitizeHtml } from "@/lib/rich-text";
import { activeSignature, resolvePgp, usePrefs } from "@/lib/prefs";
import { ConversationPanel } from "@/components/conversation-panel";
import { QuotedBlock } from "@/components/quoted-block";
import { splitAddresses } from "@/lib/mail";
import type { Mail } from "@/lib/mail";
import {
  RecipientSuggestions,
  useRecipientAutocomplete,
  type RecipientField,
} from "@/components/recipient-suggestions";

export type { ComposeDraft };

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;

const invalidRecipients = (draft: ComposeDraft) =>
  [...splitAddresses(draft.to), ...splitAddresses(draft.cc), ...splitAddresses(draft.cci)].filter(
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
  sending = false,
  sendError,
  headerActions,
  onHeaderPointerDown,
  onHeaderDoubleClick,
  onRetarget,
}: {
  onClose: () => void;
  draft: ComposeDraft;
  onDraftChange: (draft: ComposeDraft) => void;
  onSend?: (draft: ComposeDraft) => void;
  onMinimize?: () => void;
  title?: string;
  sent?: boolean;
  sending?: boolean;
  sendError?: string | null;
  headerActions?: ReactNode;
  onHeaderPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onHeaderDoubleClick?: () => void;
  /** Réorienter le brouillon vers un autre message ; à défaut, le store s'en charge. */
  onRetarget?: (mail: Mail) => void;
}) {
  const {
    mailAccounts,
    mails,
    openThread,
    saveToDrafts,
    mode,
    folderRecords,
    readOnly,
    setReplyTarget,
  } = useMailStore();
  const retarget = onRetarget ?? setReplyTarget;
  const prefs = usePrefs();
  const { signatures, llm, aiReplyEnabled, threadView } = prefs;
  const accountSignature = activeSignature(signatures, draft.account);
  const [showCc, setShowCc] = useState(Boolean(draft.cc.trim()));
  const [showCci, setShowCci] = useState(Boolean(draft.cci.trim()));
  const [recipientsOpen, setRecipientsOpen] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftSaveError, setDraftSaveError] = useState<string | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [rewriteOpen, setRewriteOpen] = useState(false);
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

  const setRecipient = (field: RecipientField, value: string) =>
    update(field === "to" ? { to: value } : field === "cc" ? { cc: value } : { cci: value });

  const autocomplete = useRecipientAutocomplete(
    { to: draft.to, cc: draft.cc, cci: draft.cci },
    setRecipient,
  );

  const suggestionsFor = (field: RecipientField) =>
    autocomplete.field === field && autocomplete.open ? (
      <RecipientSuggestions
        options={autocomplete.options}
        active={autocomplete.active}
        onPick={autocomplete.pick}
      />
    ) : null;

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
  const recipientGroups = [
    { label: "À", addresses: splitAddresses(draft.to) },
    { label: "Cc", addresses: splitAddresses(draft.cc) },
    { label: "Cci", addresses: splitAddresses(draft.cci) },
  ].filter((group) => group.addresses.length > 0);
  const recipientCount = recipientGroups.reduce((total, group) => total + group.addresses.length, 0);
  const recipientSummary = recipientGroups
    .map((group) => `${group.addresses.length} ${group.label}`)
    .join(" · ");
  const hasRecipient = [draft.to, draft.cc, draft.cci].some((value) =>
    splitAddresses(value).some((token) => EMAIL.test(token)),
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
    if (sending || sent) return;
    setConfirmSend(false);
    onSend?.(draft);
    if (!onSend) onClose();
  };

  const requestSend = () => {
    if (!validRecipients || sent || sending) return;
    if (!draft.subject.trim() || !draft.body.trim()) {
      setConfirmSend(true);
      return;
    }
    send();
  };

  const cancelClose = () => {
    setConfirmClose(false);
    setDraftSaveError(null);
  };

  useEscapeLayer(confirmClose, cancelClose);
  useBackLayer(confirmClose, cancelClose);

  const requestClose = () => {
    if (dirty && !sent) {
      setDraftSaveError(null);
      setConfirmClose(true);
      return;
    }
    onClose();
  };

  const minimize = () => {
    cancelClose();
    onMinimize?.();
  };

  const handleSaveDraft = async () => {
    if (savingDraft) return;
    setSavingDraft(true);
    setDraftSaveError(null);
    const saved = await saveToDrafts(draft);
    if (saved) {
      onClose();
      return;
    }
    setSavingDraft(false);
    setDraftSaveError("Brouillon non enregistré · réessaie, ou supprime le message.");
  };

  const applySuggestion = (suggestion: ReplySuggestion) => {
    const suggestionHtml = textToHtml(suggestion.text);
    update({
      body: isHtmlEmpty(draft.body) ? suggestionHtml : suggestionHtml + ensureHtml(draft.body),
    });
    setSuggestOpen(false);
  };

  return (
    <div className="relative flex h-full flex-col bg-canvas">
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
            <IconButton aria-label="Réduire le brouillon" onClick={minimize}>
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
            {mailAccounts.map((entry) => (
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
          <div className="relative min-w-0 flex-1">
            <input
              id="compose-to"
              {...autocomplete.bind("to")}
              value={draft.to}
              placeholder="destinataire@mail.com"
              className="w-full bg-transparent text-[13.5px] font-medium text-ink outline-none placeholder:text-ink-soft"
            />
            {suggestionsFor("to")}
          </div>
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
            <div className="relative min-w-0 flex-1">
              <input
                id="compose-cc"
                {...autocomplete.bind("cc")}
                value={draft.cc}
                placeholder="copie@mail.com"
                className="w-full bg-transparent text-[13.5px] font-medium text-ink outline-none placeholder:text-ink-soft"
              />
              {suggestionsFor("cc")}
            </div>
          </div>
        )}

        {showCci && (
          <div className="flex items-center gap-2 border-b border-line py-3">
            <label htmlFor="compose-cci" className="text-[12px] font-bold tracking-[0.1em] text-ink-muted uppercase">
              Cci
            </label>
            <div className="relative min-w-0 flex-1">
              <input
                id="compose-cci"
                {...autocomplete.bind("cci")}
                value={draft.cci}
                placeholder="copie cachée@mail.com"
                className="w-full bg-transparent text-[13.5px] font-medium text-ink outline-none placeholder:text-ink-soft"
              />
              {suggestionsFor("cci")}
            </div>
          </div>
        )}

        {invalid.length > 0 && (
          <p role="alert" className="border-b border-line py-2 text-[11.5px] font-semibold text-red-600 dark:text-red-300">
            Adresse{invalid.length > 1 ? "s" : ""} invalide{invalid.length > 1 ? "s" : ""} : {invalid.join(", ")}
          </p>
        )}

        {recipientCount > 0 && (
          <div className="border-b border-line">
            <button
              type="button"
              data-testid="compose-recipients"
              aria-expanded={recipientsOpen}
              onClick={() => setRecipientsOpen((value) => !value)}
              className="inline-flex min-h-11 items-center gap-1.5 text-[11.5px] font-semibold text-ink-muted transition-colors hover:text-ink"
            >
              <ChevronDown
                className={cn("size-3.5 shrink-0 transition-transform", recipientsOpen && "rotate-180")}
              />
              {`${recipientCount} destinataire${recipientCount > 1 ? "s" : ""}`}
              <span className="text-ink-soft">{` · ${recipientSummary}`}</span>
            </button>

            {recipientsOpen && (
              <dl data-testid="compose-recipients-detail" className="space-y-1.5 pb-2 pl-5">
                {recipientGroups.map((group) => (
                  <div key={group.label} className="flex gap-2 text-[11.5px] font-medium">
                    <dt className="w-5 shrink-0 font-bold text-ink-muted">{group.label}</dt>
                    <dd className="min-w-0 flex-1">
                      <ul className="space-y-0.5 text-ink-soft">
                        {group.addresses.map((address, index) => (
                          <li key={`${address}-${index}`} className="break-all">
                            {address}
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
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

        {threadView === "tidy" ? (
          <ConversationPanel
            draft={draft}
            mode={mode}
            records={folderRecords}
            onRetarget={retarget}
            readOnly={readOnly}
          />
        ) : (
          <QuotedBlock quoted={draft.quoted} />
        )}

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
              disabled={sending}
              className="inline-flex min-h-11 items-center rounded-full bg-accent px-3 text-[12px] font-bold text-accent-contrast disabled:pointer-events-none disabled:opacity-50"
            >
              Envoyer
            </button>
          </div>
        )}

        <div className="flex items-center gap-2">
          <ShimmerButton
            className="flex-1"
            disabled={!validRecipients || sent || sending}
            aria-label={validRecipients ? "Envoyer le message" : "Envoyer, destinataire valide requis"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={requestSend}
          >
            {sent ? (
              <Check className="size-4" />
            ) : sending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            {sent ? "Envoyé" : sending ? "Envoi…" : "Envoyer"}
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

      {confirmClose && (
        <div className="absolute inset-0 z-50 grid place-items-center p-4">
          <div
            aria-hidden
            data-testid="compose-close-backdrop"
            onClick={cancelClose}
            className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]"
          />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Enregistrer ou supprimer le brouillon"
            aria-describedby="compose-close-help"
            className="relative w-full max-w-[380px] rounded-[26px] border border-line bg-surface p-4 shadow-[0_44px_96px_-48px_var(--accent)]"
          >
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent-ink">
                <PenLine className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2
                  id="compose-close-question"
                  className="text-[15px] leading-tight font-extrabold tracking-[-0.02em] text-ink"
                >
                  Enregistrer ce message avant de fermer ?
                </h2>
                <p
                  id="compose-close-help"
                  className="mt-1 text-[11.5px] leading-relaxed font-semibold text-ink-muted"
                >
                  Brouillons garde le message · Supprimer le jette · Annuler revient à la rédaction.
                </p>
              </div>
            </div>
            {draftSaveError && (
              <p
                role="alert"
                className="mt-3 rounded-2xl bg-red-500/10 px-3 py-2 text-[11.5px] font-semibold text-red-600 dark:text-red-300"
              >
                {draftSaveError}
              </p>
            )}
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                autoFocus
                onClick={cancelClose}
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
                disabled={savingDraft}
                aria-busy={savingDraft}
                onClick={() => void handleSaveDraft()}
                className="inline-flex min-h-11 items-center rounded-full bg-accent px-3 text-[12px] font-bold text-accent-contrast disabled:pointer-events-none disabled:opacity-60"
              >
                Brouillons
              </button>
            </div>
          </div>
        </div>
      )}

      <ReplySuggestSheet
        open={suggestOpen}
        suggestions={suggestions}
        generate={async (brief) => {
          const input = { subject: draft.subject, to: draft.to, body: htmlToText(draft.body) };
          if (!llmReady(llm) || !aiReplyEnabled) return composeReply({ ...input, brief });
          const conversation = threadConversation(openThread?.messages, mails ?? [], draft.threadId);
          const team = teamPromptBlock(teamContextOf(prefs, draft.account));
          const style = await styleProfile(llm, draft.account, await sentSamples(draft.account));
          return aiComposeReply(llm, { ...input, conversation }, brief, { team, style });
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
