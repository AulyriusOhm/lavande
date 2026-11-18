import { describe, expect, it } from "vitest";
import {
  applyFolderOrder,
  buildFolderTree,
  descendantPaths,
  detectDelimiter,
  moveFolderPath,
} from "@/lib/folder-tree";

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

  it("décode les segments UTF-7 modifié sans toucher au chemin", () => {
    const roots = buildFolderTree([
      folder("[Gmail]"),
      folder("[Gmail]/&2Dzf5g- Notes"),
      folder("[Gmail]/&2Dzf5g- Notes/&AOk-t&AOk- 2026"),
    ]);

    expect(shape(roots)).toEqual([["[Gmail]", 1]]);
    expect(shape(roots[0].children)).toEqual([["🏦 Notes", 1]]);
    expect(roots[0].children[0].children.map((node) => node.name)).toEqual(["été 2026"]);
    expect(roots[0].children[0].path).toBe("[Gmail]/&2Dzf5g- Notes");
  });

  it("décode un palier intermédiaire que le serveur ne liste pas", () => {
    const roots = buildFolderTree([folder("&2Dzf5g-/Notes")]);

    expect(roots[0].name).toBe("🏦");
    expect(roots[0].path).toBe("&2Dzf5g-");
    expect(roots[0].item).toBeNull();
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

describe("applyFolderOrder", () => {
  const TREE = [
    folder("INBOX"),
    folder("Envoyés"),
    folder("Projets"),
    folder("Projets/2026"),
    folder("Projets/2025"),
    folder("Voyages"),
  ];

  it("place les chemins connus devant, dans l'ordre voulu, et laisse les autres au serveur", () => {
    const roots = applyFolderOrder(buildFolderTree(TREE), ["Voyages", "INBOX"]);

    expect(roots.map((node) => node.path)).toEqual(["Voyages", "INBOX", "Envoyés", "Projets"]);
  });

  it("réordonne chaque niveau séparément sans re-parenter", () => {
    const roots = applyFolderOrder(buildFolderTree(TREE), ["Projets/2025", "Projets/2026"]);
    const projets = roots.find((node) => node.path === "Projets");

    expect(projets?.children.map((node) => node.path)).toEqual(["Projets/2025", "Projets/2026"]);
    expect(roots.map((node) => node.path)).toEqual(["INBOX", "Envoyés", "Projets", "Voyages"]);
  });

  it("garde l'arbre tel quel sans ordre enregistré", () => {
    const roots = buildFolderTree(TREE);

    expect(applyFolderOrder(roots, [])).toBe(roots);
  });
});

describe("moveFolderPath", () => {
  const SIBLINGS = ["INBOX", "Envoyés", "Projets", "Voyages"];

  it("déplace un chemin devant un frère", () => {
    expect(moveFolderPath([], SIBLINGS, "Voyages", "Projets", false)).toEqual([
      "INBOX",
      "Envoyés",
      "Voyages",
      "Projets",
    ]);
  });

  it("déplace un chemin derrière un frère", () => {
    expect(moveFolderPath([], SIBLINGS, "INBOX", "Projets", true)).toEqual([
      "Envoyés",
      "Projets",
      "INBOX",
      "Voyages",
    ]);
  });

  it("garde l'ordre des autres niveaux derrière le niveau déplacé", () => {
    expect(
      moveFolderPath(["Projets/2025", "Projets/2026"], SIBLINGS, "Voyages", "INBOX", false),
    ).toEqual(["Voyages", "INBOX", "Envoyés", "Projets", "Projets/2025", "Projets/2026"]);
  });

  it("ne touche à rien quand la cible n'est pas un frère", () => {
    expect(moveFolderPath(["INBOX"], SIBLINGS, "Voyages", "Projets/2026", false)).toEqual(["INBOX"]);
  });
});
