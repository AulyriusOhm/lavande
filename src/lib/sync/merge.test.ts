import { describe, expect, it } from "vitest";
import { encodeHlc } from "./clock";
import {
  applyOp,
  docKey,
  LOCAL_SCHEMA_VERSION,
  migrateDoc,
  normalizeProposal,
  promotedTaskId,
  suggestionId,
  visibleDocs,
  type DecodedOp,
  type Doc,
  type DocKind,
  type RefIndex,
} from "./merge";

function HLC(wallMs: number, counter = 0, device = "aaa111"): string {
  return encodeHlc({ wallMs, counter }, device);
}

function ref(kind: DocKind, id: string): string {
  return `ref:${kind}:${id}`;
}

function upsert(kind: DocKind, id: string, hlc: string, patch: Record<string, unknown>, schemaVersion = LOCAL_SCHEMA_VERSION): DecodedOp {
  return { kind, entityRef: ref(kind, id), hlc, schemaVersion, payload: { id, kind, v: schemaVersion, op: "upsert", patch } };
}

function remove(kind: DocKind, id: string, hlc: string, schemaVersion = LOCAL_SCHEMA_VERSION): DecodedOp {
  return { kind, entityRef: ref(kind, id), hlc, schemaVersion, payload: { id, kind, v: schemaVersion, op: "delete" } };
}

function apply(start: { docs: Record<string, Doc>; refs: RefIndex }, ...ops: DecodedOp[]): { docs: Record<string, Doc>; refs: RefIndex } {
  return ops.reduce((state, op) => applyOp(state.docs, state.refs, op), start);
}

const EMPTY = { docs: {} as Record<string, Doc>, refs: {} as RefIndex };

describe("docKey", () => {
  it("préfixe le kind", () => {
    expect(docKey("task", "tk:1")).toBe("task:tk:1");
    expect(docKey("suggestion", "sg:1")).toBe("suggestion:sg:1");
  });
});

describe("applyOp", () => {
  it("conserve les champs modifiés par deux appareils", () => {
    const state = apply(
      EMPTY,
      upsert("task", "tk:1", HLC(1000, 0, "aaa111"), { title: "Courses" }),
      upsert("task", "tk:1", HLC(1001, 0, "bbb222"), { state: "doing" }),
    );
    const doc = state.docs[docKey("task", "tk:1")];
    expect(doc.raw).toEqual({ title: "Courses", state: "doing" });
    expect(doc.fields).toEqual({ title: HLC(1000, 0, "aaa111"), state: HLC(1001, 0, "bbb222") });
  });

  it("tranche un champ concurrent par l'HLC le plus grand, dans les deux ordres", () => {
    const stale = upsert("task", "tk:1", HLC(1000, 5, "zzz999"), { title: "Ancien" });
    const fresh = upsert("task", "tk:1", HLC(1001, 0, "aaa111"), { title: "Récent" });
    const forward = apply(EMPTY, stale, fresh).docs[docKey("task", "tk:1")];
    const backward = apply(EMPTY, fresh, stale).docs[docKey("task", "tk:1")];
    expect(forward.raw.title).toBe("Récent");
    expect(backward.raw.title).toBe("Récent");
    expect(forward).toEqual(backward);
  });

  it("tranche à HLC égal par le device le plus grand, dans les deux ordres", () => {
    const small = upsert("task", "tk:1", HLC(1000, 3, "aaa111"), { title: "Petit" });
    const big = upsert("task", "tk:1", HLC(1000, 3, "zzz999"), { title: "Grand" });
    const forward = apply(EMPTY, small, big).docs[docKey("task", "tk:1")];
    const backward = apply(EMPTY, big, small).docs[docKey("task", "tk:1")];
    expect(forward.raw.title).toBe("Grand");
    expect(backward.raw.title).toBe("Grand");
    expect(forward).toEqual(backward);
  });

  it("conserve un champ inconnu absent du patch suivant", () => {
    const created = apply(EMPTY, upsert("task", "tk:1", HLC(1000), { title: "A", labels: ["client"] }));
    const edited = apply(created, upsert("task", "tk:1", HLC(2000), { title: "B" }));
    expect(edited.docs[docKey("task", "tk:1")].raw).toEqual({ title: "B", labels: ["client"] });
  });

  it("marque readOnly un document plus récent que le schéma local", () => {
    const state = apply(EMPTY, upsert("task", "tk:9", HLC(1000), { title: "Futur", labels: [] }, 2));
    const doc = state.docs[docKey("task", "tk:9")];
    expect(doc.v).toBe(2);
    expect(doc.readOnly).toBe(true);
    expect(doc.raw).toEqual({ title: "Futur", labels: [] });
  });

  it("ne redescend jamais sous un schéma plus récent", () => {
    const created = apply(EMPTY, upsert("task", "tk:9", HLC(1000), { title: "Futur" }, 2));
    const edited = apply(created, upsert("task", "tk:9", HLC(2000), { title: "Local" }));
    expect(edited.docs[docKey("task", "tk:9")].v).toBe(2);
    expect(edited.docs[docKey("task", "tk:9")].readOnly).toBe(true);
  });

  it("masque un document supprimé puis le ressuscite", () => {
    const created = apply(EMPTY, upsert("task", "tk:1", HLC(1000), { title: "A" }));
    const deleted = apply(created, remove("task", "tk:1", HLC(2000)));
    expect(visibleDocs(deleted.docs, "task")).toEqual([]);

    const late = applyOp(deleted.docs, deleted.refs, upsert("task", "tk:1", HLC(1500), { title: "Tardif" }));
    expect(late.changed).toBe(false);
    expect(visibleDocs(late.docs, "task")).toEqual([]);

    const revived = applyOp(deleted.docs, deleted.refs, upsert("task", "tk:1", HLC(3000), { title: "B" }));
    const doc = revived.docs[docKey("task", "tk:1")];
    expect(revived.changed).toBe(true);
    expect(doc.deletedAt).toBeUndefined();
    expect(doc.raw).toEqual({ title: "B" });
    expect(visibleDocs(revived.docs, "task")).toHaveLength(1);
  });

  it("garde le tombstone le plus récent", () => {
    const deleted = apply(EMPTY, remove("task", "tk:1", HLC(2000)));
    const older = applyOp(deleted.docs, deleted.refs, remove("task", "tk:1", HLC(1000)));
    expect(older.changed).toBe(false);
    expect(older.docs[docKey("task", "tk:1")].deletedAt).toBe(HLC(2000));
  });

  it("ignore une op dont l'entityRef est déjà lié à un autre document", () => {
    const refs: RefIndex = { [ref("task", "tk:1")]: docKey("task", "tk:autre") };
    const result = applyOp({}, refs, upsert("task", "tk:1", HLC(1000), { title: "A" }));
    expect(result.changed).toBe(false);
    expect(result.docs).toEqual({});
    expect(result.refs).toBe(refs);
  });

  it("enregistre l'association entityRef puis reste idempotent", () => {
    const op = upsert("task", "tk:1", HLC(1000), { title: "A" });
    const first = applyOp({}, {}, op);
    expect(first.refs[op.entityRef]).toBe(docKey("task", "tk:1"));
    const replay = applyOp(first.docs, first.refs, op);
    expect(replay.changed).toBe(false);
    expect(replay.docs).toBe(first.docs);
  });

  it("dérive updatedAt de la partie wallMs de l'HLC", () => {
    const wallMs = 1700000000123;
    const state = apply(EMPTY, upsert("task", "tk:1", HLC(wallMs), { title: "A" }));
    expect(state.docs[docKey("task", "tk:1")].updatedAt).toBe(new Date(wallMs).toISOString());
  });
});

describe("visibleDocs", () => {
  it("trie par identifiant et filtre par kind", () => {
    const state = apply(
      EMPTY,
      upsert("task", "tk:b", HLC(1000), { title: "B" }),
      upsert("task", "tk:a", HLC(1001), { title: "A" }),
      upsert("suggestion", "sg:x", HLC(1002), { proposal: "X" }),
    );
    expect(visibleDocs(state.docs, "task").map((doc) => doc.id)).toEqual(["tk:a", "tk:b"]);
    expect(visibleDocs(state.docs, "suggestion").map((doc) => doc.id)).toEqual(["sg:x"]);
  });
});

describe("migrateDoc", () => {
  it("renvoie le document tel quel à la version courante", () => {
    const raw = { title: "A" };
    expect(migrateDoc(raw, LOCAL_SCHEMA_VERSION)).toEqual({ raw, v: LOCAL_SCHEMA_VERSION });
  });

  it("lève pour un document plus récent que le client", () => {
    expect(() => migrateDoc({}, LOCAL_SCHEMA_VERSION + 1)).toThrow(/trop récent|plus récent/);
    expect(() => migrateDoc({}, LOCAL_SCHEMA_VERSION + 1)).toThrow();
  });

  it("lève pour une version invalide", () => {
    expect(() => migrateDoc({}, -1)).toThrow();
    expect(() => migrateDoc({}, 1.5)).toThrow();
  });
});

describe("normalizeProposal", () => {
  it("compacte espaces, casse et ponctuation finale", () => {
    expect(normalizeProposal("  Répondre   à Camille.  ")).toBe("répondre à camille");
    expect(normalizeProposal("Faire ça…")).toBe("faire ça");
    expect(normalizeProposal("Voir: ")).toBe("voir");
    expect(normalizeProposal("Relancer;")).toBe("relancer");
    expect(normalizeProposal("Rien à faire")).toBe("rien à faire");
  });
});

describe("identifiants", () => {
  it("calcule un identifiant de suggestion déterministe", () => {
    const id = suggestionId("perso:1", "Répondre à Camille");
    expect(id).toMatch(/^sg:[A-Za-z0-9_-]{22}$/);
    expect(suggestionId("perso:1", "Répondre à Camille")).toBe(id);
    expect(suggestionId("perso:1", "  répondre   à camille !!!")).toBe(id);
    expect(suggestionId("perso:1", "répondre à camille")).toBe(id);
  });

  it("distingue la boîte et la proposition", () => {
    const id = suggestionId("perso:1", "Répondre à Camille");
    expect(suggestionId("pro:1", "Répondre à Camille")).not.toBe(id);
    expect(suggestionId("perso:1", "Répondre à Camille demain")).not.toBe(id);
  });

  it("dérive l'identifiant de la tâche promue", () => {
    expect(promotedTaskId("sg:abc123")).toBe("ts:abc123");
  });
});
