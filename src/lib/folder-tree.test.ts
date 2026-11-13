import { describe, expect, it } from "vitest";
import { buildFolderTree, descendantPaths, detectDelimiter } from "@/lib/folder-tree";

const folder = (path: string, delimiter: string | null = "/") => ({ path, delimiter });

const NESTED = [
  folder("INBOX"),
  folder("INBOX/Travail"),
  folder("INBOX/Travail/2026"),
  folder("Envoyés"),
];

const shape = (nodes: ReturnType<typeof buildFolderTree>) =>
  nodes.map((node) => [node.name, node.children.length]);

describe("buildFolderTree", () => {
  it("plie les chemins en hiérarchie avec le délimiteur du serveur", () => {
    const roots = buildFolderTree(NESTED);

    expect(shape(roots)).toEqual([
      ["INBOX", 1],
      ["Envoyés", 0],
    ]);
    expect(shape(roots[0].children)).toEqual([["Travail", 1]]);
    expect(roots[0].children[0].children.map((node) => node.name)).toEqual(["2026"]);
  });

  it("garde l'ordre du serveur et le dossier d'origine de chaque nœud", () => {
    const roots = buildFolderTree(NESTED);

    expect(roots.map((node) => node.path)).toEqual(["INBOX", "Envoyés"]);
    expect(roots[0].children[0].item?.path).toBe("INBOX/Travail");
  });

  it("déduit le délimiteur quand le serveur n'en publie pas", () => {
    const roots = buildFolderTree(NESTED.map((item) => folder(item.path, null)));

    expect(shape(roots)).toEqual([
      ["INBOX", 1],
      ["Envoyés", 0],
    ]);
  });

  it("respecte un délimiteur point", () => {
    const roots = buildFolderTree([folder("Archive", "."), folder("Archive.2024", ".")]);

    expect(shape(roots)).toEqual([["Archive", 1]]);
    expect(roots[0].children[0].name).toBe("2024");
  });

  it("crée le palier manquant du serveur sans le rendre sélectionnable", () => {
    const roots = buildFolderTree([folder("Projets/2026")]);

    expect(shape(roots)).toEqual([["Projets", 1]]);
    expect(roots[0].item).toBeNull();
    expect(roots[0].children[0].item?.path).toBe("Projets/2026");
  });

  it("reste une liste plate sans aucun délimiteur", () => {
    const roots = buildFolderTree([folder("Projets", null), folder("Voyages", null)]);

    expect(shape(roots)).toEqual([
      ["Projets", 0],
      ["Voyages", 0],
    ]);
  });
});

describe("detectDelimiter", () => {
  it("choisit le séparateur le plus fréquent", () => {
    expect(detectDelimiter(["INBOX", "INBOX/Travail", "Archive.2024"])).toBe("/");
    expect(detectDelimiter(["Archive", "Archive.2024"])).toBe(".");
    expect(detectDelimiter(["INBOX", "Envoyés"])).toBeNull();
  });
});

describe("descendantPaths", () => {
  it("rend tous les chemins sous un nœud", () => {
    const [inbox] = buildFolderTree(NESTED);

    expect(descendantPaths(inbox)).toEqual(["INBOX/Travail", "INBOX/Travail/2026"]);
  });
});
