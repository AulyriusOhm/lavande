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

const CAMILLE = MAILS.find((mail) => mail.id === "1")! as Mail;
const CLOSE_DIALOG = "Enregistrer ou supprimer le brouillon";

function Probe() {
  const { composeOpen, composeDraft } = useMailStore();
  return (
    <span data-testid="probe">{`${composeOpen ? "open" : "closed"}:${composeDraft ? "draft" : "none"}`}</span>
  );
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

const probe = () => screen.getByTestId("probe").textContent;
const openReply = () => act(() => replyToStore(CAMILLE));
const dialog = () => screen.queryByRole("alertdialog", { name: CLOSE_DIALOG });
const dialogButton = (label: string) =>
  Array.from(screen.getByRole("alertdialog", { name: CLOSE_DIALOG }).querySelectorAll("button")).find(
    (button) => button.textContent === label,
  )!;

async function openReplyAndClickClose() {
  openReply();
  expect(await screen.findByTestId("desktop-compose")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Fermer"));
  return screen.findByRole("alertdialog", { name: CLOSE_DIALOG });
}

beforeEach(() => {
  window.localStorage.clear();
  mount();
});

describe("composition PC · la croix de l'en-tête ferme ou demande un choix visible", () => {
  it("affiche la confirmation en surimpression centrée de la fenêtre de composition", async () => {
    const confirm = await openReplyAndClickClose();

    const fenetre = screen.getByTestId("desktop-compose");
    expect(fenetre.contains(confirm)).toBe(true);
    expect(fenetre.querySelector("[data-testid='compose-close-backdrop']")).toBeTruthy();
    expect(confirm.getAttribute("aria-modal")).toBe("true");
    expect(confirm.textContent).toContain("Enregistrer ce message avant de fermer ?");
    expect(probe()).toBe("open:draft");
  });

  it("« Supprimer » ferme la fenêtre et jette le brouillon", async () => {
    await openReplyAndClickClose();

    fireEvent.click(dialogButton("Supprimer"));

    await waitFor(() => expect(probe()).toBe("closed:none"));
    await waitFor(() => expect(screen.queryByTestId("desktop-compose")).toBeNull());
  });

  it("« Brouillons » enregistre puis ferme", async () => {
    await openReplyAndClickClose();

    fireEvent.click(dialogButton("Brouillons"));

    await waitFor(() => expect(probe()).toBe("closed:none"));
  });

  it("« Annuler », le voile et Échap referment la confirmation sans fermer la fenêtre", async () => {
    await openReplyAndClickClose();
    fireEvent.click(dialogButton("Annuler"));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(probe()).toBe("open:draft");

    fireEvent.click(screen.getByLabelText("Fermer"));
    fireEvent.click(await screen.findByTestId("compose-close-backdrop"));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(probe()).toBe("open:draft");

    fireEvent.click(screen.getByLabelText("Fermer"));
    await screen.findByRole("alertdialog", { name: CLOSE_DIALOG });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(dialog()).toBeNull());
    expect(probe()).toBe("open:draft");
  });

  it("ne démarre pas de déplacement de fenêtre quand on presse la croix", async () => {
    openReply();
    const fenetre = await screen.findByTestId("desktop-compose");
    const left = fenetre.style.left;

    const croix = screen.getByLabelText("Fermer");
    fireEvent.pointerDown(croix.querySelector("svg")!, { button: 0, clientX: 40, clientY: 40 });
    fireEvent.pointerMove(window, { clientX: 260, clientY: 220 });
    fireEvent.pointerUp(window, { clientX: 260, clientY: 220 });
    fireEvent.click(croix);

    expect(await screen.findByRole("alertdialog", { name: CLOSE_DIALOG })).toBeTruthy();
    expect(screen.getByTestId("desktop-compose").style.left).toBe(left);
  });

  it("ne rouvre pas une confirmation périmée après réduction puis reprise", async () => {
    await openReplyAndClickClose();

    fireEvent.click(screen.getByLabelText("Réduire le brouillon"));
    await waitFor(() => expect(probe()).toBe("closed:draft"));
    fireEvent.click(await screen.findByLabelText("Reprendre le brouillon"));

    await waitFor(() => expect(probe()).toBe("open:draft"));
    expect(dialog()).toBeNull();
  });

  it("garde la fermeture immédiate de la pilule réduite", async () => {
    openReply();
    await screen.findByTestId("desktop-compose");
    fireEvent.click(screen.getByLabelText("Réduire le brouillon"));
    await waitFor(() => expect(probe()).toBe("closed:draft"));

    fireEvent.click(await screen.findByLabelText("Fermer le brouillon"));

    await waitFor(() => expect(probe()).toBe("closed:none"));
  });
});
