import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { baseDraft } from "@/lib/draft";
import { buildQuotedHtml, textToHtml } from "@/lib/rich-text";

const QUOTED = buildQuotedHtml("Le 9 novembre, Support a écrit :", textToHtml("Bonjour\nSuite du fil"));

const state = vi.hoisted(() => ({
  threadView: "tidy" as "tidy" | "inline",
  draft: null as unknown,
}));

vi.mock("@/lib/prefs", () => ({
  usePrefs: () => ({
    signatures: [],
    llm: { endpoint: "", apiKey: "", model: "" },
    threadView: state.threadView,
  }),
  activeSignature: () => null,
}));

vi.mock("@/lib/store", () => ({
  useMailStore: () => ({
    mailAccounts: [{ id: "perso", label: "Perso", email: "roman@lavande.mail" }],
    mails: [],
    openThread: undefined,
    saveToDrafts: async () => true,
    mode: "demo",
    folderRecords: [],
    composeOpen: true,
    composeDraft: state.draft,
    composeTitle: "Nouveau message",
    composeDetached: false,
    composeSending: false,
    composeSendError: null,
    setComposeDraft: () => {},
    sendDraft: () => {},
    resumeCompose: () => {},
    minimizeCompose: () => {},
    closeCompose: () => {},
    detachCompose: () => {},
    dockCompose: () => {},
    detachClosed: () => {},
    notify: () => {},
  }),
}));

const { DesktopCompose } = await import("@/desktop/compose");

beforeEach(() => {
  window.localStorage.clear();
  state.threadView = "tidy";
  state.draft = { ...baseDraft("perso", false, false, "t-maquettes"), quoted: QUOTED };
});

describe("composition PC · conversation", () => {
  it("range le fil dans le panneau repliable en mode bien rangé", async () => {
    render(<DesktopCompose />);

    expect(await screen.findByTestId("conversation-panel")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Voir la conversation · 4 messages" })).toBeTruthy();
    expect(screen.queryByTestId("compose-quoted-block")).toBeNull();
  });

  it("affiche la citation classique en mode « tout dans le même mail »", () => {
    state.threadView = "inline";
    render(<DesktopCompose />);

    expect(screen.queryByTestId("conversation-panel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Voir la conversation précédente" }));
    expect(screen.getByTestId("compose-quoted").textContent).toContain("Suite du fil");
  });
});
