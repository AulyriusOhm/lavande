import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { PlanningProvider } from "@/lib/planning-store";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { PrefsProvider } from "@/lib/prefs";
import { MAILS } from "@/lib/mail";
import type { Mail } from "@/lib/mail";
import { createMemoryStorage } from "@/lib/sync/storage";

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

const CAMILLE: Mail = {
  ...MAILS.find((mail) => mail.id === "1")!,
  messageId: "<camille-1@studio-lilas.fr>",
  references: ["<parent@studio-lilas.fr>"],
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("répondre à tous", () => {
  it("met l'expéditeur et les destinataires en À, reprend le Cc d'origine", () => {
    const { result } = mount();

    act(() => {
      result.current.replyTo(CAMILLE, true);
    });

    const draft = result.current.composeDraft!;
    expect(draft.to).toBe("camille@studio-lilas.fr");
    expect(draft.cc).toBe("marc.delaunay@mail.fr");
    expect(result.current.composeTitle).toBe("Répondre à tous");
  });

  it("garde le sujet, les références et le fil de la réponse simple", () => {
    const { result } = mount();

    act(() => {
      result.current.replyTo(CAMILLE, true);
    });

    const draft = result.current.composeDraft!;
    expect(draft.subject).toBe("Re: Maquettes mobiles — version 3");
    expect(draft.inReplyTo).toBe("<camille-1@studio-lilas.fr>");
    expect(draft.references).toEqual([
      "<parent@studio-lilas.fr>",
      "<camille-1@studio-lilas.fr>",
    ]);
    expect(draft.threadId).toBe(CAMILLE.threadId);
    expect(draft.quoted).toContain('<blockquote class="lavande-quote">');
    expect(draft.body).toBe("");
  });

  it("retire l'adresse du compte sans tenir compte de la casse, et dédoublonne", () => {
    const { result } = mount();

    act(() => {
      result.current.replyTo(
        {
          ...CAMILLE,
          to: "ROMAN@LAVANDE.MAIL, Camille@Studio-Lilas.fr",
          cc: "Roman@Lavande.Mail",
        },
        true,
      );
    });

    const draft = result.current.composeDraft!;
    expect(draft.to).toBe("camille@studio-lilas.fr");
    expect(draft.cc).toBe("Roman@Lavande.Mail");
  });

  it("ne change rien à la réponse simple", () => {
    const { result } = mount();

    act(() => {
      result.current.replyTo(CAMILLE);
    });

    const draft = result.current.composeDraft!;
    expect(draft.to).toBe("camille@studio-lilas.fr");
    expect(draft.cc).toBe("");
    expect(draft.subject).toBe("Re: Maquettes mobiles — version 3");
    expect(draft.inReplyTo).toBe("<camille-1@studio-lilas.fr>");
    expect(result.current.composeTitle).toBe("Répondre");
  });

  it("demande confirmation avant d'écraser un brouillon en cours", () => {
    const { result } = mount();
    act(() => {
      result.current.startBlankDraft();
    });
    act(() => {
      result.current.setComposeDraft({ ...result.current.composeDraft!, body: "Texte en cours" });
    });

    act(() => {
      result.current.replyTo(CAMILLE, true);
    });
    expect(result.current.composeDraft?.body).toBe("Texte en cours");
    expect(result.current.notices[0]?.message).toContain("Abandonner");

    act(() => {
      result.current.notices[0].onAction?.();
    });
    expect(result.current.composeDraft?.to).toBe("camille@studio-lilas.fr");
    expect(result.current.composeDraft?.cc).toBe("marc.delaunay@mail.fr");
  });
});
