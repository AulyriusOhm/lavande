import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { PlanningProvider } from "@/lib/planning-store";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { PrefsProvider } from "@/lib/prefs";
import { MAILS } from "@/lib/mail";
import { ALL_ACCOUNTS } from "@/lib/accounts";
import { createMemoryStorage } from "@/lib/sync/storage";
import { emptyDraft } from "@/lib/draft";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

function mount() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <PlanningProvider storage={createMemoryStorage()}>
        <MailStoreProvider>{children}</MailStoreProvider>
      </PlanningProvider>
    </PrefsProvider>
  );
  return renderHook(() => useMailStore(), { wrapper });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("compteurs par dossier (démo)", () => {
  it("compte les non-lus de chaque dossier, pas seulement le dossier courant", () => {
    const { result } = mount();
    const spamUnread = MAILS.filter((mail) => mail.folder === "spam" && mail.unread).length;
    const inboxUnread = MAILS.filter((mail) => mail.folder === "inbox" && mail.unread).length;

    expect(result.current.folder).toBe("inbox");
    expect(result.current.folderStats("spam").unread).toBe(spamUnread);
    expect(result.current.folderStats("inbox").unread).toBe(inboxUnread);
    expect(result.current.folderStats("trash").total).toBe(
      MAILS.filter((mail) => mail.folder === "trash").length,
    );
    expect(result.current.accountUnread(ALL_ACCOUNTS)).toBe(inboxUnread);
  });

  it("suit les actions : archiver un mail non lu diminue le compteur du dossier source", () => {
    const { result } = mount();
    const mail = result.current.mails.find((entry) => entry.folder === "inbox" && entry.unread);
    expect(mail).toBeDefined();
    const before = result.current.folderStats("inbox").unread;

    act(() => {
      result.current.mailAction("archive", mail!);
    });

    expect(result.current.folderStats("inbox").unread).toBe(before - 1);
    expect(result.current.folderStats("archive").total).toBe(
      MAILS.filter((entry) => entry.folder === "archive").length + 1,
    );
  });
});

describe("brouillon persisté", () => {
  it("restaure le brouillon après un rechargement", () => {
    const first = mount();
    act(() => {
      first.result.current.startBlankDraft();
    });
    act(() => {
      first.result.current.setComposeDraft({
        ...first.result.current.composeDraft!,
        subject: "Brouillon important",
      });
    });
    first.unmount();

    const second = mount();
    expect(second.result.current.composeDraft?.subject).toBe("Brouillon important");
    expect(second.result.current.composeOpen).toBe(false);
  });

  it("efface le brouillon persisté à la fermeture", () => {
    const { result } = mount();
    act(() => {
      result.current.startBlankDraft();
    });
    act(() => {
      result.current.closeCompose();
    });
    expect(result.current.composeDraft).toBeNull();
    expect(window.localStorage.getItem("lavande.compose.v1")).toBeNull();
  });
});

describe("garde du brouillon en cours", () => {
  it("répondre avec un brouillon non vide demande confirmation avant d'écraser", () => {
    const { result } = mount();
    act(() => {
      result.current.startBlankDraft();
    });
    act(() => {
      result.current.setComposeDraft({ ...result.current.composeDraft!, body: "Texte en cours" });
    });
    const target = result.current.mails[0];

    act(() => {
      result.current.replyTo(target);
    });
    expect(result.current.composeDraft?.body).toBe("Texte en cours");
    expect(result.current.notices[0]?.message).toContain("Abandonner");

    act(() => {
      result.current.notices[0].onAction?.();
    });
    expect(result.current.composeDraft?.subject).toContain("Re:");
  });

  it("répondre sans brouillon ouvre directement la réponse", () => {
    const { result } = mount();
    const target = result.current.mails.find((mail) => mail.folder === "inbox")!;
    act(() => {
      result.current.replyTo(target);
    });
    expect(result.current.composeOpen).toBe(true);
    expect(result.current.composeDraft?.to).toBe(target.email);
    expect(emptyDraft(result.current.composeDraft!)).toBe(false);
  });
});

describe("recherche globale (démo)", () => {
  it("cherche dans tous les dossiers, pas seulement le dossier courant", async () => {
    const { result } = mount();
    const sent = MAILS.find((mail) => mail.folder === "sent")!;
    const needle = sent.subject.split(" ")[0];

    let found: Awaited<ReturnType<typeof result.current.searchMails>> = [];
    await act(async () => {
      found = await result.current.searchMails(needle);
    });

    expect(found.some((mail) => mail.id === sent.id)).toBe(true);
    expect(found.length).toBeGreaterThan(0);
  });
});
