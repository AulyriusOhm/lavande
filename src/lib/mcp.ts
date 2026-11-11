import { useSyncExternalStore } from "react";

export type McpTool = {
  name: string;
  description: string;
  scope: "lecture" | "écriture" | "signature";
};

export type McpServer = {
  id: string;
  name: string;
  description: string;
  transport: "stdio" | "http";
  status: "connected" | "idle" | "error";
  tools: McpTool[];
};

export const MCP_SCOPES: { id: McpTool["scope"]; hint: string }[] = [
  { id: "lecture", hint: "consultation seule" },
  { id: "écriture", hint: "modifie la boîte ou l'agenda" },
  { id: "signature", hint: "chiffre ou vérifie" },
];

export const MCP_SERVERS: McpServer[] = [
  {
    id: "mail",
    name: "lavande-mail",
    description: "Boîtes, dossiers, recherche full-text",
    transport: "stdio",
    status: "connected",
    tools: [
      { name: "mail.search", description: "Recherche multi-comptes", scope: "lecture" },
      { name: "mail.read", description: "Corps complet + pièces jointes", scope: "lecture" },
      { name: "mail.draft", description: "Prépare un brouillon", scope: "écriture" },
      { name: "mail.send", description: "Envoi après confirmation", scope: "écriture" },
      { name: "mail.label", description: "Étiquettes et dossiers", scope: "écriture" },
      { name: "mail.move", description: "Déplace vers un dossier", scope: "écriture" },
      { name: "mail.delete", description: "Met à la corbeille", scope: "écriture" },
    ],
  },
  {
    id: "calendar",
    name: "lavande-calendar",
    description: "Agenda CalDAV, disponibilités",
    transport: "stdio",
    status: "connected",
    tools: [
      { name: "calendar.list", description: "Événements d'une plage", scope: "lecture" },
      { name: "calendar.create", description: "Crée un événement", scope: "écriture" },
      { name: "calendar.free", description: "Créneaux libres", scope: "lecture" },
    ],
  },
  {
    id: "pgp",
    name: "pgp-signer",
    description: "Chiffrement et vérification hors processus",
    transport: "stdio",
    status: "connected",
    tools: [
      { name: "pgp.verify", description: "Vérifie une signature", scope: "signature" },
      { name: "pgp.encrypt", description: "Chiffre vers une clé", scope: "signature" },
    ],
  },
  {
    id: "filesystem",
    name: "filesystem",
    description: "Pièces jointes montées en lecture",
    transport: "http",
    status: "idle",
    tools: [{ name: "fs.read", description: "Lit un fichier joint", scope: "lecture" }],
  },
];

export function mcpCounts(active: (server: McpServer) => boolean = (server) => server.status === "connected") {
  const servers = MCP_SERVERS.filter(active);
  return {
    servers: MCP_SERVERS.length,
    activeServers: servers.length,
    activeTools: servers.reduce((total, server) => total + server.tools.length, 0),
    installedTools: MCP_SERVERS.reduce((total, server) => total + server.tools.length, 0),
  };
}

export type McpActionType =
  | "envoi"
  | "suppression"
  | "déplacement"
  | "brouillon"
  | "création de RDV"
  | "chiffrement"
  | "modification";

export const MCP_ACTION_TYPES: { id: McpActionType; hint: string }[] = [
  { id: "envoi", hint: "envoie un message en ton nom" },
  { id: "suppression", hint: "efface un message ou un événement" },
  { id: "déplacement", hint: "range dans un dossier ou une étiquette" },
  { id: "brouillon", hint: "prépare un message sans l'envoyer" },
  { id: "création de RDV", hint: "écrit un événement dans l'agenda" },
  { id: "chiffrement", hint: "chiffre, signe ou vérifie avec ta clé" },
  { id: "modification", hint: "toute autre écriture" },
];

const TOOL_TYPES: Record<string, McpActionType> = {
  "mail.send": "envoi",
  "mail.draft": "brouillon",
  "mail.label": "déplacement",
  "mail.move": "déplacement",
  "mail.delete": "suppression",
  "calendar.create": "création de RDV",
  "calendar.delete": "suppression",
  "calendar.update": "création de RDV",
  "pgp.encrypt": "chiffrement",
  "pgp.decrypt": "chiffrement",
  "pgp.sign": "chiffrement",
};

const TYPE_PATTERNS: { pattern: RegExp; type: McpActionType }[] = [
  { pattern: /(send|reply|forward)/i, type: "envoi" },
  { pattern: /(delete|remove|trash|purge|erase)/i, type: "suppression" },
  { pattern: /(move|label|archive|folder)/i, type: "déplacement" },
  { pattern: /(draft|compose)/i, type: "brouillon" },
  { pattern: /(event|appointment|meeting)/i, type: "création de RDV" },
  { pattern: /(encrypt|decrypt|sign|verify|pgp|key)/i, type: "chiffrement" },
];

const catalogueTool = (name: string): McpTool | null =>
  MCP_SERVERS.flatMap((server) => server.tools).find((tool) => tool.name === name) ?? null;

export function mcpActionType(tool: string): McpActionType | null {
  if (catalogueTool(tool)?.scope === "lecture") return null;
  const explicit = TOOL_TYPES[tool];
  if (explicit) return explicit;
  return TYPE_PATTERNS.find(({ pattern }) => pattern.test(tool))?.type ?? "modification";
}

export type McpRights = {
  enabled: Record<string, boolean>;
  alwaysAllow: Record<string, boolean>;
  confirmSend: boolean;
};

export const DEFAULT_MCP_RIGHTS: McpRights = { enabled: {}, alwaysAllow: {}, confirmSend: true };

let rights: McpRights = DEFAULT_MCP_RIGHTS;

export function setMcpRights(next: McpRights): void {
  rights = { enabled: next.enabled, alwaysAllow: next.alwaysAllow, confirmSend: next.confirmSend };
}

export function resetMcpRights(): void {
  rights = DEFAULT_MCP_RIGHTS;
}

export function getMcpRights(): McpRights {
  return rights;
}

export function mcpTypeAllowed(
  type: McpActionType,
  prefs: { alwaysAllow: Record<string, boolean>; confirmSend: boolean },
): boolean {
  const stored = prefs.alwaysAllow[type];
  if (typeof stored === "boolean") return stored;
  return type === "envoi" ? !prefs.confirmSend : false;
}

export type McpLogEntry = {
  time: string;
  tool: string;
  server: string;
  agent: string;
  status: "succès" | "échec" | "refusé";
  detail: string;
};

export type McpLogInput = {
  tool: string;
  server: string;
  agent?: string;
  status: McpLogEntry["status"];
  detail: string;
};

export const MCP_LOG_KEY = "lavande.mcp.log";
export const MCP_LOG_LIMIT = 200;

const LOG_STATUS: McpLogEntry["status"][] = ["succès", "échec", "refusé"];

const asLogEntry = (value: unknown): McpLogEntry | null => {
  if (!value || typeof value !== "object") return null;
  const { time, tool, server, agent, status, detail } = value as Record<string, unknown>;
  if (typeof time !== "string" || Number.isNaN(Date.parse(time))) return null;
  if (typeof tool !== "string" || !tool) return null;
  if (typeof detail !== "string") return null;
  if (!LOG_STATUS.includes(status as McpLogEntry["status"])) return null;
  return {
    time,
    tool,
    server: typeof server === "string" ? server : "",
    agent: typeof agent === "string" ? agent : "",
    status: status as McpLogEntry["status"],
    detail,
  };
};

export function readMcpLog(): McpLogEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MCP_LOG_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const entries = parsed
      .map(asLogEntry)
      .filter((entry): entry is McpLogEntry => entry !== null)
      .slice(0, MCP_LOG_LIMIT);
    return entries;
  } catch {
    return [];
  }
}

let journal = readMcpLog();
const journalListeners = new Set<() => void>();

const emitJournal = () => {
  for (const listener of journalListeners) listener();
};

const persistJournal = () => {
  try {
    localStorage.setItem(MCP_LOG_KEY, JSON.stringify(journal));
  } catch {
    journal = journal.slice(0, 20);
  }
};

export function getMcpLog(): McpLogEntry[] {
  return journal;
}

export function subscribeMcpLog(listener: () => void): () => void {
  journalListeners.add(listener);
  return () => {
    journalListeners.delete(listener);
  };
}

export function useMcpLog(): McpLogEntry[] {
  return useSyncExternalStore(subscribeMcpLog, getMcpLog, getMcpLog);
}

export function recordMcpAction(input: McpLogInput): void {
  journal = [
    {
      time: new Date().toISOString(),
      tool: input.tool,
      server: input.server,
      agent: input.agent?.trim() || input.server,
      status: input.status,
      detail: input.detail,
    },
    ...journal,
  ].slice(0, MCP_LOG_LIMIT);
  persistJournal();
  emitJournal();
}

export function clearMcpLog(): void {
  journal = [];
  persistJournal();
  emitJournal();
}

export function mcpLogClock(time: string): string {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

export function mcpCallsLastDay(entries: McpLogEntry[] = journal, now = Date.now()): number {
  return entries.filter((entry) => {
    const time = Date.parse(entry.time);
    return Number.isFinite(time) && time <= now && now - time < 86_400_000;
  }).length;
}

export type McpApprovalRequest = {
  id: string;
  server: string;
  serverName: string;
  tool: string;
  type: McpActionType;
  detail: string;
  agent: string;
};

let approvals: McpApprovalRequest[] = [];
let approvalSeq = 0;
const approvalListeners = new Set<() => void>();
const waiting = new Map<string, (approved: boolean) => void>();

const emitApprovals = () => {
  for (const listener of approvalListeners) listener();
};

export function getMcpApprovals(): McpApprovalRequest[] {
  return approvals;
}

export function subscribeMcpApprovals(listener: () => void): () => void {
  approvalListeners.add(listener);
  return () => {
    approvalListeners.delete(listener);
  };
}

export function useMcpApprovals(): McpApprovalRequest[] {
  return useSyncExternalStore(subscribeMcpApprovals, getMcpApprovals, getMcpApprovals);
}

export function resolveMcpApproval(id: string, approved: boolean): void {
  if (!approvals.some((entry) => entry.id === id)) return;
  approvals = approvals.filter((entry) => entry.id !== id);
  emitApprovals();
  const waiter = waiting.get(id);
  waiting.delete(id);
  waiter?.(approved);
}

function askApproval(request: Omit<McpApprovalRequest, "id">): Promise<boolean> {
  approvalSeq += 1;
  const entry: McpApprovalRequest = { ...request, id: `mcp-approval-${approvalSeq}` };
  approvals = [...approvals, entry];
  emitApprovals();
  return new Promise((resolve) => {
    waiting.set(entry.id, resolve);
  });
}

export type McpActionRequest = {
  server: string;
  tool: string;
  detail: string;
  agent?: string;
};

export async function requestMcpAction({
  server,
  tool,
  detail,
  agent,
}: McpActionRequest): Promise<boolean> {
  const target = MCP_SERVERS.find((entry) => entry.id === server || entry.name === server) ?? null;
  const serverName = target?.name ?? server;
  const agentName = agent?.trim() || serverName;
  const refuse = (reason: string) => {
    recordMcpAction({ tool, server: serverName, agent: agentName, status: "refusé", detail: `${detail} · ${reason}` });
    return false;
  };

  if (!target) return refuse("serveur inconnu");
  const exposed = target.tools.find((entry) => entry.name === tool);
  if (!exposed) return refuse("outil non exposé");
  const isOn = rights.enabled[target.id] ?? target.status === "connected";
  if (!isOn) return refuse("serveur désactivé");
  if (exposed.scope === "lecture") {
    recordMcpAction({ tool, server: serverName, agent: agentName, status: "succès", detail });
    return true;
  }

  const type = mcpActionType(tool) ?? "modification";
  if (mcpTypeAllowed(type, rights)) {
    recordMcpAction({
      tool,
      server: serverName,
      agent: agentName,
      status: "succès",
      detail: `${detail} · ${type} autorisé d'avance`,
    });
    return true;
  }

  const approved = await askApproval({ server: target.id, serverName, tool, type, detail, agent: agentName });
  recordMcpAction({
    tool,
    server: serverName,
    agent: agentName,
    status: approved ? "succès" : "refusé",
    detail: `${detail} · ${type} ${approved ? "approuvé" : "refusé"}`,
  });
  return approved;
}
