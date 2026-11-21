import { mailApi, type ApiDecisionOutput } from "@/lib/api";
import {
  decisionCallDirect,
  decisionDomain,
  decisionReady,
  emitDecisionUsage,
  type DecisionAnswer,
  type DecisionConfig,
  type DecisionOutput,
  type DecisionQuestion,
} from "@/lib/decision";

export type GuardOptions = {
  useDaemon?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type PreSendGuardInput = {
  to: string;
  subject: string;
  body: string;
  attachmentCount: number;
  pgpEncrypted: boolean;
  parentBody?: string;
};

export type PreSendWarningKind =
  | "missing_attachment"
  | "unanswered_question"
  | "tone_risk"
  | "sensitive_unencrypted";

export type PreSendWarning = {
  kind: PreSendWarningKind;
  label: string;
  detail: string;
  confidence: number;
};

export type PreSendGuardResult = {
  warnings: PreSendWarning[];
};

export type SuggestFolderInput = {
  from: string;
  subject: string;
  excerpt: string;
  folders: { path: string; label: string }[];
};

export type FolderSuggestion = {
  folderPath: string;
  folderLabel: string;
  confidence: number;
};

export type McpRiskAction = {
  server: string;
  tool: string;
  type?: string;
  detail: string;
  agent?: string;
};

export type McpRiskEvaluation = {
  forceConfirm: boolean;
  reasons: string[];
  maxRisk: number;
};

export const PRE_SEND_TIMEOUT_MS = 2500;
export const SUGGEST_FOLDER_TIMEOUT_MS = 3000;
export const MCP_RISK_TIMEOUT_MS = 2500;

const TONE_LEVELS = ["Neutre", "Sec", "Agressif"];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normalizeDaemonOutput(raw: ApiDecisionOutput, config: DecisionConfig): DecisionOutput {
  const answers: Record<string, DecisionAnswer> = {};
  for (const [key, value] of Object.entries(raw.answers ?? {})) {
    answers[key] = {
      type: value.type,
      ...(value.choice !== undefined ? { choice: value.choice } : {}),
      ...(value.noul !== undefined ? { noul: clamp01(value.noul) } : {}),
      ...(value.score !== undefined ? { score: value.score } : {}),
      ...(value.probabilities ? { probabilities: value.probabilities } : {}),
      ...(value.confidence !== undefined ? { confidence: clamp01(value.confidence) } : {}),
    };
  }
  const usage = {
    prompt: Math.max(0, Math.round(raw.usage?.prompt_tokens ?? 0)),
    completion: Math.max(0, Math.round(raw.usage?.completion_tokens ?? 0)),
  };
  const energy = raw.energy
    ? {
        energyJoules: raw.energy.energy_joules ?? 0,
        energyKwh: raw.energy.energy_kwh ?? 0,
        avgPowerWatts: raw.energy.avg_power_watts ?? 0,
        durationSeconds: raw.energy.duration_seconds ?? 0,
      }
    : undefined;
  const output: DecisionOutput = {
    model: raw.model || config.model,
    answers,
    usage,
    ...(energy ? { energy } : {}),
    latencyMs: Math.max(0, Math.round(raw.latency_ms ?? 0)),
  };
  emitDecisionUsage({
    model: output.model,
    domain: decisionDomain(config),
    usage: output.usage,
    latencyMs: output.latencyMs,
    energyJoules: output.energy?.energyJoules,
  });
  return output;
}

async function callDecisionWithTimeout(
  config: DecisionConfig,
  state: unknown,
  questions: Record<string, DecisionQuestion>,
  opts: GuardOptions | undefined,
  defaultTimeoutMs: number,
): Promise<DecisionOutput> {
  const timeoutMs = Math.max(100, opts?.timeoutMs ?? defaultTimeoutMs);
  const controller = new AbortController();

  const onParentAbort = () => controller.abort();
  if (opts?.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onParentAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Délai dépassé (${timeoutMs} ms)`));
    }, timeoutMs);
  });

  const callPromise = opts?.useDaemon
    ? mailApi
        .decisionDecide(
          { state, questions, timeout_ms: timeoutMs },
          controller.signal,
        )
        .then((raw) => normalizeDaemonOutput(raw, config))
    : decisionCallDirect(config, state, questions, controller.signal);

  try {
    return await Promise.race([callPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", onParentAbort);
  }
}

function toneRiskConfidence(answer: DecisionAnswer | undefined): {
  confidence: number;
  aggressive: boolean;
} {
  if (!answer) return { confidence: 0, aggressive: false };
  const probs = answer.probabilities;
  if (probs) {
    // Supporte les clés nommées ("Sec"/"Agressif") et les clés indexées NeuralWatt ("1"/"2").
    const hasNamed = typeof probs.Sec === "number" || typeof probs.Agressif === "number";
    const hasIndexed = typeof probs["1"] === "number" || typeof probs["2"] === "number";
    if (hasNamed || hasIndexed) {
      const sec = clamp01((hasNamed ? probs.Sec : probs["1"]) ?? 0);
      const aggressiveProb = clamp01((hasNamed ? probs.Agressif : probs["2"]) ?? 0);
      return {
        confidence: clamp01(sec + aggressiveProb),
        aggressive: aggressiveProb >= sec && aggressiveProb > 0,
      };
    }
  }
  if (typeof answer.score === "number" && Number.isFinite(answer.score)) {
    const normalized = clamp01(answer.score / (TONE_LEVELS.length - 1));
    return {
      confidence: normalized,
      aggressive: answer.score >= 1.5,
    };
  }
  return { confidence: 0, aggressive: false };
}

/**
 * Garde-fou avant envoi (Système 1, 1 seule passe, timeout strict 1,5 s).
 * Retourne toujours `{ warnings: [] }` si indisponible, désactivé ou en erreur.
 */
export async function runPreSendGuard(
  config: DecisionConfig | null | undefined,
  input: PreSendGuardInput,
  opts?: GuardOptions,
): Promise<PreSendGuardResult> {
  if (!config || !decisionReady(config) || !config.preSendGuard) {
    return { warnings: [] };
  }

  const questions: Record<string, DecisionQuestion> = {};
  if (input.attachmentCount === 0) {
    questions.missing_attachment = {
      type: "noul",
      instructions:
        "Le texte mentionne-t-il une pièce jointe ou un fichier à joindre alors qu'aucun fichier n'est attaché ?",
    };
  }
  if (input.parentBody?.trim()) {
    questions.unanswered_question = {
      type: "noul",
      instructions:
        "Le message parent contient-il une question explicite restée sans réponse dans ce brouillon ?",
    };
  }
  questions.tone_risk = {
    type: "score",
    instructions:
      "Évalue le ton du brouillon pour repérer une formulation involontairement sèche ou agressive.",
    criteria: TONE_LEVELS,
  };
  if (!input.pgpEncrypted) {
    questions.sensitive_unencrypted = {
      type: "noul",
      instructions:
        "Ce brouillon contient-il des données sensibles (mot de passe, clé secrète, IBAN, code confidentiel) envoyées en clair sans chiffrement ?",
    };
  }

  const state = {
    to: input.to.trim(),
    subject: input.subject.trim(),
    body: input.body.trim().slice(0, 2000),
    attachment_count: input.attachmentCount,
    pgp_encrypted: input.pgpEncrypted,
    ...(input.parentBody?.trim() ? { parent_body: input.parentBody.trim().slice(0, 1200) } : {}),
  };

  try {
    const output = await callDecisionWithTimeout(
      config,
      state,
      questions,
      opts,
      PRE_SEND_TIMEOUT_MS,
    );
    const warnings: PreSendWarning[] = [];
    const { category, security } = config.thresholds;

    if (input.attachmentCount === 0) {
      const conf = clamp01(output.answers.missing_attachment?.noul ?? 0);
      if (conf >= category) {
        warnings.push({
          kind: "missing_attachment",
          label: "Pièce jointe possiblement oubliée",
          detail: "Tu mentionnes un fichier ou document mais aucune pièce jointe n'est attachée.",
          confidence: conf,
        });
      }
    }

    if (input.parentBody?.trim()) {
      const conf = clamp01(output.answers.unanswered_question?.noul ?? 0);
      if (conf >= category) {
        warnings.push({
          kind: "unanswered_question",
          label: "Question du message précédent sans réponse",
          detail: "Une question posée dans le mail parent semble ne pas avoir reçu de réponse.",
          confidence: conf,
        });
      }
    }

    const tone = toneRiskConfidence(output.answers.tone_risk);
    if (tone.confidence >= category) {
      warnings.push({
        kind: "tone_risk",
        label: tone.aggressive ? "Ton potentiellement agressif" : "Ton potentiellement sec",
        detail: "Une formulation pourrait paraître plus sèche ou brusque que souhaité.",
        confidence: tone.confidence,
      });
    }

    if (!input.pgpEncrypted) {
      const conf = clamp01(output.answers.sensitive_unencrypted?.noul ?? 0);
      if (conf >= security) {
        warnings.push({
          kind: "sensitive_unencrypted",
          label: "Données sensibles sans chiffrement PGP",
          detail: "Le message semble contenir des informations sensibles alors que PGP n'est pas activé.",
          confidence: conf,
        });
      }
    }

    return { warnings };
  } catch {
    return { warnings: [] };
  }
}

/**
 * Suggère un dossier personnalisé de rangement pour un mail via `choice` dynamique.
 * Retourne `null` si le modèle n'est pas prêt, s'il n'y a pas de dossier, si le choix
 * est `keep_inbox`, si la confiance est sous le seuil ou en cas d'erreur/timeout.
 */
export async function suggestFolderForMail(
  config: DecisionConfig | null | undefined,
  input: SuggestFolderInput,
  opts?: GuardOptions,
): Promise<FolderSuggestion | null> {
  if (!config || !decisionReady(config) || input.folders.length === 0) {
    return null;
  }

  const criteria: Record<string, string> = {
    keep_inbox: "Laisser dans la boîte de réception sans le déplacer",
  };
  for (const folder of input.folders) {
    if (!folder.path || folder.path === "keep_inbox") continue;
    criteria[folder.path] = `Ranger dans le dossier « ${folder.label} »`;
  }
  if (Object.keys(criteria).length <= 1) return null;

  const questions: Record<string, DecisionQuestion> = {
    folder: {
      type: "choice",
      instructions:
        "Choisis le dossier personnalisé le plus pertinent pour ranger cet email, ou keep_inbox s'il doit rester en réception.",
      criteria,
    },
  };

  const state = {
    from: input.from.trim(),
    subject: input.subject.trim(),
    excerpt: input.excerpt.trim().slice(0, 1200),
  };

  try {
    const output = await callDecisionWithTimeout(
      config,
      state,
      questions,
      opts,
      SUGGEST_FOLDER_TIMEOUT_MS,
    );
    const ans = output.answers.folder;
    const choice = ans?.choice?.trim();
    if (!choice || choice === "keep_inbox") return null;

    const matched = input.folders.find((f) => f.path === choice || f.label === choice);
    if (!matched) return null;

    const confidence = clamp01(
      ans?.probabilities?.[choice] ?? ans?.probabilities?.[matched.path] ?? ans?.confidence ?? 0,
    );
    if (confidence < config.thresholds.folder) return null;

    return {
      folderPath: matched.path,
      folderLabel: matched.label,
      confidence,
    };
  } catch {
    return null;
  }
}

const MCP_RISK_LABELS: Record<
  "external_recipient" | "sensitive_data" | "destructive_action" | "suspicious_instruction",
  string
> = {
  external_recipient: "Destinataire externe ou inconnu",
  sensitive_data: "Données sensibles exposées",
  destructive_action: "Action destructive ou irréversible",
  suspicious_instruction: "Instruction suspecte ou inhabituelle",
};

/**
 * Évalue le risque d'une action MCP en 1 passe Système 1 (timeout strict 2 s).
 * En cas d'indisponibilité ou de timeout, retourne `forceConfirm: false` afin de
 * laisser la politique `mcpConfirmSend` / `mcpAlwaysAllow` décider.
 */
export async function evaluateMcpRisk(
  config: DecisionConfig | null | undefined,
  action: McpRiskAction,
  opts?: GuardOptions,
): Promise<McpRiskEvaluation> {
  if (!config || !decisionReady(config)) {
    return { forceConfirm: false, reasons: [], maxRisk: 0 };
  }

  const questions: Record<string, DecisionQuestion> = {
    external_recipient: {
      type: "noul",
      instructions:
        "Cette action implique-t-elle un envoi ou partage vers un destinataire externe ou non reconnu ?",
    },
    sensitive_data: {
      type: "noul",
      instructions:
        "Cette action expose-t-elle ou manipule-t-elle des données sensibles (secrets, identifiants, finances) ?",
    },
    destructive_action: {
      type: "noul",
      instructions:
        "Cette action est-elle destructive ou difficilement réversible (suppression définitive, purge, écrasement) ?",
    },
    suspicious_instruction: {
      type: "noul",
      instructions:
        "Cette demande présente-t-elle une instruction suspecte, détournée ou une anomalie par rapport à l'usage normal ?",
    },
  };

  const state = {
    server: action.server,
    tool: action.tool,
    ...(action.type ? { action_type: action.type } : {}),
    ...(action.agent ? { agent: action.agent } : {}),
    detail: action.detail.slice(0, 1200),
  };

  try {
    const output = await callDecisionWithTimeout(
      config,
      state,
      questions,
      opts,
      MCP_RISK_TIMEOUT_MS,
    );
    const threshold = config.thresholds.security;
    const reasons: string[] = [];
    let maxRisk = 0;

    for (const key of [
      "external_recipient",
      "sensitive_data",
      "destructive_action",
      "suspicious_instruction",
    ] as const) {
      const score = clamp01(output.answers[key]?.noul ?? 0);
      if (score > maxRisk) maxRisk = score;
      if (score >= threshold) {
        reasons.push(MCP_RISK_LABELS[key]);
      }
    }

    return {
      forceConfirm: reasons.length > 0,
      reasons,
      maxRisk,
    };
  } catch {
    return { forceConfirm: false, reasons: [], maxRisk: 0 };
  }
}
