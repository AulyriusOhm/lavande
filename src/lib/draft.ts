import { ACCOUNTS } from "@/lib/accounts";

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

export function insertAt<T>(list: T[], index: number, item: T) {
  const at = index < 0 ? list.length : index;
  return [...list.slice(0, at), item, ...list.slice(at)];
}

export function firstRecipient(value: string) {
  return value.split(/[\s,;]+/).filter(Boolean)[0] ?? "";
}

export function emptyDraft(draft: ComposeDraft) {
  return !draft.to.trim() && !draft.cc.trim() && !draft.cci.trim() && !draft.subject.trim() && !draft.body.trim();
}

export function baseDraft(account: string, pgpEncrypt: boolean, pgpSign: boolean, threadId?: string): ComposeDraft {
  return { to: "", cc: "", cci: "", subject: "", body: "", account, pgpEncrypt, pgpSign, threadId };
}

export function accountOfDraft(account: string) {
  return ACCOUNTS.find((entry) => entry.id === account) ?? ACCOUNTS[0];
}
