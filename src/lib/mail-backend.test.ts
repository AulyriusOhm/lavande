import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountDecrypts,
  folderOptionsForAll,
  folderTargets,
  htmlImagesOf,
  sendInputOf,
  setAccountDecryptPolicy,
} from "@/lib/mail-backend";
import type { FolderRecord } from "@/lib/mail-backend";
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
});

describe("htmlImagesOf · interrupteur PGP du compte", () => {
  const source = { accountId: "pro", folderPath: "INBOX", uid: 7 };

  afterEach(() => setAccountDecryptPolicy({}));

  it("refuse le compte dont l'interrupteur est fermé, sans appeler le démon", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setAccountDecryptPolicy({ pro: false });

    await expect(htmlImagesOf(source)).rejects.toThrow(
      "PGP désactivé pour ce compte · message chiffré laissé fermé",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("laisse passer les comptes ouverts et ceux que la politique ignore", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ html: "<p>x</p>" }) })),
    );

    expect(await htmlImagesOf(source)).toBe("<p>x</p>");
    setAccountDecryptPolicy({ autre: false });
    expect(await htmlImagesOf(source)).toBe("<p>x</p>");
    expect(accountDecrypts("pro")).toBe(true);
    expect(accountDecrypts("autre")).toBe(false);
  });
});
