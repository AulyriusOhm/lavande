import { describe, expect, it } from "vitest";
import { MCP_LOG, MCP_SCOPES, MCP_SERVERS, mcpCounts } from "@/lib/mcp.android";
import { MCP_SERVERS as REAL_SERVERS, mcpCounts as realCounts } from "@/lib/mcp";

describe("stub MCP Android", () => {
  it("expose les mêmes exports, vides", () => {
    expect(MCP_SERVERS).toEqual([]);
    expect(MCP_SCOPES).toEqual([]);
    expect(MCP_LOG).toEqual([]);
  });

  it("compte zéro serveur et zéro outil, quel que soit le filtre", () => {
    expect(mcpCounts()).toEqual({ servers: 0, activeServers: 0, activeTools: 0, installedTools: 0 });
    expect(mcpCounts(() => true)).toEqual(mcpCounts());
    expect(realCounts()).toEqual({
      servers: REAL_SERVERS.length,
      activeServers: REAL_SERVERS.filter((server) => server.status === "connected").length,
      activeTools: REAL_SERVERS.filter((server) => server.status === "connected").reduce(
        (total, server) => total + server.tools.length,
        0,
      ),
      installedTools: REAL_SERVERS.reduce((total, server) => total + server.tools.length, 0),
    });
  });
});
