import type {
  McpActionRequest,
  McpActionType,
  McpApprovalRequest,
  McpLogEntry,
  McpLogInput,
  McpRights,
  McpServer,
  McpTool,
} from "./mcp";

export type {
  McpActionRequest,
  McpActionType,
  McpApprovalRequest,
  McpLogEntry,
  McpLogInput,
  McpRights,
  McpServer,
  McpTool,
};

export const MCP_SCOPES: { id: McpTool["scope"]; hint: string }[] = [];

export const MCP_SERVERS: McpServer[] = [];

export const MCP_ACTION_TYPES: { id: McpActionType; hint: string }[] = [];

export const MCP_LOG_KEY = "lavande.mcp.log";

export const MCP_LOG_LIMIT = 200;

export const DEFAULT_MCP_RIGHTS: McpRights = { enabled: {}, alwaysAllow: {}, confirmSend: true };

const EMPTY_LOG: McpLogEntry[] = [];

const EMPTY_APPROVALS: McpApprovalRequest[] = [];

export function mcpCounts(_active?: (server: McpServer) => boolean) {
  return { servers: 0, activeServers: 0, activeTools: 0, installedTools: 0 };
}

export function mcpActionType(_tool: string): McpActionType | null {
  return null;
}

export function setMcpRights(_next: McpRights): void {}

export function resetMcpRights(): void {}

export function getMcpRights(): McpRights {
  return DEFAULT_MCP_RIGHTS;
}

export function mcpTypeAllowed(
  _type: McpActionType,
  _prefs: { alwaysAllow: Record<string, boolean>; confirmSend: boolean },
): boolean {
  return false;
}

export function readMcpLog(): McpLogEntry[] {
  return EMPTY_LOG;
}

export function getMcpLog(): McpLogEntry[] {
  return EMPTY_LOG;
}

export function subscribeMcpLog(_listener: () => void): () => void {
  return () => {};
}

export function useMcpLog(): McpLogEntry[] {
  return EMPTY_LOG;
}

export function recordMcpAction(_input: McpLogInput): void {}

export function clearMcpLog(): void {}

export function mcpLogClock(_time: string): string {
  return "--:--";
}

export function mcpCallsLastDay(_entries: McpLogEntry[] = EMPTY_LOG, _now = Date.now()): number {
  return 0;
}

export function getMcpApprovals(): McpApprovalRequest[] {
  return EMPTY_APPROVALS;
}

export function subscribeMcpApprovals(_listener: () => void): () => void {
  return () => {};
}

export function useMcpApprovals(): McpApprovalRequest[] {
  return EMPTY_APPROVALS;
}

export function resolveMcpApproval(_id: string, _approved: boolean): void {}

export async function requestMcpAction(_request: McpActionRequest): Promise<boolean> {
  return false;
}
