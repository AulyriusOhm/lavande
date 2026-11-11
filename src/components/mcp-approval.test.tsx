import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { McpApprovalDialog } from "@/components/mcp-approval";
import { clearMcpLog, getMcpLog, requestMcpAction, resetMcpRights } from "@/lib/mcp";
import { PrefsProvider } from "@/lib/prefs";

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

function mount() {
  return render(
    <PrefsProvider>
      <McpApprovalDialog />
    </PrefsProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  clearMcpLog();
  resetMcpRights();
});

describe("dialogue d'approbation MCP", () => {
  it("décrit la demande puis autorise l'action", async () => {
    mount();
    const pending = requestMcpAction({
      server: "lavande-calendar",
      tool: "calendar.create",
      detail: "Point équipe · demain 10:00",
      agent: "Agent de test",
    });

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("lavande-calendar")).toBeTruthy();
    expect(screen.getByText("calendar.create")).toBeTruthy();
    expect(screen.getByText("création de RDV")).toBeTruthy();
    expect(screen.getByText("Point équipe · demain 10:00")).toBeTruthy();
    expect(screen.getByText("Agent de test")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Autoriser" }));

    await expect(pending).resolves.toBe(true);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stored().mcpAlwaysAllow).toEqual({});
    expect(getMcpLog()[0]).toMatchObject({ status: "succès", detail: "Point équipe · demain 10:00 · création de RDV approuvé" });
  });

  it("refuse l'action sur Refuser", async () => {
    mount();
    const pending = requestMcpAction({ server: "mail", tool: "mail.delete", detail: "Newsletter" });

    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Refuser" }));

    await expect(pending).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(getMcpLog()[0]).toMatchObject({ status: "refusé" });
  });

  it("« Toujours autoriser ce type » persiste le type puis autorise", async () => {
    mount();
    const pending = requestMcpAction({ server: "mail", tool: "mail.send", detail: "Facture d'août" });

    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Toujours autoriser ce type" }));

    await expect(pending).resolves.toBe(true);
    await waitFor(() => expect(stored().mcpAlwaysAllow).toEqual({ envoi: true }));

    const next = requestMcpAction({ server: "mail", tool: "mail.send", detail: "Devis" });

    await expect(next).resolves.toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(getMcpLog()[0]).toMatchObject({ status: "succès", detail: "Devis · envoi autorisé d'avance" });
  });
});
