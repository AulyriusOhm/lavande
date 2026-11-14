import type { ReactNode } from "react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { baseDraft, type ComposeDraft } from "@/lib/draft";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider } from "@/lib/store";
import { createMemoryStorage } from "@/lib/sync/storage";
import { ComposeScreen } from "@/screens/compose-screen";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

function Harness() {
  const [draft, setDraft] = useState<ComposeDraft>(() => baseDraft("perso", false, false));
  return <ComposeScreen draft={draft} onDraftChange={setDraft} onClose={() => {}} />;
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <PrefsProvider>
    <PlanningProvider storage={createMemoryStorage()}>
      <MailStoreProvider>{children}</MailStoreProvider>
    </PlanningProvider>
  </PrefsProvider>
);

const fromOptions = () =>
  Array.from((screen.getByLabelText("De") as HTMLSelectElement).options).map((option) => option.value);

beforeEach(() => {
  window.localStorage.clear();
});

describe("composition · sélecteur De et périmètre mails", () => {
  it("offre tous les comptes par défaut", async () => {
    render(<Harness />, { wrapper });

    await waitFor(() => expect(fromOptions().length).toBeGreaterThan(1));

    expect(fromOptions()).toEqual(["perso", "pro", "gmail"]);
  });

  it("n'offre pas un compte hors périmètre mails", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ perimeters: { pro: { mails: false } } }));
    render(<Harness />, { wrapper });

    await waitFor(() => expect(fromOptions().length).toBeGreaterThan(1));

    expect(fromOptions()).toEqual(["perso", "gmail"]);
  });
});
