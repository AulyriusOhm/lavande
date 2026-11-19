import { describe, expect, it } from "vitest";
import { hasCriteria, mergeCriteria, parseSearchQuery, searchParams, searchTerms } from "@/lib/search-query";

describe("parseSearchQuery", () => {
  it("lit les opérateurs et laisse le reste en texte libre", () => {
    const criteria = parseSearchQuery("facture from:camille to:marc subject:janvier in:Projets");

    expect(criteria).toEqual({
      text: "facture",
      from: "camille",
      to: "marc",
      subject: "janvier",
      folder: "Projets",
    });
  });

  it("lit les drapeaux et les dates", () => {
    const criteria = parseSearchQuery("is:unread has:attachment before:2026-02-01 after:2026-01-01");

    expect(criteria.unread).toBe(true);
    expect(criteria.hasAttachment).toBe(true);
    expect(criteria.before).toBe("2026-02-01");
    expect(criteria.after).toBe("2026-01-01");
    expect(criteria.text).toBe("");
  });

  it("lit is:starred", () => {
    expect(parseSearchQuery("is:starred").starred).toBe(true);
  });

  it("garde la valeur entre guillemets, espaces compris", () => {
    const criteria = parseSearchQuery('from:"Jean Dupont" "compte rendu"');

    expect(criteria.from).toBe("Jean Dupont");
    expect(criteria.text).toBe("compte rendu");
  });

  it("laisse un opérateur inconnu en texte littéral", () => {
    const criteria = parseSearchQuery("foo:bar facture");

    expect(criteria).toEqual({ text: "foo:bar facture" });
  });

  it("laisse une date invalide en texte littéral", () => {
    const criteria = parseSearchQuery("before:2026-13-45");

    expect(criteria.before).toBeUndefined();
    expect(criteria.text).toBe("before:2026-13-45");
  });

  it("ignore un opérateur sans valeur", () => {
    const criteria = parseSearchQuery("from:");

    expect(criteria.from).toBeUndefined();
    expect(criteria.text).toBe("from:");
  });

  it("garde la dernière valeur d'un opérateur répété", () => {
    expect(parseSearchQuery("from:a from:b").from).toBe("b");
  });

  it("distingue la casse de l'opérateur, pas celle de la valeur", () => {
    const criteria = parseSearchQuery("FROM:Camille");

    expect(criteria.from).toBe("Camille");
    expect(criteria.text).toBe("");
  });
});

describe("hasCriteria", () => {
  it("est faux pour un texte vide sans filtre", () => {
    expect(hasCriteria(parseSearchQuery("   "))).toBe(false);
  });

  it("est vrai pour un filtre seul", () => {
    expect(hasCriteria(parseSearchQuery("is:unread"))).toBe(true);
  });
});

describe("mergeCriteria", () => {
  it("ajoute les filtres du scope sans écraser par undefined", () => {
    const merged = mergeCriteria(parseSearchQuery("facture from:camille"), {
      unread: true,
      subject: undefined,
    });

    expect(merged).toEqual({ text: "facture", from: "camille", unread: true });
  });
});

describe("searchParams", () => {
  it("n'envoie que q et limit sans filtre", () => {
    expect(searchParams("facture", 50)).toBe("q=facture&limit=50");
  });

  it("sérialise les filtres dans l'ordre du contrat", () => {
    const params = searchParams("facture", 50, {
      folder: "Projets",
      from: "Jean Dupont",
      to: "marc",
      subject: "janvier",
      unread: true,
      starred: false,
      hasAttachment: true,
      before: "2026-02-01",
      after: "2026-01-01",
      offset: 50,
    });

    expect(params).toBe(
      "q=facture&limit=50&offset=50&folder=Projets&from=Jean%20Dupont&to=marc&subject=janvier" +
        "&unread=true&starred=false&has_attachment=true&before=2026-02-01&after=2026-01-01",
    );
  });

  it("omet q quand la recherche n'est que filtrée", () => {
    expect(searchParams("", 50, { unread: true })).toBe("limit=50&unread=true");
  });

  it("n'envoie pas un offset nul", () => {
    expect(searchParams("", 50, { offset: 0 })).toBe("limit=50");
  });
});

describe("searchTerms", () => {
  it("rend les mots du texte libre, dédoublonnés et sans ponctuation", () => {
    expect(searchTerms(" Factures, factures  mars ")).toEqual(["Factures", "mars"]);
  });

  it("ne rend rien pour un texte vide", () => {
    expect(searchTerms("")).toEqual([]);
  });
});
