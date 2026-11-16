import { useEffect, useRef, useState } from "react";
import { mergeAiStats, readAiStats, statsFromDoc, subscribeAiStats, type AiStats } from "@/lib/ai-stats";
import { demoReadOnly } from "@/lib/mail-backend";
import { usePlanning } from "@/lib/planning-store";
import { usePrefs } from "@/lib/prefs";
import { docKey, visibleDocs, type Doc } from "@/lib/sync/merge";

export const AI_SETTINGS_DOC_ID = "settings";

export function usageDocId(deviceId: string): string {
  return `usage:${deviceId}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Docs `ai` de consommation, un par appareil (`usage:<deviceId>`). */
export function usageDocs(docs: Record<string, Doc>): Doc[] {
  return visibleDocs(docs, "ai").filter((doc) => doc.id.startsWith("usage:"));
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
 * Synchronise la consommation (un doc par appareil) et les réglages du modèle
 * (endpoint + modèle, jamais la clé API). À monter une fois par fenêtre.
 */
export function useAiSync(): void {
  const { engine } = usePlanning();
  const { llm, setLlm, sync } = usePrefs();
  const deviceId = engine.getState().device.id;
  const active = sync.enabled && !demoReadOnly && engine.canEmit();
  const settingsKey = docKey("ai", AI_SETTINGS_DOC_ID);
  const settingsUpdatedAt = engine.getState().docs[settingsKey]?.updatedAt ?? null;
  const seen = useRef<string | null>(null);

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
}
