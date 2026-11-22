import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { ComposeDraft } from "@/lib/draft";
import { baseDraft } from "@/lib/draft";

const storeMock = vi.hoisted(() => ({
  mode: "api" as "api" | "demo",
  accounts: [] as { id: string; label: string; email: string; oauth?: boolean }[],
  account: "pro",
}));

vi.mock("@/lib/store", () => ({
  useMailStore: () => ({
    mailAccounts: storeMock.accounts,
    mails: [],
    mode: storeMock.mode,
    accounts: storeMock.accounts,
    account: storeMock.account,
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

function Harness() {
  const [draft, setDraft] = useState<ComposeDraft>({
    ...baseDraft("pro", false, false),
    to: "",
    cc: "",
    cci: "",
    subject: "",
    body: "",
  });
  return (
    <ComposeScreen
      draft={draft}
      onDraftChange={setDraft}
      onClose={() => {}}
    />
  );
}

const reply = (body: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    statusText: "",
    json: async () => body,
  }) as unknown as Response;

const options = () => {
  const list = screen.queryByRole("listbox");
  return list ? within(list).queryAllByRole("option") : [];
};

const galCalls = new Map<string, number>();

function stubDaemon(options: { gal?: unknown[]; galStatus?: number; contacts?: unknown[] } = {}) {
  galCalls.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const { pathname, searchParams } = new URL(String(input), "http://localhost");
      if (pathname.endsWith("/api/contacts")) {
        return reply(
          options.contacts ?? [
            { email: "camille@exemple.tld", name: "Camille Roux", received: 5, sent: 1, last_seen: null },
          ],
        );
      }
      if (pathname.includes("/zimbra/gal")) {
        galCalls.set(searchParams.get("q") ?? "", Number(searchParams.get("limit") ?? 0));
        if ((options.galStatus ?? 200) >= 400) {
          return reply({ error: "serveur Zimbra injoignable", kind: "soap" }, options.galStatus);
        }
        return reply(options.gal ?? []);
      }
      return reply({});
    }),
  );
}

const GAL = [
  { email: "camille@exemple.tld", name: "Camille ROUX", kind: "contact" },
  { email: "support@exemple.tld", name: "Équipe support", kind: "group" },
];

beforeEach(() => {
  storeMock.mode = "api";
  storeMock.account = "pro";
  storeMock.accounts = [
    { id: "pro", label: "Pro", email: "roman@exemple.tld" },
    { id: "gmail", label: "Google", email: "roman@gmail.com", oauth: true },
  ];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("compose · annuaire d'entreprise dans les suggestions", () => {
  it("fusionne le carnet local et l'annuaire, le local d'abord et sans doublon", async () => {
    stubDaemon({ gal: GAL });
    render(<Harness />);

    fireEvent.change(document.getElementById("compose-to") as HTMLInputElement, {
      target: { value: "a" },
    });

    await waitFor(() => expect(options().length).toBe(2));
    expect(options()[0].textContent).toContain("Camille Roux");
    expect(options()[0].textContent).toContain("camille@exemple.tld");
    expect(options()[1].textContent).toContain("Équipe support");
    expect(options()[1].textContent).toContain("liste");
    expect(galCalls.get("a")).toBe(6);
  });

  it("garde les suggestions locales quand l'annuaire ne répond pas", async () => {
    stubDaemon({ galStatus: 502 });
    render(<Harness />);

    fireEvent.change(document.getElementById("compose-to") as HTMLInputElement, {
      target: { value: "cam" },
    });

    await waitFor(() => expect(options().length).toBe(1));
    expect(options()[0].textContent).toContain("Camille Roux");
    expect(screen.queryByText(/Zimbra|annuaire/i)).toBeNull();
  });

  it("n'interroge aucun annuaire sans compte à mot de passe", async () => {
    storeMock.accounts = [{ id: "gmail", label: "Google", email: "roman@gmail.com", oauth: true }];
    storeMock.account = "gmail";
    stubDaemon({ gal: GAL });
    render(<Harness />);

    fireEvent.change(document.getElementById("compose-to") as HTMLInputElement, {
      target: { value: "a" },
    });

    await waitFor(() => expect(options().length).toBe(1));
    expect(galCalls.size).toBe(0);
  });
});
