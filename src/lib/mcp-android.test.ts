import { describe, expect, it } from "vitest";
import {
  MCP_ACTION_TYPES,
  MCP_SCOPES,
  MCP_SERVERS,
  getMcpApprovals,
  getMcpLog,
  mcpActionType,
  mcpCallsLastDay,
  mcpCounts,
  mcpTypeAllowed,
  readMcpLog,
  requestMcpAction,
} from "@/lib/mcp.android";
import { MCP_SERVERS as REAL_SERVERS, mcpCounts as realCounts } from "@/lib/mcp";

describe("stub MCP Android", () => {
  it("expose les mêmes exports, vides", () => {
    expect(MCP_SERVERS).toEqual([]);
    expect(MCP_SCOPES).toEqual([]);
    expect(MCP_ACTION_TYPES).toEqual([]);
    expect(getMcpLog()).toEqual([]);
    expect(readMcpLog()).toEqual([]);
    expect(getMcpApprovals()).toEqual([]);
  });

  it("refuse toute action sans rien journaliser", async () => {
    expect(await requestMcpAction({ server: "lavande-mail", tool: "mail.search", detail: "factures" })).toBe(false);
    expect(await requestMcpAction({ server: "lavande-mail", tool: "mail.send", detail: "devis" })).toBe(false);
    expect(getMcpLog()).toEqual([]);
    expect(getMcpApprovals()).toEqual([]);
  });

  it("ne type aucune action et ne compte aucun appel", () => {
    expect(mcpActionType("mail.send")).toBeNull();
    expect(mcpTypeAllowed("envoi", { alwaysAllow: {}, confirmSend: false })).toBe(false);
    expect(mcpCallsLastDay()).toBe(0);
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
