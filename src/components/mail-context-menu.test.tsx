import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MailContextMenu } from "@/components/mail-context-menu";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { createMemoryStorage } from "@/lib/sync/storage";
import { MAILS } from "@/lib/mail";
import type { Mail } from "@/lib/mail";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const CAMILLE = MAILS.find((mail) => mail.id === "1")!;
const MARC = MAILS.find((mail) => mail.id === "1d")!;
const SENT = MAILS.find((mail) => mail.id === "1b")!;
const SPAM = MAILS.find((mail) => mail.id === "9")!;
const DRAFT = MAILS.find((mail) => mail.id === "d1")!;
const ARCHIVE = MAILS.find((mail) => mail.id === "11")!;
const TRASH: Mail = { ...CAMILLE, folder: "trash", previousFolder: "inbox" };
const OTHER: Mail = { ...CAMILLE, folder: "other" };

function Probe({ id }: { id: string }) {
  const { mails } = useMailStore();
  return <span data-testid="starred">{String(mails.find((mail) => mail.id === id)?.starred)}</span>;
}

function mount(mail: Mail, onClose = () => {}) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <PrefsProvider>
      <PlanningProvider storage={createMemoryStorage()}>
        <MailStoreProvider>{children}</MailStoreProvider>
      </PlanningProvider>
    </PrefsProvider>
  );
  render(
    <>
      <MailContextMenu mail={mail} ancre={{ x: 40, y: 40 }} onClose={onClose} />
      <Probe id={mail.id} />
    </>,
    { wrapper },
  );
}

const labels = () =>
  within(screen.getByRole("menu"))
    .getAllByRole("menuitem")
    .map((item) => item.textContent);

const click = (name: string) =>
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name }));

beforeEach(() => {
  window.localStorage.clear();
});

describe("actions du menu contextuel selon le dossier", () => {
  it("liste les actions d'un message reçu, dans l'ordre", () => {
    mount(CAMILLE);

    expect(labels()).toEqual([
      "Ouvrir",
      "Répondre",
      "Répondre à tous",
      "Transférer",
      "Marquer lu",
      "Retirer l'étoile",
      "Archiver",
      "Mettre à la corbeille",
    ]);
  });

  it("propose « Répondre à tous » seulement avec un autre destinataire", () => {
    mount(MARC);

    expect(labels()).not.toContain("Répondre à tous");
    expect(labels()).toContain("Répondre");
  });

  it("ne propose pas « Répondre à tous » depuis un message envoyé", () => {
    mount(SENT);

    expect(labels()).not.toContain("Répondre à tous");
  });

  it("corbeille : restaurer et supprimer définitivement, sans archiver", () => {
    mount(TRASH);

    expect(labels()).toContain("Restaurer");
    expect(labels()).toContain("Supprimer définitivement");
    expect(labels()).not.toContain("Archiver");
    expect(labels()).not.toContain("Mettre à la corbeille");
    expect(labels()).not.toContain("Déplacer vers la réception");
  });

  it("spam : non spam, sans restaurer", () => {
    mount(SPAM);

    expect(labels()).toContain("Non spam");
    expect(labels()).not.toContain("Restaurer");
  });

  it("brouillon : reprendre à la place de répondre", () => {
    mount(DRAFT);

    expect(labels()).toContain("Reprendre le brouillon");
    expect(labels()).not.toContain("Répondre");
    expect(labels()).not.toContain("Répondre à tous");
  });

  it("archives et dossiers : déplacer vers la réception, sans archiver", () => {
    mount(ARCHIVE);
    expect(labels()).toContain("Déplacer vers la réception");
    expect(labels()).not.toContain("Archiver");
  });

  it("dossier libre : déplacer vers la réception", () => {
    mount(OTHER);

    expect(labels()).toContain("Déplacer vers la réception");
  });
});

describe("exécution d'une action", () => {
  it("étoile le message puis referme le panneau", () => {
    const onClose = vi.fn();
    mount(CAMILLE, onClose);
    expect(screen.getByTestId("starred").textContent).toBe("true");

    click("Retirer l'étoile");

    expect(screen.getByTestId("starred").textContent).toBe("false");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("se ferme sur Échap", () => {
    const onClose = vi.fn();
    mount(CAMILLE, onClose);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
