import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { DEFAULT_DECISION, type DecisionConfig } from "@/lib/decision";
import {
  MCP_LOG_KEY,
  MCP_LOG_LIMIT,
  clearMcpLog,
  getMcpApprovals,
  getMcpLog,
  mcpActionType,
  mcpCallsLastDay,
  mcpLogClock,
  mcpTypeAllowed,
  readMcpLog,
  recordMcpAction,
  requestMcpAction,
  requiresMcpApprovalWithGuard,
  resetMcpRights,
  resolveMcpApproval,
  setMcpRights,
  useMcpLog,
  type McpLogEntry,
} from "@/lib/mcp";

const detailOf = (index = 0) => getMcpLog()[index];

beforeEach(() => {
  window.localStorage.clear();
  clearMcpLog();
  resetMcpRights();
  for (const entry of getMcpApprovals()) resolveMcpApproval(entry.id, false);
});

describe("taxonomie des actions MCP", () => {
  it("type chaque outil du catalogue", () => {
    expect(mcpActionType("mail.search")).toBeNull();
    expect(mcpActionType("mail.read")).toBeNull();
    expect(mcpActionType("calendar.list")).toBeNull();
    expect(mcpActionType("fs.read")).toBeNull();
    expect(mcpActionType("mail.send")).toBe("envoi");
    expect(mcpActionType("mail.draft")).toBe("brouillon");
    expect(mcpActionType("mail.label")).toBe("déplacement");
    expect(mcpActionType("mail.move")).toBe("déplacement");
    expect(mcpActionType("mail.delete")).toBe("suppression");
    expect(mcpActionType("calendar.create")).toBe("création de RDV");
    expect(mcpActionType("pgp.encrypt")).toBe("chiffrement");
  });

  it("déduit le type d'un outil inconnu et retombe sur « modification »", () => {
    expect(mcpActionType("calendar.delete")).toBe("suppression");
    expect(mcpActionType("mail.archive")).toBe("déplacement");
    expect(mcpActionType("mail.teleport")).toBe("modification");
  });
});

describe("toujours autoriser par type", () => {
  it("hérite de mcpConfirmSend pour le type envoi", () => {
    expect(mcpTypeAllowed("envoi", { alwaysAllow: {}, confirmSend: true })).toBe(false);
    expect(mcpTypeAllowed("envoi", { alwaysAllow: {}, confirmSend: false })).toBe(true);
  });

  it("laisse toujours les autres types en attente par défaut", () => {
    expect(mcpTypeAllowed("suppression", { alwaysAllow: {}, confirmSend: false })).toBe(false);
  });

  it("donne priorité à un choix explicite stocké", () => {
    expect(mcpTypeAllowed("envoi", { alwaysAllow: { envoi: false }, confirmSend: false })).toBe(false);
    expect(mcpTypeAllowed("suppression", { alwaysAllow: { suppression: true }, confirmSend: true })).toBe(true);
  });
});

describe("moteur de permission MCP", () => {
  it("laisse passer une lecture et la journalise", async () => {
    await expect(
      requestMcpAction({ server: "lavande-mail", tool: "mail.search", detail: "« factures »" }),
    ).resolves.toBe(true);

    expect(getMcpApprovals()).toEqual([]);
    expect(detailOf()).toMatchObject({
      tool: "mail.search",
      server: "lavande-mail",
      agent: "lavande-mail",
      status: "succès",
      detail: "« factures »",
    });
  });

  it("met une écriture en attente jusqu'à l'approbation", async () => {
    const pending = requestMcpAction({
      server: "mail",
      tool: "mail.send",
      detail: "Facture d'août",
      agent: "Agent de test",
    });

    expect(getMcpApprovals()).toHaveLength(1);
    expect(getMcpApprovals()[0]).toMatchObject({
      server: "mail",
      serverName: "lavande-mail",
      tool: "mail.send",
      type: "envoi",
      detail: "Facture d'août",
      agent: "Agent de test",
    });
    expect(getMcpLog()).toEqual([]);

    resolveMcpApproval(getMcpApprovals()[0].id, true);

    await expect(pending).resolves.toBe(true);
    expect(getMcpApprovals()).toEqual([]);
    expect(detailOf()).toMatchObject({ status: "succès", detail: "Facture d'août · envoi approuvé" });
  });

  it("journalise un refus et rend false", async () => {
    const pending = requestMcpAction({ server: "mail", tool: "mail.delete", detail: "Newsletter" });
    resolveMcpApproval(getMcpApprovals()[0].id, false);

    await expect(pending).resolves.toBe(false);
    expect(detailOf()).toMatchObject({
      status: "refusé",
      detail: "Newsletter · suppression refusé",
    });
  });

  it("court-circuite l'approbation d'un type toujours autorisé", async () => {
    setMcpRights({ enabled: {}, alwaysAllow: { envoi: true }, confirmSend: true });

    await expect(requestMcpAction({ server: "mail", tool: "mail.send", detail: "Devis" })).resolves.toBe(true);

    expect(getMcpApprovals()).toEqual([]);
    expect(detailOf()).toMatchObject({ status: "succès", detail: "Devis · envoi autorisé d'avance" });
  });

  it("refuse un serveur désactivé, même en lecture, et le journalise", async () => {
    setMcpRights({ enabled: { mail: false }, alwaysAllow: {}, confirmSend: true });

    await expect(requestMcpAction({ server: "mail", tool: "mail.search", detail: "banque" })).resolves.toBe(false);

    expect(getMcpApprovals()).toEqual([]);
    expect(detailOf()).toMatchObject({ status: "refusé", detail: "banque · serveur désactivé" });
  });

  it("refuse un serveur inconnu et un outil non exposé", async () => {
    await expect(requestMcpAction({ server: "inconnu", tool: "mail.send", detail: "x" })).resolves.toBe(false);
    expect(detailOf()).toMatchObject({ status: "refusé", detail: "x · serveur inconnu" });

    await expect(requestMcpAction({ server: "mail", tool: "mail.teleport", detail: "y" })).resolves.toBe(false);
    expect(detailOf()).toMatchObject({ status: "refusé", detail: "y · outil non exposé" });
  });

  it("garde mcpConfirmSend comme défaut du type envoi (migration)", async () => {
    setMcpRights({ enabled: {}, alwaysAllow: {}, confirmSend: false });
    await expect(requestMcpAction({ server: "mail", tool: "mail.send", detail: "Note" })).resolves.toBe(true);
    expect(getMcpApprovals()).toEqual([]);

    setMcpRights({ enabled: {}, alwaysAllow: {}, confirmSend: true });
    const pending = requestMcpAction({ server: "mail", tool: "mail.send", detail: "Note 2" });
    expect(getMcpApprovals()).toHaveLength(1);
    resolveMcpApproval(getMcpApprovals()[0].id, true);
    await expect(pending).resolves.toBe(true);
  });

  it("conserve l'ordre d'arrivée de deux demandes simultanées", async () => {
    const first = requestMcpAction({ server: "mail", tool: "mail.draft", detail: "Brouillon A" });
    const second = requestMcpAction({ server: "mail", tool: "mail.send", detail: "Envoi B" });

    expect(getMcpApprovals().map((entry) => entry.detail)).toEqual(["Brouillon A", "Envoi B"]);

    resolveMcpApproval(getMcpApprovals()[1].id, false);
    resolveMcpApproval(getMcpApprovals()[0].id, true);

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
  });
});

describe("journal MCP", () => {
  it("persiste les entrées les plus récentes en tête", () => {
    recordMcpAction({ tool: "mail.search", server: "lavande-mail", status: "succès", detail: "premier" });
    recordMcpAction({ tool: "mail.send", server: "lavande-mail", status: "succès", detail: "second" });

    expect(getMcpLog().map((entry) => entry.detail)).toEqual(["second", "premier"]);
    expect(readMcpLog().map((entry) => entry.detail)).toEqual(["second", "premier"]);
    expect(detailOf().time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("plafonne le journal et la persistance", () => {
    for (let index = 0; index < MCP_LOG_LIMIT + 5; index += 1) {
      recordMcpAction({ tool: "mail.search", server: "lavande-mail", status: "succès", detail: `action ${index}` });
    }

    expect(getMcpLog()).toHaveLength(MCP_LOG_LIMIT);
    expect(detailOf().detail).toBe(`action ${MCP_LOG_LIMIT + 4}`);
    expect(readMcpLog()).toHaveLength(MCP_LOG_LIMIT);
    expect(readMcpLog()[0].detail).toBe(`action ${MCP_LOG_LIMIT + 4}`);
  });

  it("ignore les entrées corrompues du stockage", () => {
    window.localStorage.setItem(
      MCP_LOG_KEY,
      JSON.stringify([
        { tool: 12 },
        { time: "pas une date", tool: "mail.send", status: "succès", detail: "x" },
        { time: "2026-01-05T09:38:00.000Z", tool: "mail.send", server: "lavande-mail", status: "inconnu", detail: "y" },
        { time: "2026-01-05T09:38:00.000Z", tool: "mail.send", server: "lavande-mail", status: "succès", detail: "ok" },
      ]),
    );

    expect(readMcpLog()).toEqual([
      {
        time: "2026-01-05T09:38:00.000Z",
        tool: "mail.send",
        server: "lavande-mail",
        agent: "",
        status: "succès",
        detail: "ok",
      },
    ]);
  });

  it("vide le journal et le stockage", () => {
    recordMcpAction({ tool: "mail.send", server: "lavande-mail", status: "échec", detail: "SMTP 550" });
    expect(JSON.parse(window.localStorage.getItem(MCP_LOG_KEY) ?? "[]")).toHaveLength(1);

    clearMcpLog();

    expect(getMcpLog()).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(MCP_LOG_KEY) ?? "null")).toEqual([]);
  });

  it("affiche l'heure locale et compte les appels des dernières 24 h", () => {
    expect(mcpLogClock("2026-01-05T09:38:00.000Z")).toMatch(/^\d{2}:\d{2}$/);
    expect(mcpLogClock("pas une date")).toBe("--:--");

    const now = Date.parse("2026-01-05T12:00:00.000Z");
    const entries: McpLogEntry[] = [
      { time: "2026-01-05T11:00:00.000Z", tool: "a", server: "s", agent: "s", status: "succès", detail: "" },
      { time: "2026-01-03T11:00:00.000Z", tool: "b", server: "s", agent: "s", status: "succès", detail: "" },
    ];

    expect(mcpCallsLastDay(entries, now)).toBe(1);
  });

  it("notifie les abonnés à chaque écriture", () => {
    const { result } = renderHook(() => useMcpLog());
    expect(result.current).toEqual([]);

    act(() => {
      recordMcpAction({ tool: "pgp.verify", server: "pgp-signer", status: "succès", detail: "signature valide" });
    });

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ tool: "pgp.verify", agent: "pgp-signer" });
  });
});

describe("garde-fou MCP intelligent (Système 1)", () => {
  const DECISION_CFG: DecisionConfig = {
    ...DEFAULT_DECISION,
    enabled: true,
    apiKey: "test-key",
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("force l'approbation humaine avec les raisons même si le type est dans alwaysAllow", async () => {
    setMcpRights({ enabled: {}, alwaysAllow: { envoi: true }, confirmSend: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: "mammoth-1",
          answers: {
            external_recipient: { type: "noul", noul: 0.92 },
            sensitive_data: { type: "noul", noul: 0.1 },
            destructive_action: { type: "noul", noul: 0.05 },
            suspicious_instruction: { type: "noul", noul: 0.85 },
          },
          usage: { input_tokens: 60, output_tokens: 0 },
        }),
      })),
    );

    const check = await requiresMcpApprovalWithGuard(
      { server: "mail", tool: "mail.send", detail: "Transfert vers externe@evil.example" },
      DECISION_CFG,
    );
    expect(check.requiresApproval).toBe(true);
    expect(check.forceConfirm).toBe(true);
    expect(check.reasons).toEqual([
      "Destinataire externe ou inconnu",
      "Instruction suspecte ou inhabituelle",
    ]);

    const pending = requestMcpAction({
      server: "mail",
      tool: "mail.send",
      detail: "Transfert vers externe@evil.example",
      decisionConfig: DECISION_CFG,
    });
    await vi.waitFor(() => expect(getMcpApprovals()).toHaveLength(1));
    expect(getMcpApprovals()[0].guardReasons).toEqual([
      "Destinataire externe ou inconnu",
      "Instruction suspecte ou inhabituelle",
    ]);
    resolveMcpApproval(getMcpApprovals()[0].id, false);
    await expect(pending).resolves.toBe(false);
  });

  it("laisse passer sans approbation quand alwaysAllow est actif et aucun risque n'est détecté", async () => {
    setMcpRights({ enabled: {}, alwaysAllow: { envoi: true }, confirmSend: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: "mammoth-1",
          answers: {
            external_recipient: { type: "noul", noul: 0.1 },
            sensitive_data: { type: "noul", noul: 0.05 },
            destructive_action: { type: "noul", noul: 0.0 },
            suspicious_instruction: { type: "noul", noul: 0.02 },
          },
          usage: { input_tokens: 40, output_tokens: 0 },
        }),
      })),
    );

    const check = await requiresMcpApprovalWithGuard(
      { server: "mail", tool: "mail.send", detail: "Réponse interne équipe" },
      DECISION_CFG,
    );
    expect(check).toEqual({
      requiresApproval: false,
      type: "envoi",
      forceConfirm: false,
      reasons: [],
      maxRisk: 0.1,
    });
  });

  it("retombe sur la politique mcpConfirmSend/mcpAlwaysAllow si le modèle de décision est indisponible", async () => {
    setMcpRights({ enabled: {}, alwaysAllow: { envoi: true }, confirmSend: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("timeout");
      }),
    );

    const allowed = await requiresMcpApprovalWithGuard(
      { server: "mail", tool: "mail.send", detail: "Devis" },
      DECISION_CFG,
    );
    expect(allowed.requiresApproval).toBe(false);

    setMcpRights({ enabled: {}, alwaysAllow: {}, confirmSend: true });
    const confirmRequired = await requiresMcpApprovalWithGuard(
      { server: "mail", tool: "mail.send", detail: "Devis" },
      DECISION_CFG,
    );
    expect(confirmRequired.requiresApproval).toBe(true);
  });
});
