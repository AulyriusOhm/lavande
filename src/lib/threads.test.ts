import { describe, expect, it } from "vitest";
import { MAILS } from "@/lib/mail";
import type { FolderId, Mail } from "@/lib/mail";
import { ALL_ACCOUNTS } from "@/lib/accounts";
import { threadsInFolder } from "@/lib/threads";

const mail = (
  id: string,
  folder: FolderId,
  options: { account?: string; threadId?: string; timestamp?: number; unread?: boolean } = {},
): Mail => ({
  id,
  account: options.account ?? "perso",
  folder,
  threadId: options.threadId ?? `t-${id}`,
  name: "Camille",
  email: "camille@test.fr",
  subject: `Sujet ${id}`,
  preview: `Aperçu ${id}`,
  body: [],
  time: "10:00",
  timestamp: options.timestamp,
  unread: options.unread ?? false,
  starred: false,
  pgp: "none",
  tone: 0,
});

describe("threadsInFolder · boîte unifiée", () => {
  it("mélange les dossiers de tous les comptes, corbeille et spam exclus", () => {
    const mails = [
      mail("inbox-perso", "inbox", { timestamp: 3 }),
      mail("sent-perso", "sent", { timestamp: 2 }),
      mail("custom-pro", "other", { account: "pro", timestamp: 1 }),
      mail("trash-perso", "trash", { timestamp: 9 }),
      mail("spam-pro", "spam", { account: "pro", timestamp: 9 }),
    ];

    expect(threadsInFolder(mails, "unified", ALL_ACCOUNTS).map((thread) => thread.primary.id)).toEqual([
      "inbox-perso",
      "sent-perso",
      "custom-pro",
    ]);
  });

  it("trie les conversations par activité la plus récente", () => {
    const mails = [
      mail("vieux", "inbox", { timestamp: 100 }),
      mail("recent", "archive", { timestamp: 300 }),
      mail("moyen", "drafts", { timestamp: 200 }),
    ];

    expect(threadsInFolder(mails, "unified").map((thread) => thread.primary.id)).toEqual([
      "recent",
      "moyen",
      "vieux",
    ]);
  });

  it("ordonne les messages d'un fil par date, pas par ordre de chargement", () => {
    const mails = [
      mail("recu-recent", "inbox", { threadId: "fil", timestamp: 200 }),
      mail("envoye-vieux", "sent", { threadId: "fil", timestamp: 100 }),
    ];

    const [thread] = threadsInFolder(mails, "unified", ALL_ACCOUNTS);

    expect(thread.messages.map((message) => message.id)).toEqual(["envoye-vieux", "recu-recent"]);
    expect(thread.primary.id).toBe("recu-recent");
  });

  it("retombe sur zéro sans horodatage", () => {
    const mails = [mail("sans-date", "inbox"), mail("date", "inbox", { timestamp: 5 })];

    expect(threadsInFolder(mails, "unified").map((thread) => thread.primary.id)).toEqual([
      "date",
      "sans-date",
    ]);
  });

  it("fusionne réception et envoyés d'un même fil, une seule conversation", () => {
    const mails = [
      mail("recu", "inbox", { threadId: "t-fil", timestamp: 10, unread: true }),
      mail("envoye", "sent", { threadId: "t-fil", timestamp: 20 }),
    ];

    const threads = threadsInFolder(mails, "unified");

    expect(threads).toHaveLength(1);
    expect(threads[0]?.messages.map((message) => message.id)).toEqual(["recu", "envoye"]);
    expect(threads[0]?.count).toBe(2);
    expect(threads[0]?.unread).toBe(1);
  });

  it("ne fusionne pas deux comptes qui partagent un identifiant de fil", () => {
    const mails = [
      mail("perso", "inbox", { threadId: "t-partage", timestamp: 10 }),
      mail("pro", "inbox", { account: "pro", threadId: "t-partage", timestamp: 20 }),
    ];

    expect(threadsInFolder(mails, "unified")).toHaveLength(2);
  });

  it("ignore le message de corbeille d'une conversation encore vivante", () => {
    const mails = [
      mail("garde", "inbox", { threadId: "t-fil", timestamp: 10 }),
      mail("jete", "trash", { threadId: "t-fil", timestamp: 30 }),
    ];

    const threads = threadsInFolder(mails, "unified");

    expect(threads).toHaveLength(1);
    expect(threads[0]?.messages.map((message) => message.id)).toEqual(["garde"]);
    expect(threads[0]?.primary.id).toBe("garde");
  });

  it("écarte une conversation entièrement en corbeille ou en spam", () => {
    const mails = [
      mail("corbeille", "trash", { timestamp: 30 }),
      mail("spam", "spam", { timestamp: 20 }),
    ];

    expect(threadsInFolder(mails, "unified")).toEqual([]);
  });

  it("respecte le compte demandé", () => {
    const mails = [
      mail("perso", "inbox", { timestamp: 10 }),
      mail("pro", "inbox", { account: "pro", timestamp: 20 }),
    ];

    expect(threadsInFolder(mails, "unified", "pro").map((thread) => thread.primary.id)).toEqual(["pro"]);
  });

  it("exclut corbeille et spam de la démo sans toucher aux autres dossiers", () => {
    const unified = threadsInFolder(MAILS, "unified", ALL_ACCOUNTS);
    const folders = unified.flatMap((thread) => thread.messages.map((message) => message.folder));

    expect(unified.length).toBeGreaterThan(0);
    expect(folders).not.toContain("trash");
    expect(folders).not.toContain("spam");
    expect(new Set(folders)).toEqual(new Set(["inbox", "sent", "drafts", "archive"]));
  });

  it("garde l'ancrage par dossier des autres vues", () => {
    const mails = [
      mail("recu", "inbox", { threadId: "t-fil", timestamp: 10 }),
      mail("envoye", "sent", { threadId: "t-fil", timestamp: 20 }),
    ];

    expect(threadsInFolder(mails, "inbox").map((thread) => thread.primary.id)).toEqual(["recu"]);
    expect(threadsInFolder(mails, "sent").map((thread) => thread.primary.id)).toEqual(["envoye"]);
  });
});
