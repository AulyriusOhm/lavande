import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PrefsProvider } from "@/lib/prefs";
import { PlanningProvider } from "@/lib/planning-store";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { MAILS } from "@/lib/mail";
import type { Mail } from "@/lib/mail";
import { createMemoryStorage } from "@/lib/sync/storage";
import { DesktopCompose } from "@/desktop/compose";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const CAMILLE = MAILS.find((mail) => mail.id === "1c")! as Mail;

function Probe() {
  const { composeDraft } = useMailStore();
  return <span data-testid="target">{composeDraft?.replyTargetId ?? "aucune"}</span>;
}

let replyToStore: (mail: Mail) => void = () => {};

function ReplyTrigger() {
  const { replyTo } = useMailStore();
  replyToStore = (mail) => replyTo(mail);
  return null;
}

function mount() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <PlanningProvider storage={createMemoryStorage()}>
        <MailStoreProvider>{children}</MailStoreProvider>
      </PlanningProvider>
    </PrefsProvider>
  );
  render(
    <>
      <DesktopCompose />
      <Probe />
      <ReplyTrigger />
    </>,
    { wrapper },
  );
}

const recipientField = () => screen.getByLabelText("À") as HTMLInputElement;

beforeEach(() => {
  window.localStorage.clear();
  mount();
});

describe("composition ancrée · réorienter la réponse", () => {
  it("vise le message choisi dans la conversation, corps conservé", async () => {
    act(() => replyToStore(CAMILLE));
    expect(await screen.findByTestId("desktop-compose")).toBeTruthy();
    expect(screen.getByTestId("target").textContent).toBe("1c");

    expect(await screen.findByTestId("conversation-messages")).toBeTruthy();
    fireEvent.click(await screen.findByLabelText("Déplier le message de Marc Delaunay"));
    fireEvent.click(await screen.findByLabelText("Répondre à ce message · Marc Delaunay"));

    await waitFor(() => expect(screen.getByTestId("target").textContent).toBe("1d"));
    expect(recipientField().value).toBe("marc.delaunay@mail.fr");
    expect(screen.queryByText(/Abandonner le brouillon/)).toBeNull();
  });
});
