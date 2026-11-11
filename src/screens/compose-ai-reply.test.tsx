import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { ComposeDraft } from "@/lib/draft";
import { baseDraft } from "@/lib/draft";

const prefs = vi.hoisted(() => ({
  aiReplyEnabled: true,
  llm: { endpoint: "https://llm.example/v1", apiKey: "sk-test", model: "modele" },
}));

const store = vi.hoisted(() => ({
  accounts: [{ id: "perso", label: "Perso", email: "roman@lavande.mail" }],
  mails: [] as unknown[],
  openThread: undefined as unknown,
}));

vi.mock("@/lib/store", () => ({ useMailStore: () => store }));

vi.mock("@/lib/prefs", () => ({
  usePrefs: () => ({ signatures: [], llm: prefs.llm, aiReplyEnabled: prefs.aiReplyEnabled }),
  activeSignature: () => null,
}));

const { ComposeScreen } = await import("@/screens/compose-screen");

const response = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

const FIL = {
  id: "t1",
  messages: [
    {
      id: "m1",
      threadId: "t1",
      name: "Alice",
      email: "alice@example.com",
      body: ["Peux-tu confirmer le devis ?"],
      timestamp: 1_000,
    },
    {
      id: "m2",
      threadId: "t1",
      name: "Roman",
      email: "roman@lavande.mail",
      body: ["Je vérifie et je te réponds."],
      timestamp: 2_000,
    },
  ],
};

function Harness() {
  const [draft, setDraft] = useState<ComposeDraft>({
    ...baseDraft("perso", false, false, "t1"),
    to: "alice@example.com",
    subject: "Re: Devis",
    body: "<p>Merci pour ton message.</p>",
  });
  return <ComposeScreen draft={draft} onDraftChange={setDraft} onClose={() => {}} />;
}

async function generate(brief: string) {
  fireEvent.click(screen.getByLabelText("Suggestion de réponse"));
  fireEvent.change(screen.getByLabelText("Ta consigne"), { target: { value: brief } });
  fireEvent.click(screen.getByText("Générer la réponse"));
}

beforeEach(() => {
  vi.unstubAllGlobals();
  prefs.aiReplyEnabled = true;
  store.mails = FIL.messages;
  store.openThread = FIL;
});

describe("suggestion de réponse · IA", () => {
  it("envoie toute la conversation du fil et badgé la réponse IA", async () => {
    const fetchMock = vi.fn(async () => response({ choices: [{ message: { content: "C'est confirmé." } }] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);

    await generate("confirme le devis");

    expect(await screen.findByText("IA")).toBeTruthy();
    expect(screen.getByText("C'est confirmé.")).toBeTruthy();

    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    const user = JSON.parse(String(init.body)).messages[1].content as string;
    expect(user).toContain("<<<CONVERSATION>>>");
    expect(user).toContain("<<<FIN_CONVERSATION>>>");
    expect(user).toContain("Peux-tu confirmer le devis ?");
    expect(user).toContain("Je vérifie et je te réponds.");
    expect(user).toContain("Consigne pour la réponse : confirme le devis");
  });

  it("replie sur les suggestions locales quand le réglage est désactivé", async () => {
    prefs.aiReplyEnabled = false;
    const fetchMock = vi.fn(async () => response({ choices: [{ message: { content: "IA" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);

    await generate("confirme le devis");

    expect(await screen.findByText("Sur mesure")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("C'est confirmé.")).toBeNull());
  });
});
