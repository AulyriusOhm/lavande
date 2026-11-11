import { describe, expect, it } from "vitest";
import { folderOptionsForAll, folderTargets } from "@/lib/mail-backend";
import type { FolderRecord } from "@/lib/mail-backend";

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
