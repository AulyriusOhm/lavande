import { isHtmlEmpty } from "@/lib/rich-text";

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
  threadId?: string;
  inReplyTo?: string;
  references?: string[];
};

export function insertAt<T>(list: T[], index: number, item: T) {
  const at = index < 0 ? list.length : index;
  return [...list.slice(0, at), item, ...list.slice(at)];
}

export function firstRecipient(value: string) {
  return value.split(/[\s,;]+/).filter(Boolean)[0] ?? "";
}

export function emptyDraft(draft: ComposeDraft) {
  return !draft.to.trim() && !draft.cc.trim() && !draft.cci.trim() && !draft.subject.trim() && isHtmlEmpty(draft.body);
}

export function baseDraft(account: string, pgpEncrypt: boolean, pgpSign: boolean, threadId?: string): ComposeDraft {
  return { to: "", cc: "", cci: "", subject: "", body: "", account, pgpEncrypt, pgpSign, includeSignature: true, threadId };
}
