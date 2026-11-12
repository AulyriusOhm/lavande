import { isHtmlEmpty } from "@/lib/rich-text";

/** Une pièce jointe du brouillon : les octets voyagent en base64. */
export type DraftAttachment = {
  filename: string;
  mime: string;
  data_base64: string;
  size: number;
};

export type ComposeDraft = {
  to: string;
  cc: string;
  cci: string;
  subject: string;
  body: string;
  account: string;
  pgpEncrypt: boolean;
  pgpSign: boolean;
  includeSignature?: boolean;
  attachments?: DraftAttachment[];
  threadId?: string;
  inReplyTo?: string;
  references?: string[];
};

/** 25 Mo par fichier, et autant pour l'ensemble : le démon encode tout en base64. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const MIMES: Record<string, string> = {
  avif: "image/avif",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  gz: "application/gzip",
  heic: "image/heic",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  odp: "application/vnd.oasis.opendocument.presentation",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odt: "application/vnd.oasis.opendocument.text",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  tar: "application/x-tar",
  txt: "text/plain",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

/** Type MIME déduit du nom : certains systèmes ne renseignent pas `File.type`. */
export function mimeOf(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIMES[extension] ?? "application/octet-stream";
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${bytes} o`;
}

export function attachmentsSize(attachments: DraftAttachment[] | undefined): number {
  return (attachments ?? []).reduce((total, attachment) => total + attachment.size, 0);
}

/** Taille des octets portés par un base64, sans les décoder. */
export function base64Size(data: string): number {
  return Math.floor((data.replace(/=+$/, "").length * 3) / 4);
}

/**
 * Ce qui survit à un rechargement : le brouillon est écrit dans le
 * `localStorage`, dont le quota ne supporte pas 25 Mo de base64. Au-delà d'un
 * mégaoctet de pièces jointes, elles restent dans la fenêtre ouverte et le
 * texte seul est persisté.
 */
const PERSISTED_ATTACHMENT_BYTES = 1024 * 1024;

export function persistedDraft(draft: ComposeDraft): ComposeDraft {
  if (attachmentsSize(draft.attachments) <= PERSISTED_ATTACHMENT_BYTES) return draft;
  return { ...draft, attachments: undefined };
}

/** Les octets d'un fichier en base64 : le format que le démon attend. */
export function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("lecture des octets impossible"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      resolve(separator < 0 ? "" : result.slice(separator + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/** Lit un fichier choisi par l'utilisateur en refusant ceux qui sont trop lourds. */
export function readAttachment(file: File): Promise<DraftAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return Promise.reject(
      new Error(`« ${file.name} » est trop lourd : ${formatBytes(MAX_ATTACHMENT_BYTES)} maximum par fichier.`),
    );
  }
  const mime = file.type || mimeOf(file.name);
  return readBase64(file).then((data_base64) => ({
    filename: file.name,
    mime,
    data_base64,
    size: file.size,
  }));
}

export function insertAt<T>(list: T[], index: number, item: T) {
  const at = index < 0 ? list.length : index;
  return [...list.slice(0, at), item, ...list.slice(at)];
}

export function firstRecipient(value: string) {
  return value.split(/[\s,;]+/).filter(Boolean)[0] ?? "";
}

export function emptyDraft(draft: ComposeDraft) {
  return (
    !draft.to.trim() &&
    !draft.cc.trim() &&
    !draft.cci.trim() &&
    !draft.subject.trim() &&
    !draft.attachments?.length &&
    isHtmlEmpty(draft.body)
  );
}

export function baseDraft(account: string, pgpEncrypt: boolean, pgpSign: boolean, threadId?: string): ComposeDraft {
  return { to: "", cc: "", cci: "", subject: "", body: "", account, pgpEncrypt, pgpSign, includeSignature: true, threadId };
}
