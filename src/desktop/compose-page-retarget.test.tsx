import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PrefsProvider } from "@/lib/prefs";
import { PlanningProvider } from "@/lib/planning-store";
import { MailStoreProvider } from "@/lib/store";
import { baseDraft } from "@/lib/draft";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const { DesktopComposePage } = await import("@/desktop/compose-page");

const STORAGE_KEY = "lavande.compose.v1";

function seedDraft() {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      draft: {
        ...baseDraft("perso", false, false, "t-maquettes"),
        subject: "Re: Maquettes mobiles — version 3",
        body: "<p>Texte en cours</p>",
      },
      title: "Répondre",
    }),
  );
}

function mount() {
  render(
    <PrefsProvider>
      <PlanningProvider storage={createMemoryStorage()}>
        <MailStoreProvider>
          <DesktopComposePage />
        </MailStoreProvider>
      </PlanningProvider>
    </PrefsProvider>,
  );
}

const recipientField = () => screen.getByLabelText("À") as HTMLInputElement;

beforeEach(() => {
  window.localStorage.clear();
  seedDraft();
  mount();
});

describe("composition détachée · réorienter la réponse", () => {
  it("réoriente le brouillon vivant dans la fenêtre détachée, corps conservé", async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Voir la conversation · 4 messages" }));
    fireEvent.click(await screen.findByLabelText("Déplier le message de Marc Delaunay"));
    fireEvent.click(await screen.findByLabelText("Répondre à ce message · Marc Delaunay"));

    await waitFor(() => expect(recipientField().value).toBe("marc.delaunay@mail.fr"));
    expect(document.body.textContent).toContain("Texte en cours");
  });

  it("signale la nouvelle cible dans la conversation", async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Voir la conversation · 4 messages" }));
    fireEvent.click(await screen.findByLabelText("Déplier le message de Marc Delaunay"));
    fireEvent.click(await screen.findByLabelText("Répondre à ce message · Marc Delaunay"));

    await waitFor(() => {
      const current = document.querySelector('[data-testid="conversation-message"][data-current]');
      expect(current?.textContent).toContain("Marc Delaunay");
    });
  });
});
