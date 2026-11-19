import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { ComposeDraft } from "@/lib/draft";
import { baseDraft } from "@/lib/draft";
import type { Mail } from "@/lib/mail";

const storeMock = vi.hoisted(() => ({
  mode: "demo" as "api" | "demo",
  mails: [] as unknown[],
}));

vi.mock("@/lib/store", () => ({
  useMailStore: () => ({
    mailAccounts: [{ id: "perso", label: "Perso", email: "roman@lavande.mail" }],
    mails: storeMock.mails,
    mode: storeMock.mode,
    folderRecords: [],
    saveToDrafts: async () => true,
  }),
}));

vi.mock("@/lib/prefs", () => ({
  usePrefs: () => ({
    signatures: [],
    llm: { endpoint: "", apiKey: "", model: "" },
    threadView: "tidy",
  }),
  activeSignature: () => null,
}));

const { ComposeScreen } = await import("@/screens/compose-screen");

const PANTALEO = "pantaleo.s@grenoble.archi.fr";

const correspondent = (name: string, email: string): Mail =>
  ({ name, email, folder: "inbox", tone: 0 }) as unknown as Mail;

function Harness({ onChange }: { onChange?: (draft: ComposeDraft) => void }) {
  const [draft, setDraft] = useState<ComposeDraft>({
    ...baseDraft("perso", false, false),
    to: "",
    cc: "",
    cci: "",
    subject: "",
    body: "",
  });
  return (
    <ComposeScreen
      draft={draft}
      onDraftChange={(next) => {
        setDraft(next);
        onChange?.(next);
      }}
      onClose={() => {}}
    />
  );
}

const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const toField = () => field("compose-to");
const options = () => {
  const list = screen.queryByRole("listbox");
  return list ? within(list).queryAllByRole("option") : [];
};

function type(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

const reply = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as unknown as Response;

let queries: URLSearchParams[] = [];

function apiBackend(contacts: unknown[]) {
  queries = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const { pathname, searchParams } = new URL(String(input), "http://localhost");
    if (pathname.endsWith("/api/contacts")) {
      queries.push(searchParams);
      return reply(contacts);
    }
    return reply({});
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("compose · autocomplétion des destinataires", () => {
  beforeEach(() => {
    storeMock.mode = "demo";
    storeMock.mails = [
      correspondent("Pantaleo Sanchez", PANTALEO),
      correspondent("Camille Roux", "camille@studio-lilas.fr"),
    ];
  });

  it("propose les contacts de la boîte en démo", async () => {
    render(<Harness />);
    type(toField(), "panta");

    await waitFor(() => expect(options().length).toBe(1));
    expect(options()[0].textContent).toContain("Pantaleo Sanchez");
    expect(options()[0].textContent).toContain(PANTALEO);
  });

  it("insère l'adresse nue au clavier et garde le focus", async () => {
    const drafts: ComposeDraft[] = [];
    render(<Harness onChange={(next) => drafts.push(next)} />);
    toField().focus();
    type(toField(), "panta");
    await waitFor(() => expect(options().length).toBe(1));

    fireEvent.keyDown(toField(), { key: "ArrowDown" });
    fireEvent.keyDown(toField(), { key: "Enter" });

    expect(drafts[drafts.length - 1].to).toBe(`${PANTALEO}, `);
    await waitFor(() => expect(document.activeElement).toBe(toField()));
    await waitFor(() => expect(options().length).toBe(0));
    expect(screen.getByLabelText("Envoyer le message")).toBeTruthy();
  });

  it("insère l'adresse nue au clic, sans casser la validation", async () => {
    const drafts: ComposeDraft[] = [];
    render(<Harness onChange={(next) => drafts.push(next)} />);
    type(toField(), "panta");
    await waitFor(() => expect(options().length).toBe(1));

    fireEvent.click(options()[0]);

    expect(drafts[drafts.length - 1].to).toBe(`${PANTALEO}, `);
    await waitFor(() =>
      expect(screen.queryByText(/Adresse invalide/)).toBeNull(),
    );
  });

  it("remplace le fragment courant d'un champ multi-adresses", async () => {
    const drafts: ComposeDraft[] = [];
    render(<Harness onChange={(next) => drafts.push(next)} />);
    type(toField(), "camille@studio-lilas.fr, panta");
    await waitFor(() => expect(options().length).toBe(1));

    fireEvent.click(options()[0]);

    expect(drafts[drafts.length - 1].to).toBe(`camille@studio-lilas.fr, ${PANTALEO}, `);
  });

  it("ne propose pas une adresse déjà saisie", async () => {
    render(<Harness />);
    type(toField(), `${PANTALEO}, panta`);

    await waitFor(() => expect(toField().value).toBe(`${PANTALEO}, panta`));
    expect(options().length).toBe(0);
  });

  it("suggère aussi dans Cc et Cci", async () => {
    const drafts: ComposeDraft[] = [];
    render(<Harness onChange={(next) => drafts.push(next)} />);
    type(toField(), "quelqu'un@ailleurs.fr");
    fireEvent.click(screen.getByRole("button", { name: "Afficher le champ Cc" }));
    fireEvent.click(screen.getByRole("button", { name: "Afficher le champ Cci" }));

    type(field("compose-cc"), "panta");
    await waitFor(() => expect(options().length).toBe(1));
    fireEvent.click(options()[0]);
    expect(drafts[drafts.length - 1].cc).toBe(`${PANTALEO}, `);

    type(field("compose-cci"), "camille");
    await waitFor(() => expect(options().length).toBe(1));
    fireEvent.click(options()[0]);
    expect(drafts[drafts.length - 1].cci).toBe("camille@studio-lilas.fr, ");
  });

  it("ferme la liste sur Échap sans toucher au champ", async () => {
    render(<Harness />);
    type(toField(), "panta");
    await waitFor(() => expect(options().length).toBe(1));

    fireEvent.keyDown(toField(), { key: "Escape" });

    expect(options().length).toBe(0);
    expect(toField().value).toBe("panta");
  });
});

describe("compose · autocomplétion branchée sur le démon", () => {
  beforeEach(() => {
    storeMock.mode = "api";
    storeMock.mails = [];
  });

  it("interroge la route contacts sur le fragment courant", async () => {
    apiBackend([
      { email: PANTALEO, name: "Pantaleo Sanchez", received: 4, sent: 2, last_seen: "2026-11-10T10:00:00Z" },
    ]);
    const drafts: ComposeDraft[] = [];
    render(<Harness onChange={(next) => drafts.push(next)} />);

    type(toField(), "panta");
    await waitFor(() => expect(options().length).toBe(1));
    expect(queries[queries.length - 1].get("q")).toBe("panta");

    fireEvent.click(options()[0]);
    expect(drafts[drafts.length - 1].to).toBe(`${PANTALEO}, `);
  });

  it("ne demande rien sur un champ vide", async () => {
    apiBackend([]);
    render(<Harness />);

    type(toField(), " ");
    await waitFor(() => expect(toField().value).toBe(" "));
    expect(queries.length).toBe(0);
  });
});
