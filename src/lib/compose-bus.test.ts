import { describe, expect, it, vi } from "vitest";
import {
  composeWindowUrl,
  isComposeWindow,
  loadPersistedCompose,
  persistCompose,
} from "@/lib/compose-bus";
import { baseDraft } from "@/lib/draft";

describe("compose-bus", () => {
  it("persiste et relit un brouillon", () => {
    window.localStorage.clear();
    const draft = { ...baseDraft("perso", true, false), subject: "Essai" };
    persistCompose(draft, "Répondre");
    expect(loadPersistedCompose()).toEqual({ draft, title: "Répondre" });
  });

  it("supprime le brouillon persisté quand il est fermé", () => {
    window.localStorage.clear();
    persistCompose(baseDraft("perso", true, true), "Nouveau message");
    persistCompose(null, "Nouveau message");
    expect(loadPersistedCompose()).toBeNull();
  });

  it("ignore un stockage corrompu ou incomplet", () => {
    window.localStorage.clear();
    window.localStorage.setItem("lavande.compose.v1", "{pas du json");
    expect(loadPersistedCompose()).toBeNull();
    window.localStorage.setItem("lavande.compose.v1", JSON.stringify({ draft: { to: 3 } }));
    expect(loadPersistedCompose()).toBeNull();
  });

  it("détecte la fenêtre de composition par le hash", () => {
    window.location.hash = "";
    expect(isComposeWindow()).toBe(false);
    window.location.hash = "#compose";
    expect(isComposeWindow()).toBe(true);
    window.location.hash = "";
  });

  it("construit l'url de la fenêtre détachée", () => {
    expect(composeWindowUrl()).toBe(`${window.location.origin}${window.location.pathname}?desktop#compose`);
  });
});

describe("openComposeBus", () => {
  it("rend null sans BroadcastChannel", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const { openComposeBus } = await import("@/lib/compose-bus");
    expect(openComposeBus(() => {})).toBeNull();
    vi.unstubAllGlobals();
  });
});
