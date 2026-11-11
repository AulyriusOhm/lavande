import type { McpLogEntry, McpServer, McpTool } from "./mcp";

export type { McpLogEntry, McpServer, McpTool };

export const MCP_SCOPES: { id: McpTool["scope"]; hint: string }[] = [];

export const MCP_SERVERS: McpServer[] = [];

export const MCP_LOG: McpLogEntry[] = [];

export function mcpCounts(_active?: (server: McpServer) => boolean) {
  return { servers: 0, activeServers: 0, activeTools: 0, installedTools: 0 };
}
