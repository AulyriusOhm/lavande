import { afterEach, describe, expect, it, vi } from "vitest";
import { buildQuotedHtml } from "@/lib/rich-text";
import {
  accountDecrypts,
  folderOptionsForAll,
  folderTargets,
  htmlImagesOf,
  messageToMail,
  sendInputOf,
  setAccountDecryptPolicy,
} from "@/lib/mail-backend";
import type { FolderRecord } from "@/lib/mail-backend";
import type { ApiMessage } from "@/lib/api";
import type { ComposeDraft } from "@/lib/draft";
import { baseDraft } from "@/lib/draft";

const record = (accountId: string, role: FolderRecord["role"], path: string, name: string): FolderRecord => ({
  accountId,
  role,
  path,
  name,
});

const RECORDS: FolderRecord[] = [
  record("perso", "trash", "Trash", "Corbeille"),
  record("perso", "inbox", "INBOX", "Boîte de réception"),
  record("perso", "other", "Archive/2024", "2024"),
  record("pro", "sent", "Sent", "Envoyés"),
  record("pro", "inbox", "INBOX", "Inbox"),
  record("pro", "other", "Archive/2024", "Archives 2024"),
  record("pro", "other", "Projets", "Projets"),
  record("perso", "other", "Voyages", "Voyages"),
];

describe("folderOptionsForAll", () => {
  it("fait l'union dédoublonnée des rôles de tous les comptes", () => {
    const options = folderOptionsForAll(RECORDS, ["perso", "pro"]);

    expect(options.filter((option) => option.id !== "other").map((option) => option.id)).toEqual([
      "inbox",
      "sent",
      "trash",
    ]);
  });

  it("respecte l'ordre des rôles et met le rôle comme chemin des entrées agrégées", () => {
    const records: FolderRecord[] = [
      record("a", "other", "Divers", "Divers"),
      record("a", "trash", "Trash", "Corbeille"),
      record("a", "archive", "Archive", "Archives"),
      record("a", "sent", "Sent", "Envoyés"),
      record("a", "inbox", "INBOX", "Boîte de réception"),
    ];

    const options = folderOptionsForAll(records, ["a"]);

    expect(options.map((option) => option.id)).toEqual(["inbox", "sent", "archive", "trash", "other"]);
    expect(options.find((option) => option.id === "inbox")?.path).toBe("inbox");
    expect(options.find((option) => option.id === "trash")?.path).toBe("trash");
    expect(options.find((option) => option.id === "other")?.path).toBe("Divers");
  });

  it("dédoublonne le rôle other par chemin, avec le nom du dossier en libellé", () => {
    const options = folderOptionsForAll(RECORDS, ["perso", "pro"]);

    const others = options.filter((option) => option.id === "other");
    expect(others.map((option) => option.path)).toEqual(["Archive/2024", "Projets", "Voyages"]);
    expect(others.map((option) => option.label)).toEqual(["2024", "Projets", "Voyages"]);
  });

  it("ignore les comptes absents de la liste demandée", () => {
    const options = folderOptionsForAll(RECORDS, ["pro"]);

    expect(options.map((option) => option.id)).toEqual(["inbox", "sent", "other", "other"]);
    expect(options.some((option) => option.id === "trash")).toBe(false);
  });

  it("renvoie une liste vide sans compte", () => {
    expect(folderOptionsForAll(RECORDS, [])).toEqual([]);
    expect(folderOptionsForAll([], ["perso"])).toEqual([]);
  });
});

describe("folderTargets", () => {
  it("rend le chemin du rôle pour chaque compte qui le possède", () => {
    expect(folderTargets(RECORDS, ["perso", "pro"], "inbox")).toEqual([
      { accountId: "perso", path: "INBOX" },
      { accountId: "pro", path: "INBOX" },
    ]);
  });

  it("ignore les comptes sans le dossier et conserve l'ordre demandé", () => {
    expect(folderTargets(RECORDS, ["pro", "perso"], "sent")).toEqual([
      { accountId: "pro", path: "Sent" },
    ]);
    expect(folderTargets(RECORDS, ["pro", "perso"], "trash")).toEqual([
      { accountId: "perso", path: "Trash" },
    ]);
  });

  it("restreint à un chemin exact quand il est fourni", () => {
    expect(folderTargets(RECORDS, ["perso", "pro"], "other", "Projets")).toEqual([
      { accountId: "pro", path: "Projets" },
    ]);
    expect(folderTargets(RECORDS, ["perso", "pro"], "other", "Voyages")).toEqual([
      { accountId: "perso", path: "Voyages" },
    ]);
    expect(folderTargets(RECORDS, ["perso", "pro"], "other", "Inconnu")).toEqual([]);
  });

  it("renvoie une liste vide sans compte ou sans dossier correspondant", () => {
    expect(folderTargets(RECORDS, [], "inbox")).toEqual([]);
    expect(folderTargets(RECORDS, ["perso", "pro"], "drafts")).toEqual([]);
  });

  it("unified rassemble tous les dossiers sauf corbeille et spam", () => {
    expect(folderTargets(RECORDS, ["perso", "pro"], "unified")).toEqual([
      { accountId: "perso", path: "INBOX" },
      { accountId: "perso", path: "Archive/2024" },
      { accountId: "perso", path: "Voyages" },
      { accountId: "pro", path: "Sent" },
      { accountId: "pro", path: "INBOX" },
      { accountId: "pro", path: "Archive/2024" },
      { accountId: "pro", path: "Projets" },
    ]);
  });

  it("unified dédoublonne un même chemin et ignore un chemin demandé", () => {
    const records: FolderRecord[] = [
      record("a", "inbox", "INBOX", "Boîte de réception"),
      record("a", "inbox", "INBOX", "Doublon"),
      record("a", "spam", "Junk", "Spam"),
      record("a", "trash", "Trash", "Corbeille"),
    ];

    expect(folderTargets(records, ["a"], "unified", "INBOX")).toEqual([
      { accountId: "a", path: "INBOX" },
    ]);
    expect(folderTargets(records, ["b"], "unified")).toEqual([]);
  });
});

describe("messageToMail · destinataires", () => {
  const apiMessage = (over: Partial<ApiMessage> = {}): ApiMessage => ({
    account_id: "perso",
    folder_path: "INBOX",
    uid: 1,
    uidvalidity: 1,
    thread_id: "t1",
    message_id: "<m1@test.fr>",
    in_reply_to: null,
    references: [],
    from: { name: "Camille", email: "camille@test.fr" },
    to: [{ name: null, email: "roman@test.fr" }],
    cc: [],
    subject: "Planning",
    date: "2026-01-05T10:00:00Z",
    flags: { unread: false, starred: false, answered: false },
    size: 512,
    pgp: "none",
    preview: "Aperçu",
    body_text: "Corps reçu",
    body_html: null,
    attachments: [],
    ...over,
  });

  it("joint les Cc comme les À", () => {
    const mail = messageToMail(
      apiMessage({
        to: [
          { name: null, email: "roman@test.fr" },
          { name: "Équipe", email: "equipe@test.fr" },
        ],
        cc: [
          { name: "Marc", email: "marc@test.fr" },
          { name: null, email: "copie@test.fr" },
        ],
      }),
      RECORDS,
      "inbox",
    );

    expect(mail.to).toBe("roman@test.fr, equipe@test.fr");
    expect(mail.cc).toBe("marc@test.fr, copie@test.fr");
  });

  it("laisse les destinataires indéfinis quand les listes sont vides", () => {
    const mail = messageToMail(apiMessage({ to: [], cc: [] }), RECORDS, "inbox");

    expect(mail.to).toBeUndefined();
    expect(mail.cc).toBeUndefined();
  });
});

describe("sendInputOf", () => {
  const draft = (over: Partial<ComposeDraft> = {}): ComposeDraft => ({
    ...baseDraft("perso", false, false),
    to: "camille@studio-lilas.fr",
    subject: "Factures",
    ...over,
  });

  it("transmet les pièces jointes du brouillon au contrat du démon", () => {
    const input = sendInputOf(
      draft({
        attachments: [
          { filename: "facture.pdf", mime: "application/pdf", data_base64: "aGVsbG8=", size: 5 },
        ],
      }),
    );

    expect(input.attachments).toEqual([
      { filename: "facture.pdf", mime: "application/pdf", data_base64: "aGVsbG8=" },
    ]);
    expect(input.to).toEqual([{ name: null, email: "camille@studio-lilas.fr" }]);
  });

  it("n'envoie aucun tableau de pièces jointes quand le brouillon n'en a pas", () => {
    expect(sendInputOf(draft()).attachments).toBeUndefined();
    expect(sendInputOf(draft({ attachments: [] })).attachments).toBeUndefined();
  });

  const QUOTED = buildQuotedHtml("Le 9 novembre, Support a écrit :", "<p>Bonjour</p>");

  it("place la signature avant l'historique cité, en html comme en texte", () => {
    const input = sendInputOf(draft({ body: "<p>Merci</p>", quoted: QUOTED }), "<p>Cordialement</p>");

    expect(input.html).toBe(`<p>Merci</p><br><p>Cordialement</p><br><br>${QUOTED}`);
    expect(input.text).toBe("Merci\n\nCordialement\n\nLe 9 novembre, Support a écrit :\nBonjour");
  });

  it("sans signature, l'historique suit directement le nouveau message", () => {
    const input = sendInputOf(draft({ body: "<p>Merci</p>", quoted: QUOTED }), null);

    expect(input.html).toBe(`<p>Merci</p><br><br>${QUOTED}`);
    expect(input.text).toBe("Merci\n\nLe 9 novembre, Support a écrit :\nBonjour");
  });

  it("garde l'URL entre chevrons dans le texte envoyé", () => {
    const input = sendInputOf(
      draft({ body: "<p>Suivi : <https://example.com/x></p>" }),
      null,
    );

    expect(input.text).toBe("Suivi : https://example.com/x");
    expect(input.text).not.toContain("<https");
  });

  it("sans citation, la signature clôt le message", () => {
    const input = sendInputOf(draft({ body: "<p>Merci</p>" }), "<p>Cordialement</p>");

    expect(input.html).toBe("<p>Merci</p><br><p>Cordialement</p>");
    expect(input.text).toBe("Merci\n\nCordialement");
  });
});

describe("htmlImagesOf · interrupteur PGP du compte", () => {
  const source = { accountId: "pro", folderPath: "INBOX", uid: 7 };

  afterEach(() => setAccountDecryptPolicy({}));

  it("refuse un message chiffré d'un compte fermé, sans appeler le démon", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setAccountDecryptPolicy({ pro: false });

    await expect(htmlImagesOf(source, true)).rejects.toThrow(
      "PGP désactivé pour ce compte · message chiffré laissé fermé",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("laisse révéler les images d'un message en clair, même compte fermé", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ html: "<p>x</p>" }) })),
    );
    setAccountDecryptPolicy({ pro: false });

    expect(await htmlImagesOf(source, false)).toBe("<p>x</p>");
  });

  it("laisse passer les comptes ouverts et ceux que la politique ignore", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ html: "<p>x</p>" }) })),
    );

    expect(await htmlImagesOf(source, true)).toBe("<p>x</p>");
    setAccountDecryptPolicy({ autre: false });
    expect(await htmlImagesOf(source, true)).toBe("<p>x</p>");
    expect(accountDecrypts("pro")).toBe(true);
    expect(accountDecrypts("autre")).toBe(false);
  });
});
