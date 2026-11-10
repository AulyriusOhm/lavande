import type { FolderId, Mail } from "@/lib/mail";
import { ALL_ACCOUNTS } from "@/lib/accounts";

export type Thread = {
  id: string;
  messages: Mail[];
  primary: Mail;
  count: number;
  unread: number;
  starred: boolean;
  encrypted: number;
  attachments: number;
  participants: string[];
  subject: string;
  preview: string;
  time: string;
  order: number;
};

export function threadKey(mail: Mail): string {
  return `${mail.account}:${mail.threadId ?? mail.id}`;
}

export function buildThreads(mails: Mail[]): Thread[] {
  const groups = new Map<string, { mail: Mail; index: number }[]>();

  mails.forEach((mail, index) => {
    const key = threadKey(mail);
    const group = groups.get(key);
    if (group) group.push({ mail, index });
    else groups.set(key, [{ mail, index }]);
  });

  return Array.from(groups.entries())
    .map(([id, entries]) => {
      const chronological = entries
        .slice()
        .sort((a, b) => b.index - a.index)
        .map((entry) => entry.mail);
      const primary = chronological[chronological.length - 1];
      const oldest = chronological[0];

      const participants: string[] = [];
      const seen = new Set<string>();
      chronological.forEach((message) => {
        if (message.folder === "sent" || seen.has(message.email)) return;
        seen.add(message.email);
        participants.push(message.name);
      });

      const firstName = primary.name.split(" ")[0];

      return {
        id,
        messages: chronological,
        primary,
        count: chronological.length,
        unread: chronological.filter((message) => message.unread).length,
        starred: chronological.some((message) => message.starred),
        encrypted: chronological.filter((message) => message.pgp === "encrypted").length,
        attachments: chronological.reduce((total, message) => total + (message.attachments?.length ?? 0), 0),
        participants,
        subject: oldest.subject,
        preview: primary.folder === "sent" ? primary.preview : `${firstName} : ${primary.preview}`,
        time: primary.time,
        order: entries.reduce((best, entry) => Math.min(best, entry.index), Number.MAX_SAFE_INTEGER),
      };
    })
    .sort((a, b) => a.order - b.order);
}

export function threadsInFolder(mails: Mail[], folder: FolderId, account?: string): Thread[] {
  return buildThreads(mails)
    .filter((thread) => !account || account === ALL_ACCOUNTS || thread.primary.account === account)
    .filter((thread) => thread.messages.some((message) => message.folder === folder))
    .map((thread) => anchorOn(thread, folder));
}

function anchorOn(thread: Thread, folder: FolderId): Thread {
  const inFolder = thread.messages.filter((message) => message.folder === folder);
  const primary = inFolder[inFolder.length - 1] ?? thread.primary;
  return {
    ...thread,
    primary,
    unread: inFolder.filter((message) => message.unread).length,
    time: primary.time,
    preview: primary.folder === "sent" ? primary.preview : `${primary.name.split(" ")[0]} : ${primary.preview}`,
  };
}

export function threadOf(mails: Mail[], mail: Mail): Thread | undefined {
  return buildThreads(mails).find((thread) => thread.messages.some((message) => message.id === mail.id));
}
