import { sha256 } from "@noble/hashes/sha2.js";
import { compareHlc, decodeHlc } from "./clock";
import { encodeBase64Url, type EntityKind } from "./crypto";

export const LOCAL_SCHEMA_VERSION = 1;

export type DocKind = EntityKind;

export type Doc = {
  id: string;
  kind: DocKind;
  v: number;
  raw: Record<string, unknown>;
  fields: Record<string, string>;
  deletedAt?: string;
  readOnly: boolean;
  updatedAt: string;
};

export type OpPayload = {
  id: string;
  kind: DocKind;
  v: number;
  op: "upsert" | "delete";
  patch?: Record<string, unknown>;
};

export type DecodedOp = {
  kind: DocKind;
  entityRef: string;
  hlc: string;
  schemaVersion: number;
  payload: OpPayload;
};

export type RefIndex = Record<string, string>;

type ApplyResult = { docs: Record<string, Doc>; refs: RefIndex; changed: boolean };

type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

const SUGGESTION_PREFIX = "sg:";
const TASK_PREFIX = "ts:";
const ID_DIGEST_LENGTH = 22;
const PUNCTUATION_TAIL = /[.!?…:;,]+$/;
const MIGRATIONS: Partial<Record<number, Migration>> = {};

const encoder = new TextEncoder();

export function docKey(kind: DocKind, id: string): string {
  return `${kind}:${id}`;
}

function isNewer(hlc: string, previous: string | undefined): boolean {
  return previous === undefined || compareHlc(hlc, previous) > 0;
}

function timestamp(hlc: string): string {
  return new Date(decodeHlc(hlc).state.wallMs).toISOString();
}

function baseDoc(op: DecodedOp): Doc {
  return { id: op.payload.id, kind: op.kind, v: 0, raw: {}, fields: {}, readOnly: false, updatedAt: timestamp(op.hlc) };
}

function tombstone(current: Doc | undefined, op: DecodedOp): Doc {
  if (current === undefined) return { ...baseDoc(op), deletedAt: op.hlc };
  if (current.deletedAt !== undefined && compareHlc(op.hlc, current.deletedAt) <= 0) return current;
  return { ...current, deletedAt: op.hlc, updatedAt: timestamp(op.hlc) };
}

function upsert(current: Doc | undefined, op: DecodedOp): Doc {
  if (current?.deletedAt !== undefined && compareHlc(op.hlc, current.deletedAt) <= 0) return current;
  const base = current ?? baseDoc(op);
  const fields = { ...base.fields };
  const raw = { ...base.raw };
  let touched = false;
  for (const [name, value] of Object.entries(op.payload.patch ?? {})) {
    if (!isNewer(op.hlc, fields[name])) continue;
    raw[name] = value;
    fields[name] = op.hlc;
    touched = true;
  }
  const v = Math.max(base.v, op.schemaVersion);
  const readOnly = v > LOCAL_SCHEMA_VERSION;
  const resurrected = current?.deletedAt !== undefined;
  if (!touched && !resurrected && v === base.v) return base;
  return { id: base.id, kind: base.kind, v, raw, fields, readOnly, updatedAt: timestamp(op.hlc) };
}

export function applyOp(docs: Record<string, Doc>, refs: RefIndex, op: DecodedOp): ApplyResult {
  const key = docKey(op.kind, op.payload.id);
  const bound = refs[op.entityRef];
  if (bound !== undefined && bound !== key) return { docs, refs, changed: false };

  const current = docs[key];
  const next = op.payload.op === "delete" ? tombstone(current, op) : upsert(current, op);
  const changed = bound === undefined || next !== current;
  if (!changed) return { docs, refs, changed: false };
  const nextRefs = bound === undefined ? { ...refs, [op.entityRef]: key } : refs;
  return { docs: { ...docs, [key]: next }, refs: nextRefs, changed: true };
}

export function visibleDocs(docs: Record<string, Doc>, kind: DocKind): Doc[] {
  return Object.values(docs)
    .filter((doc) => doc.kind === kind && doc.deletedAt === undefined)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function migrateDoc(raw: Record<string, unknown>, fromV: number): { raw: Record<string, unknown>; v: number } {
  if (!Number.isInteger(fromV) || fromV < 0) throw new Error(`migration impossible : version invalide (${fromV})`);
  if (fromV > LOCAL_SCHEMA_VERSION) {
    throw new Error(`migration impossible : document v${fromV} plus récent que le client v${LOCAL_SCHEMA_VERSION}`);
  }
  let current = raw;
  for (let version = fromV; version < LOCAL_SCHEMA_VERSION; version++) {
    const migrate = MIGRATIONS[version];
    if (migrate === undefined) throw new Error(`migration manquante : ${version} -> ${version + 1}`);
    current = migrate(current);
  }
  return { raw: current, v: LOCAL_SCHEMA_VERSION };
}

export function normalizeProposal(proposal: string): string {
  return proposal
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(PUNCTUATION_TAIL, "")
    .trim();
}

export function suggestionId(mailKey: string, proposal: string): string {
  const digest = sha256(encoder.encode(`${mailKey}|${normalizeProposal(proposal)}`));
  return `${SUGGESTION_PREFIX}${encodeBase64Url(digest).slice(0, ID_DIGEST_LENGTH)}`;
}

export function promotedTaskId(suggestionId: string): string {
  const bare = suggestionId.startsWith(SUGGESTION_PREFIX) ? suggestionId.slice(SUGGESTION_PREFIX.length) : suggestionId;
  return `${TASK_PREFIX}${bare}`;
}
