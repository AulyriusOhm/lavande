/**
 * Passerelle entre le contrat HTTP du démon local et les fixtures de la
 * maquette : un `Message`/`Thread` du serveur devient un `Mail` du store, les
 * écrans existants n'ont donc rien à savoir de l'API.
 */

import { mailApi } from "@/lib/api";
import type { ApiAccount, ApiFolder, ApiMessage, ApiThread, ApiFolderRole, SendInput } from "@/lib/api";
import type { Account } from "@/lib/accounts";
import type { ComposeDraft } from "@/lib/draft";
import { formatBytes } from "@/lib/draft";
import type { FolderId, Mail, MailSource } from "@/lib/mail";
import { TONES, UNIFIED_FOLDERS, folderLabel, splitAddresses } from "@/lib/mail";
import { ensureHtml, htmlToText } from "@/lib/rich-text";

export { demoReadOnly, mailMode, READ_ONLY_NOTICE } from "@/lib/demo-mode";
export type { MailMode } from "@/lib/demo-mode";

const ACCOUNT_COLORS = ["#8b7cf6", "#38bdf8", "#fb7185", "#34d399", "#fbbf24", "#c084fc"];

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
  delimiter?: string | null;
};

export type FolderOption = {
  id: FolderId;
  label: string;
  path: string;
  delimiter?: string | null;
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
    syncedFolders: account.synced_folders ?? null,
    aiFolders: account.ai_folders ?? null,
    oauth: account.auth_kind === "oauth2",
    needsReauth: account.needs_reauth === true,
  };
}

export function toFolderRecord(folder: ApiFolder): FolderRecord {
  return {
    accountId: folder.account_id,
    path: folder.path,
    name: folder.name,
    role: ROLE_TO_FOLDER[folder.role],
    delimiter: folder.delimiter ?? null,
  };
}

const ROLE_ORDER: FolderId[] = ["inbox", "sent", "drafts", "archive", "spam", "trash", "other"];

/** Dossiers de la réception : ce qu'analyse l'IA quand le compte n'a rien choisi. */
export const RECEPTION_ROLES: FolderId[] = ["inbox", "other"];

/** Chemins de la réception d'un compte, dans l'ordre du serveur. */
export function receptionPaths(folders: ApiFolder[]): string[] {
  return folders
    .filter((folder) => RECEPTION_ROLES.includes(ROLE_TO_FOLDER[folder.role]))
    .map((folder) => folder.path);
}

/** `true` quand la sélection vaut la réception : le compte garde alors `null`. */
export function isReceptionSelection(paths: string[], folders: ApiFolder[]): boolean {
  const reception = receptionPaths(folders);
  return paths.length === reception.length && reception.every((path) => paths.includes(path));
}

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
      delimiter: record.delimiter ?? null,
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
  if (role === "unified") {
    const seen = new Set<string>();
    const targets: { accountId: string; path: string }[] = [];
    for (const accountId of accountIds) {
      for (const record of records) {
        if (record.accountId !== accountId || !UNIFIED_FOLDERS.includes(record.role)) continue;
        const key = `${record.accountId}:${record.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({ accountId, path: record.path });
      }
    }
    return targets;
  }
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

function leafOf(path: string): string {
  return path.split(/[/.]/).filter(Boolean).pop() ?? path;
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

/** Le repli de la liste tant que le serveur n'a pas rendu d'aperçu. */
export const PREVIEW_PENDING = "Aperçu chargé à l'ouverture";

export function bodyParagraphs(text: string | null): string[] {
  if (!text) return [];
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trimEnd())
    .filter((paragraph) => paragraph.trim() !== "");
}

export function messageToMail(message: ApiMessage, records: FolderRecord[]): Mail {
  const body = bodyParagraphs(message.body_text);
  const record = records.find(
    (entry) => entry.accountId === message.account_id && entry.path === message.folder_path,
  );
  const folder = record?.role ?? "other";
  return {
    id: `${message.account_id}:${message.folder_path}:${message.uid}`,
    account: message.account_id,
    folder,
    folderName:
      folder === "other" ? record?.name || leafOf(message.folder_path) : undefined,
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
    cc: message.cc.map((address) => address.email).join(", ") || undefined,
    subject: message.subject || "(sans objet)",
    preview: message.preview || body[0] || PREVIEW_PENDING,
    body,
    html: message.body_html ?? undefined,
    time: shortTime(message.date),
    date: longDate(message.date),
    timestamp: parseDate(message.date)?.getTime(),
    unread: message.flags.unread,
    starred: message.flags.starred,
    answered: message.flags.answered,
    pgp: message.pgp,
    pgp_detail: message.pgp_detail ?? null,
    attachments: message.attachments.map((file, index) => ({
      name: file.filename,
      size: formatBytes(file.size),
      mime: file.mime,
      index,
      inline: file.inline,
    })),
    tone: toneOf(message.from.email),
  };
}

export function threadToMails(thread: ApiThread, records: FolderRecord[]): Mail[] {
  return thread.messages.map((message) => messageToMail(message, records));
}

/** Le fil complet d'un message, tous dossiers du compte confondus. */
export async function threadMails(
  accountId: string,
  threadId: string,
  records: FolderRecord[],
): Promise<Mail[]> {
  return threadToMails(await mailApi.thread(accountId, threadId), records);
}

/** Politique PGP poussée par le store : `false` = compte laissé fermé. */
let decryptPolicy: Record<string, boolean> = {};

export function setAccountDecryptPolicy(next: Record<string, boolean>): void {
  decryptPolicy = { ...next };
}

export function accountDecrypts(accountId: string): boolean {
  return decryptPolicy[accountId] !== false;
}

/**
 * Le corps HTML d'un message relu sur le serveur avec ses images distantes.
 *
 * Le corps stocké n'en porte aucune (pixels de tracking retirés à l'ingestion) :
 * c'est un choix explicite du lecteur, message par message, et le service
 * ré-assainit le markup avant de le rendre. Seul un message `encrypted` d'un
 * compte dont l'interrupteur PGP est fermé est refusé : le démon le relirait
 * avec un trousseau vide et le rendu n'aurait aucun sens. Un message en clair
 * n'a besoin d'aucune clé, la politique du compte ne le concerne pas.
 */
export async function htmlImagesOf(source: MailSource, encrypted: boolean): Promise<string> {
  if (encrypted && !accountDecrypts(source.accountId)) {
    throw new Error("PGP désactivé pour ce compte · message chiffré laissé fermé");
  }
  const { html } = await mailApi.htmlImages(source.accountId, source.folderPath, source.uid);
  return html;
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

export function sendInputOf(draft: ComposeDraft, signatureHtml?: string | null): SendInput {
  const recipients = (value: string) =>
    splitAddresses(value).map((email) => ({ name: null, email }));
  const withSignature = draft.includeSignature !== false && Boolean(signatureHtml?.trim());
  const bodyHtml = ensureHtml(draft.body);
  const bodyText = htmlToText(draft.body);
  const quotedHtml = draft.quoted?.trim() ? ensureHtml(draft.quoted) : "";
  const headHtml = withSignature ? `${bodyHtml}<br>${signatureHtml}` : bodyHtml;
  const headText = withSignature ? `${bodyText}\n\n${htmlToText(signatureHtml ?? "")}` : bodyText;
  const html = quotedHtml ? `${headHtml}<br><br>${quotedHtml}` : headHtml;
  const text = quotedHtml ? `${headText}\n\n${htmlToText(quotedHtml)}` : headText;
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
    ...(draft.attachments?.length
      ? {
          attachments: draft.attachments.map(({ filename, mime, data_base64 }) => ({
            filename,
            mime,
            data_base64,
          })),
        }
      : {}),
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
