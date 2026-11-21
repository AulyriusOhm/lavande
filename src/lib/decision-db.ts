import type { MailDecision } from "@/lib/decision";

/**
 * Miroir local haute capacité des décisions Système 1 (IndexedDB, avec repli
 * mémoire transparent en environnement de test ou webview sans IndexedDB).
 *
 * Stocke :
 * - `decisions` : décisions de triage par mail (lecture 0 ms au scroll / filtrage)
 * - `cleanup_reviews` : choix humains du mode Nettoyage / Tinder (`kept` / `trashed` / `archived`)
 * - `protected_senders` : expéditeurs explicitement protégés par l'utilisateur
 */

export type CleanupAction = "kept" | "trashed" | "archived";

export type CleanupReview = {
  mailKey: string;
  messageId?: string;
  action: CleanupAction;
  reviewedAt: number;
};

export type StoredDecisionRecord = MailDecision & {
  mailKey: string;
};

export type MailLlmExtraction = {
  mailKey: string;
  messageId?: string;
  contentHash: string;
  summaryReason?: string;
  summaryDue?: string;
  summaryProcessed?: boolean;
  tasks?: { title: string; due: string; from: string; mailId?: string; assignee?: string }[];
  tasksProcessed?: boolean;
  events?: { title: string; date: string; start: string; end: string; location?: string; from: string; mailId?: string }[];
  eventsProcessed?: boolean;
  updatedAt: number;
};

export function decisionMailKey(accountId: string, folderPath: string, uid: number): string {
  return `${accountId}:${folderPath}:${uid}`;
}

export function normalizeMessageId(messageId: string | undefined | null): string {
  return (messageId ?? "").trim().toLowerCase();
}

export interface DecisionCacheStore {
  getDecision(mailKey: string): Promise<StoredDecisionRecord | null>;
  getDecisionByMessageId(messageId: string): Promise<StoredDecisionRecord | null>;
  putDecision(decision: MailDecision): Promise<void>;
  putDecisions(decisions: MailDecision[]): Promise<void>;
  listDecisions(filter?: { accountId?: string; category?: string }): Promise<StoredDecisionRecord[]>;
  clearDecisions(accountId?: string): Promise<void>;
  getCleanupReview(mailKey: string): Promise<CleanupReview | null>;
  putCleanupReview(review: CleanupReview): Promise<void>;
  deleteCleanupReview(mailKey: string): Promise<void>;
  listCleanupReviews(): Promise<CleanupReview[]>;
  isSenderProtected(senderEmail: string): Promise<boolean>;
  setSenderProtected(senderEmail: string, protectedFlag: boolean): Promise<void>;
  listProtectedSenders(): Promise<string[]>;
  getLlmExtraction(mailKey: string): Promise<MailLlmExtraction | null>;
  putLlmExtraction(entry: MailLlmExtraction): Promise<void>;
  putLlmExtractions(entries: MailLlmExtraction[]): Promise<void>;
  clearLlmExtractions(): Promise<void>;
}

const DB_NAME = "lavande-decisions-v1";
const DB_VERSION = 2;
const STORE_DECISIONS = "decisions";
const STORE_CLEANUP = "cleanup_reviews";
const STORE_PROTECTED = "protected_senders";
const STORE_LLM_EXTRACTIONS = "llm_extractions";

function toRecord(decision: MailDecision): StoredDecisionRecord {
  return {
    ...decision,
    mailKey: decisionMailKey(decision.accountId, decision.folderPath, decision.uid),
  };
}

/** Implémentation en mémoire (tests Vitest, SSR ou fallback sans IndexedDB). */
export function createMemoryDecisionDb(): DecisionCacheStore {
  const decisions = new Map<string, StoredDecisionRecord>();
  const reviews = new Map<string, CleanupReview>();
  const protectedSenders = new Set<string>();
  const llmExtractions = new Map<string, MailLlmExtraction>();

  return {
    async getDecision(mailKey) {
      return decisions.get(mailKey) ?? null;
    },
    async getDecisionByMessageId(messageId) {
      const target = normalizeMessageId(messageId);
      if (!target) return null;
      for (const entry of decisions.values()) {
        if (normalizeMessageId(entry.messageId) === target) return entry;
      }
      return null;
    },
    async putDecision(decision) {
      const record = toRecord(decision);
      decisions.set(record.mailKey, record);
    },
    async putDecisions(items) {
      for (const decision of items) {
        const record = toRecord(decision);
        decisions.set(record.mailKey, record);
      }
    },
    async listDecisions(filter) {
      let all = [...decisions.values()];
      if (filter?.accountId) all = all.filter((d) => d.accountId === filter.accountId);
      if (filter?.category) all = all.filter((d) => d.category === filter.category);
      return all.sort((a, b) => b.decidedAt - a.decidedAt);
    },
    async clearDecisions(accountId) {
      if (!accountId) {
        decisions.clear();
        return;
      }
      for (const [key, entry] of decisions.entries()) {
        if (entry.accountId === accountId) decisions.delete(key);
      }
    },
    async getCleanupReview(mailKey) {
      return reviews.get(mailKey) ?? null;
    },
    async putCleanupReview(review) {
      reviews.set(review.mailKey, review);
    },
    async deleteCleanupReview(mailKey) {
      reviews.delete(mailKey);
    },
    async listCleanupReviews() {
      return [...reviews.values()];
    },
    async isSenderProtected(senderEmail) {
      return protectedSenders.has(senderEmail.trim().toLowerCase());
    },
    async setSenderProtected(senderEmail, protectedFlag) {
      const key = senderEmail.trim().toLowerCase();
      if (!key) return;
      if (protectedFlag) protectedSenders.add(key);
      else protectedSenders.delete(key);
    },
    async listProtectedSenders() {
      return [...protectedSenders.values()].sort();
    },
    async getLlmExtraction(mailKey) {
      return llmExtractions.get(mailKey) ?? null;
    },
    async putLlmExtraction(entry) {
      llmExtractions.set(entry.mailKey, entry);
    },
    async putLlmExtractions(entries) {
      for (const entry of entries) {
        llmExtractions.set(entry.mailKey, entry);
      }
    },
    async clearLlmExtractions() {
      llmExtractions.clear();
    },
  };
}

function idbAvailable(): boolean {
  return typeof globalThis !== "undefined" && typeof globalThis.indexedDB !== "undefined";
}

function openDatabase(dbName = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_DECISIONS)) {
        const store = db.createObjectStore(STORE_DECISIONS, { keyPath: "mailKey" });
        store.createIndex("by_message_id", "messageId", { unique: false });
        store.createIndex("by_account", "accountId", { unique: false });
        store.createIndex("by_category", "category", { unique: false });
        store.createIndex("by_decided_at", "decidedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_CLEANUP)) {
        db.createObjectStore(STORE_CLEANUP, { keyPath: "mailKey" });
      }
      if (!db.objectStoreNames.contains(STORE_PROTECTED)) {
        db.createObjectStore(STORE_PROTECTED, { keyPath: "email" });
      }
      if (!db.objectStoreNames.contains(STORE_LLM_EXTRACTIONS)) {
        const store = db.createObjectStore(STORE_LLM_EXTRACTIONS, { keyPath: "mailKey" });
        store.createIndex("by_message_id", "messageId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Impossible d'ouvrir IndexedDB"));
  });
}

function reqPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Erreur IndexedDB"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Transaction IndexedDB échouée"));
    tx.onabort = () => reject(tx.error ?? new Error("Transaction IndexedDB annulée"));
  });
}

/** Implémentation IndexedDB avec repli automatique en mémoire si indisponible. */
export function createIndexedDecisionDb(dbName = DB_NAME): DecisionCacheStore {
  if (!idbAvailable()) return createMemoryDecisionDb();

  let dbPromise: Promise<IDBDatabase> | null = null;
  const fallback = createMemoryDecisionDb();
  let useFallback = false;

  const db = async (): Promise<IDBDatabase | null> => {
    if (useFallback) return null;
    try {
      dbPromise ??= openDatabase(dbName);
      return await dbPromise;
    } catch {
      useFallback = true;
      return null;
    }
  };

  return {
    async getDecision(mailKey) {
      const conn = await db();
      if (!conn) return fallback.getDecision(mailKey);
      const tx = conn.transaction(STORE_DECISIONS, "readonly");
      const found = await reqPromise(tx.objectStore(STORE_DECISIONS).get(mailKey));
      return (found as StoredDecisionRecord | undefined) ?? null;
    },
    async getDecisionByMessageId(messageId) {
      const conn = await db();
      if (!conn) return fallback.getDecisionByMessageId(messageId);
      const target = normalizeMessageId(messageId);
      if (!target) return null;
      const tx = conn.transaction(STORE_DECISIONS, "readonly");
      const all = (await reqPromise(tx.objectStore(STORE_DECISIONS).getAll())) as StoredDecisionRecord[];
      return all.find((entry) => normalizeMessageId(entry.messageId) === target) ?? null;
    },
    async putDecision(decision) {
      const conn = await db();
      if (!conn) return fallback.putDecision(decision);
      const tx = conn.transaction(STORE_DECISIONS, "readwrite");
      tx.objectStore(STORE_DECISIONS).put(toRecord(decision));
      await txDone(tx);
    },
    async putDecisions(items) {
      if (items.length === 0) return;
      const conn = await db();
      if (!conn) return fallback.putDecisions(items);
      const tx = conn.transaction(STORE_DECISIONS, "readwrite");
      const store = tx.objectStore(STORE_DECISIONS);
      for (const decision of items) store.put(toRecord(decision));
      await txDone(tx);
    },
    async listDecisions(filter) {
      const conn = await db();
      if (!conn) return fallback.listDecisions(filter);
      const tx = conn.transaction(STORE_DECISIONS, "readonly");
      let all = (await reqPromise(tx.objectStore(STORE_DECISIONS).getAll())) as StoredDecisionRecord[];
      if (filter?.accountId) all = all.filter((d) => d.accountId === filter.accountId);
      if (filter?.category) all = all.filter((d) => d.category === filter.category);
      return all.sort((a, b) => b.decidedAt - a.decidedAt);
    },
    async clearDecisions(accountId) {
      const conn = await db();
      if (!conn) return fallback.clearDecisions(accountId);
      const tx = conn.transaction(STORE_DECISIONS, "readwrite");
      const store = tx.objectStore(STORE_DECISIONS);
      if (!accountId) {
        store.clear();
        await txDone(tx);
        return;
      }
      const all = (await reqPromise(store.getAll())) as StoredDecisionRecord[];
      for (const entry of all) {
        if (entry.accountId === accountId) store.delete(entry.mailKey);
      }
      await txDone(tx);
    },
    async getCleanupReview(mailKey) {
      const conn = await db();
      if (!conn) return fallback.getCleanupReview(mailKey);
      const tx = conn.transaction(STORE_CLEANUP, "readonly");
      const found = await reqPromise(tx.objectStore(STORE_CLEANUP).get(mailKey));
      return (found as CleanupReview | undefined) ?? null;
    },
    async putCleanupReview(review) {
      const conn = await db();
      if (!conn) return fallback.putCleanupReview(review);
      const tx = conn.transaction(STORE_CLEANUP, "readwrite");
      tx.objectStore(STORE_CLEANUP).put(review);
      await txDone(tx);
    },
    async deleteCleanupReview(mailKey) {
      const conn = await db();
      if (!conn) return fallback.deleteCleanupReview(mailKey);
      const tx = conn.transaction(STORE_CLEANUP, "readwrite");
      tx.objectStore(STORE_CLEANUP).delete(mailKey);
      await txDone(tx);
    },
    async listCleanupReviews() {
      const conn = await db();
      if (!conn) return fallback.listCleanupReviews();
      const tx = conn.transaction(STORE_CLEANUP, "readonly");
      return (await reqPromise(tx.objectStore(STORE_CLEANUP).getAll())) as CleanupReview[];
    },
    async isSenderProtected(senderEmail) {
      const conn = await db();
      if (!conn) return fallback.isSenderProtected(senderEmail);
      const key = senderEmail.trim().toLowerCase();
      if (!key) return false;
      const tx = conn.transaction(STORE_PROTECTED, "readonly");
      const found = await reqPromise(tx.objectStore(STORE_PROTECTED).get(key));
      return Boolean(found);
    },
    async setSenderProtected(senderEmail, protectedFlag) {
      const conn = await db();
      if (!conn) return fallback.setSenderProtected(senderEmail, protectedFlag);
      const key = senderEmail.trim().toLowerCase();
      if (!key) return;
      const tx = conn.transaction(STORE_PROTECTED, "readwrite");
      const store = tx.objectStore(STORE_PROTECTED);
      if (protectedFlag) store.put({ email: key, updatedAt: Date.now() });
      else store.delete(key);
      await txDone(tx);
    },
    async listProtectedSenders() {
      const conn = await db();
      if (!conn) return fallback.listProtectedSenders();
      const tx = conn.transaction(STORE_PROTECTED, "readonly");
      const all = (await reqPromise(tx.objectStore(STORE_PROTECTED).getAll())) as { email: string }[];
      return all.map((entry) => entry.email).sort();
    },
    async getLlmExtraction(mailKey) {
      const conn = await db();
      if (!conn) return fallback.getLlmExtraction(mailKey);
      const tx = conn.transaction(STORE_LLM_EXTRACTIONS, "readonly");
      const found = await reqPromise(tx.objectStore(STORE_LLM_EXTRACTIONS).get(mailKey));
      return (found as MailLlmExtraction | undefined) ?? null;
    },
    async putLlmExtraction(entry) {
      const conn = await db();
      if (!conn) return fallback.putLlmExtraction(entry);
      const tx = conn.transaction(STORE_LLM_EXTRACTIONS, "readwrite");
      tx.objectStore(STORE_LLM_EXTRACTIONS).put(entry);
      await txDone(tx);
    },
    async putLlmExtractions(entries) {
      if (entries.length === 0) return;
      const conn = await db();
      if (!conn) return fallback.putLlmExtractions(entries);
      const tx = conn.transaction(STORE_LLM_EXTRACTIONS, "readwrite");
      const store = tx.objectStore(STORE_LLM_EXTRACTIONS);
      for (const entry of entries) store.put(entry);
      await txDone(tx);
    },
    async clearLlmExtractions() {
      const conn = await db();
      if (!conn) return fallback.clearLlmExtractions();
      const tx = conn.transaction(STORE_LLM_EXTRACTIONS, "readwrite");
      tx.objectStore(STORE_LLM_EXTRACTIONS).clear();
      await txDone(tx);
    },
  };
}

let sharedDb: DecisionCacheStore | null = null;

export function decisionDb(): DecisionCacheStore {
  sharedDb ??= createIndexedDecisionDb();
  return sharedDb;
}
