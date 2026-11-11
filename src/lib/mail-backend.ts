/**
 * Passerelle entre le contrat HTTP du démon local et les fixtures de la
 * maquette : un `Message`/`Thread` du serveur devient un `Mail` du store, les
 * écrans existants n'ont donc rien à savoir de l'API.
 */

import { mailApi } from "@/lib/api";
import type { ApiAccount, ApiFolder, ApiMessage, ApiThread, ApiFolderRole, SendInput } from "@/lib/api";
import type { Account } from "@/lib/accounts";
import type { ComposeDraft } from "@/lib/draft";
import type { FolderId, Mail } from "@/lib/mail";
import { TONES, folderLabel } from "@/lib/mail";
import { ensureHtml, htmlToText } from "@/lib/rich-text";

export type MailMode = "api" | "demo";

const ACCOUNT_COLORS = ["#8b7cf6", "#38bdf8", "#fb7185", "#34d399", "#fbbf24", "#c084fc"];

export function mailMode(): MailMode {
  return import.meta.env.VITE_MAIL_BACKEND === "demo" ? "demo" : "api";
}

export const ROLE_TO_FOLDER: Record<ApiFolderRole, FolderId> = {
  inbox: "inbox",
  sent: "sent",
  drafts: "drafts",
  archive: "archive",
  trash: "trash",
  spam: "spam",
  other: "other",
};

export type FolderRecord = {
  accountId: string;
  path: string;
  name: string;
  role: FolderId;
};

export type FolderOption = {
  id: FolderId;
  label: string;
  path: string;
};

export function toAccount(account: ApiAccount, index: number): Account {
  const encryption = account.imap.encryption === "start_tls" ? "STARTTLS" : "TLS";
  return {
    id: account.id,
    label: account.label,
    email: account.email,
    provider: `IMAP ${encryption} · ${account.imap.host}:${account.imap.port}`,
    color: ACCOUNT_COLORS[index % ACCOUNT_COLORS.length],
    tone: index % TONES.length,
    synced:
      account.folders > 0
        ? `${account.folders} dossier${account.folders > 1 ? "s" : ""}`
        : "jamais synchronisé",
  };
}

export function toFolderRecord(folder: ApiFolder): FolderRecord {
  return {
    accountId: folder.account_id,
    path: folder.path,
    name: folder.name,
    role: ROLE_TO_FOLDER[folder.role],
  };
}

const ROLE_ORDER: FolderId[] = ["inbox", "sent", "drafts", "archive", "spam", "trash", "other"];

export function folderOptions(records: FolderRecord[], accountId: string): FolderOption[] {
  const own = records
    .filter((record) => record.accountId === accountId)
    .sort(
      (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name),
    );

  const seen = new Set<string>();
  const options: FolderOption[] = [];
  for (const record of own) {
    const key = `${record.role}:${record.role === "other" ? record.path : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({
      id: record.role,
      path: record.path,
      label: record.role === "other" ? record.name : folderLabel(record.role),
    });
  }
  return options;
}

export function folderOptionsForAll(records: FolderRecord[], accountIds: string[]): FolderOption[] {
  const seen = new Set<string>();
  const options: FolderOption[] = [];
  for (const accountId of accountIds) {
    for (const option of folderOptions(records, accountId)) {
      const key = `${option.id}:${option.id === "other" ? option.path : ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push(option.id === "other" ? option : { ...option, path: option.id });
    }
  }
  return options.sort(
    (a, b) => ROLE_ORDER.indexOf(a.id) - ROLE_ORDER.indexOf(b.id) || a.label.localeCompare(b.label),
  );
}

export function folderTargets(
  records: FolderRecord[],
  accountIds: string[],
  role: FolderId,
  path?: string,
): { accountId: string; path: string }[] {
  return accountIds.flatMap((accountId) => {
    const target = records.find(
      (record) =>
        record.accountId === accountId &&
        record.role === role &&
        (path === undefined || record.path === path),
    );
    return target ? [{ accountId, path: target.path }] : [];
  });
}

export function folderPathOf(
  records: FolderRecord[],
  accountId: string,
  role: FolderId,
): string | undefined {
  return records.find((record) => record.accountId === accountId && record.role === role)?.path;
}

function roleOf(records: FolderRecord[], accountId: string, path: string): FolderId | undefined {
  return records.find((record) => record.accountId === accountId && record.path === path)?.role;
}

const time = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
const shortDay = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
const longDay = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

function shortTime(value: string | null): string {
  const date = parseDate(value);
  if (!date) return "";
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return time.format(date);
  if (days === 1) return "Hier";
  return shortDay.format(date);
}

function longDate(value: string | null): string | undefined {
  const date = parseDate(value);
  if (!date) return undefined;
  return `${longDay.format(date)} · ${time.format(date)}`;
}

function toneOf(email: string): number {
  let hash = 0;
  for (const character of email) hash = (hash + character.charCodeAt(0)) % 997;
  return hash % TONES.length;
}

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${bytes} o`;
}

export function bodyParagraphs(text: string | null): string[] {
  if (!text) return [];
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trimEnd())
    .filter((paragraph) => paragraph.trim() !== "");
}

export function messageToMail(
  message: ApiMessage,
  records: FolderRecord[],
  fallback: FolderId,
): Mail {
  const body = bodyParagraphs(message.body_text);
  return {
    id: `${message.account_id}:${message.folder_path}:${message.uid}`,
    account: message.account_id,
    folder: roleOf(records, message.account_id, message.folder_path) ?? fallback,
    threadId: message.thread_id,
    source: {
      accountId: message.account_id,
      folderPath: message.folder_path,
      uid: message.uid,
    },
    messageId: message.message_id ?? undefined,
    references: message.references,
    bodyFetched: body.length > 0 || Boolean(message.body_html),
    name: message.from.name?.trim() || message.from.email,
    email: message.from.email,
    to: message.to.map((address) => address.email).join(", ") || undefined,
    subject: message.subject || "(sans objet)",
    preview: message.preview || body[0] || "…",
    body,
    html: message.body_html ?? undefined,
    time: shortTime(message.date),
    date: longDate(message.date),
    unread: message.flags.unread,
    starred: message.flags.starred,
    pgp: message.pgp,
    pgp_detail: message.pgp_detail ?? null,
    attachments: message.attachments.map((file) => ({ name: file.filename, size: size(file.size) })),
    tone: toneOf(message.from.email),
  };
}

export function threadToMails(
  thread: ApiThread,
  records: FolderRecord[],
  fallback: FolderId,
): Mail[] {
  return thread.messages.map((message) => messageToMail(message, records, fallback));
}

export async function loadMailbox(): Promise<{
  accounts: Account[];
  folders: FolderRecord[];
}> {
  const summaries = await mailApi.accounts();
  const folders = await Promise.all(summaries.map((summary) => mailApi.folders(summary.id)));
  return {
    accounts: summaries.map(toAccount),
    folders: folders.flat().map(toFolderRecord),
  };
}

export function syncNotice(reports: { inserted: number; flags_updated: number; removed: number }[]): string {
  const report = reports[0];
  if (!report) return "Synchronisation terminée";
  const parts = [`${report.inserted} nouveau${report.inserted > 1 ? "x" : ""} message${report.inserted > 1 ? "s" : ""}`];
  if (report.flags_updated > 0) parts.push(`${report.flags_updated} drapeau${report.flags_updated > 1 ? "x" : ""} mis à jour`);
  if (report.removed > 0) parts.push(`${report.removed} supprimé${report.removed > 1 ? "s" : ""}`);
  return `Synchro · ${parts.join(" · ")}`;
}

export function splitAddresses(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function sendInputOf(draft: ComposeDraft, signatureHtml?: string | null): SendInput {
  const recipients = (value: string) =>
    splitAddresses(value).map((email) => ({ name: null, email }));
  const withSignature = draft.includeSignature !== false && Boolean(signatureHtml?.trim());
  const bodyHtml = ensureHtml(draft.body);
  const bodyText = htmlToText(draft.body);
  const html = withSignature ? `${bodyHtml}<br>${signatureHtml}` : bodyHtml;
  const text = withSignature ? `${bodyText}\n\n${htmlToText(signatureHtml ?? "")}` : bodyText;
  return {
    to: recipients(draft.to),
    cc: recipients(draft.cc),
    bcc: recipients(draft.cci),
    subject: draft.subject.trim() || "(sans objet)",
    text,
    ...(html ? { html } : {}),
    pgp_encrypt: draft.pgpEncrypt,
    pgp_sign: draft.pgpSign,
    ...(draft.inReplyTo ? { in_reply_to: draft.inReplyTo } : {}),
    ...(draft.references?.length ? { references: draft.references } : {}),
  };
}

export function accountSlug(email: string): string {
  const slug = email
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "compte";
}
