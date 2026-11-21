import { useEffect, useRef, useState } from "react";
import { mergeAiStats, readAiStats, statsFromDoc, subscribeAiStats, type AiStats } from "@/lib/ai-stats";
import type { MailDecision } from "@/lib/decision";
import { demoReadOnly } from "@/lib/mail-backend";
import { usePlanning } from "@/lib/planning-store";
import { asDecision, usePrefs } from "@/lib/prefs";
import { docKey, visibleDocs, type Doc } from "@/lib/sync/merge";

export const AI_SETTINGS_DOC_ID = "settings";
export const DECISION_SETTINGS_DOC_ID = "decision:settings";
export const DECISION_MAIL_PREFIX = "decision:mail:";

export function usageDocId(deviceId: string): string {
  return `usage:${deviceId}`;
}

export function decisionMailDocId(stableKey: string): string {
  return `${DECISION_MAIL_PREFIX}${stableKey}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Docs `ai` de consommation, un par appareil (`usage:<deviceId>`). */
export function usageDocs(docs: Record<string, Doc>): Doc[] {
  return visibleDocs(docs, "ai").filter((doc) => doc.id.startsWith("usage:"));
}

/** Docs `ai` portant les décisions calculées par un autre appareil (PC → mobile sans clé API). */
export function syncedDecisionDocs(docs: Record<string, Doc>): MailDecision[] {
  const out: MailDecision[] = [];
  for (const doc of visibleDocs(docs, "ai")) {
    if (!doc.id.startsWith(DECISION_MAIL_PREFIX)) continue;
    const raw = doc.raw;
    if (typeof raw.category !== "string" || typeof raw.decidedAt !== "number") continue;
    out.push({
      accountId: text(raw.accountId),
      folderPath: text(raw.folderPath) || "INBOX",
      uid: typeof raw.uid === "number" ? raw.uid : 0,
      ...(typeof raw.messageId === "string" && raw.messageId ? { messageId: raw.messageId } : {}),
      contentHash: text(raw.contentHash),
      schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1,
      model: text(raw.model),
      category: raw.category,
      categoryConf: typeof raw.categoryConf === "number" ? raw.categoryConf : 0.5,
      categoryProbs:
        raw.categoryProbs && typeof raw.categoryProbs === "object"
          ? (raw.categoryProbs as Record<string, number>)
          : {},
      urgency: typeof raw.urgency === "number" ? raw.urgency : 1,
      needsReply: typeof raw.needsReply === "number" ? raw.needsReply : 0,
      hasTask: typeof raw.hasTask === "number" ? raw.hasTask : 0,
      hasEvent: typeof raw.hasEvent === "number" ? raw.hasEvent : 0,
      security: text(raw.security) || "safe",
      securityConf: typeof raw.securityConf === "number" ? raw.securityConf : 0.5,
      cleanupScore: typeof raw.cleanupScore === "number" ? raw.cleanupScore : 0,
      ...(typeof raw.assignee === "string" ? { assignee: raw.assignee } : {}),
      ...(typeof raw.assigneeConf === "number" ? { assigneeConf: raw.assigneeConf } : {}),
      ...(typeof raw.totpCode === "string" ? { totpCode: raw.totpCode } : {}),
      ...(typeof raw.totpService === "string" ? { totpService: raw.totpService } : {}),
      ...(typeof raw.suggestedFolder === "string" ? { suggestedFolder: raw.suggestedFolder } : {}),
      ...(typeof raw.suggestedFolderConf === "number"
        ? { suggestedFolderConf: raw.suggestedFolderConf }
        : {}),
      decidedAt: raw.decidedAt,
      source: "synced",
    });
  }
  return out;
}

export type AiUsageView = { local: AiStats; combined: AiStats; devices: number };

/** Consommation locale + celle des autres appareils (docs `ai` synchronisés). */
export function useAiUsage(): AiUsageView {
  const { engine } = usePlanning();
  const [local, setLocal] = useState(readAiStats);
  useEffect(() => subscribeAiStats(() => setLocal(readAiStats())), []);
  const own = usageDocId(engine.getState().device.id);
  const remote = usageDocs(engine.getState().docs).filter((doc) => doc.id !== own);
  const combined = mergeAiStats([local, ...remote.map((doc) => statsFromDoc(doc.raw))]);
  return { local, combined, devices: remote.length + 1 };
}

/**
 * Synchronise la consommation (un doc par appareil) et les réglages non secrets
 * du LLM et du modèle de décision (jamais les clés API). À monter une fois par fenêtre.
 */
export function useAiSync(): void {
  const { engine } = usePlanning();
  const { llm, setLlm, decision, setDecision, sync } = usePrefs();
  const deviceId = engine.getState().device.id;
  const active = sync.enabled && !demoReadOnly && engine.canEmit();
  const settingsKey = docKey("ai", AI_SETTINGS_DOC_ID);
  const settingsUpdatedAt = engine.getState().docs[settingsKey]?.updatedAt ?? null;
  const seen = useRef<string | null>(null);
  const decisionSettingsKey = docKey("ai", DECISION_SETTINGS_DOC_ID);
  const decisionSettingsUpdatedAt = engine.getState().docs[decisionSettingsKey]?.updatedAt ?? null;
  const seenDecision = useRef<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const id = usageDocId(deviceId);
    const push = () => {
      if (engine.readOnly("ai", id)) return;
      const stats = readAiStats();
      engine.emitLocal("ai", id, {
        usage: stats.total,
        byDay: stats.byDay,
        byModel: stats.byModel,
        byDomain: stats.byDomain,
        decision: stats.decision,
      });
    };
    push();
    return subscribeAiStats(push);
  }, [active, deviceId, engine]);

  useEffect(() => {
    if (!active) return;
    const doc = engine.getState().docs[settingsKey];
    const updatedAt = doc?.updatedAt ?? null;
    const remote = { endpoint: text(doc?.raw.endpoint), model: text(doc?.raw.model) };
    const local = { endpoint: llm.endpoint, model: llm.model };
    const known = seen.current;
    seen.current = updatedAt;

    const applyRemote = () =>
      setLlm({ endpoint: remote.endpoint || local.endpoint, model: remote.model || local.model });
    const pushLocal = () => {
      if (engine.readOnly("ai", AI_SETTINGS_DOC_ID)) return;
      engine.emitLocal("ai", AI_SETTINGS_DOC_ID, local);
      seen.current = engine.getState().docs[settingsKey]?.updatedAt ?? null;
    };

    if (known === null) {
      if (remote.endpoint === "" && remote.model === "") {
        if (local.endpoint !== "" || local.model !== "") pushLocal();
        return;
      }
      if (remote.endpoint !== local.endpoint || remote.model !== local.model) applyRemote();
      return;
    }
    if (updatedAt !== null && updatedAt !== known) {
      if (remote.endpoint !== local.endpoint || remote.model !== local.model) applyRemote();
      return;
    }
    if (remote.endpoint === local.endpoint && remote.model === local.model) return;
    pushLocal();
  }, [active, engine, llm.endpoint, llm.model, setLlm, settingsKey, settingsUpdatedAt]);

  /** Synchro des réglages non secrets du modèle de décision (seuils, catégories custom, filtre par défaut). */
  const decisionPayload = JSON.stringify({
    provider: decision.provider,
    protocol: decision.protocol,
    endpoint: decision.endpoint,
    model: decision.model,
    authHeader: decision.authHeader,
    thresholds: decision.thresholds,
    customCategories: decision.customCategories,
    defaultInboxFilter: decision.defaultInboxFilter,
    notifMode: decision.notifMode,
    preSendGuard: decision.preSendGuard,
    totpPopup: decision.totpPopup,
    trustedSenders: decision.trustedSenders,
    trustedDomains: decision.trustedDomains,
  });

  useEffect(() => {
    if (!active) return;
    const doc = engine.getState().docs[decisionSettingsKey];
    const updatedAt = doc?.updatedAt ?? null;
    const known = seenDecision.current;
    seenDecision.current = updatedAt;
    const localObj = JSON.parse(decisionPayload) as Record<string, unknown>;

    const applyRemote = () => {
      if (!doc?.raw) return;
      const parsed = asDecision(doc.raw);
      setDecision({
        provider: parsed.provider,
        protocol: parsed.protocol,
        endpoint: parsed.endpoint,
        model: parsed.model,
        authHeader: parsed.authHeader,
        thresholds: parsed.thresholds,
        customCategories: parsed.customCategories,
        defaultInboxFilter: parsed.defaultInboxFilter,
        notifMode: parsed.notifMode,
        preSendGuard: parsed.preSendGuard,
        totpPopup: parsed.totpPopup,
        trustedSenders: parsed.trustedSenders,
        trustedDomains: parsed.trustedDomains,
      });
    };
    const pushLocal = () => {
      if (engine.readOnly("ai", DECISION_SETTINGS_DOC_ID)) return;
      engine.emitLocal("ai", DECISION_SETTINGS_DOC_ID, localObj);
      seenDecision.current = engine.getState().docs[decisionSettingsKey]?.updatedAt ?? null;
    };

    if (known === null) {
      if (!doc?.raw || Object.keys(doc.raw).length === 0) {
        if (
          decision.enabled ||
          decision.customCategories.length > 0 ||
          decision.trustedSenders.length > 0 ||
          decision.trustedDomains.length > 0
        ) {
          pushLocal();
        }
        return;
      }
      applyRemote();
      return;
    }
    if (updatedAt !== null && updatedAt !== known) {
      applyRemote();
      return;
    }
    const remoteStr = JSON.stringify({
      provider: doc?.raw.provider,
      protocol: doc?.raw.protocol,
      endpoint: doc?.raw.endpoint,
      model: doc?.raw.model,
      authHeader: doc?.raw.authHeader,
      thresholds: doc?.raw.thresholds,
      customCategories: doc?.raw.customCategories,
      defaultInboxFilter: doc?.raw.defaultInboxFilter,
      notifMode: doc?.raw.notifMode,
      preSendGuard: doc?.raw.preSendGuard,
      totpPopup: doc?.raw.totpPopup,
      trustedSenders: doc?.raw.trustedSenders,
      trustedDomains: doc?.raw.trustedDomains,
    });
    if (remoteStr === decisionPayload) return;
    pushLocal();
  }, [
    active,
    decision.customCategories.length,
    decision.enabled,
    decision.trustedDomains.length,
    decision.trustedSenders.length,
    decisionPayload,
    decisionSettingsKey,
    decisionSettingsUpdatedAt,
    engine,
    setDecision,
  ]);
}
