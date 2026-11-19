import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { PlanningProvider } from "@/lib/planning-store";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { PrefsProvider } from "@/lib/prefs";
import { MAILS } from "@/lib/mail";
import type { Mail } from "@/lib/mail";
import { canReplyAll } from "@/lib/mail";
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

const MARC: Mail = {
  ...MAILS.find((mail) => mail.id === "1d")!,
  email: "marc@delaunay.fr",
  name: "Marc Delaunay",
  messageId: "<marc-1@delaunay.fr>",
  references: [],
};

const SENT: Mail = {
  ...MAILS.find((mail) => mail.id === "1b")!,
  messageId: "<roman-1@lavande.mail>",
  references: ["<camille-1@studio-lilas.fr>"],
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("répondre à un message précis", () => {
  it("vise ce message, pas le dernier du fil", () => {
    const { result } = mount();

    act(() => {
      result.current.replyTo(MARC);
    });

    const draft = result.current.composeDraft!;
    expect(draft.replyTargetId).toBe(MARC.id);
    expect(draft.to).toBe(MARC.email);
    expect(draft.inReplyTo).toBe("<marc-1@delaunay.fr>");
    expect(draft.references).toEqual(["<marc-1@delaunay.fr>"]);
    expect(draft.quoted).toContain("a écrit");
    expect(draft.quoted).toContain(MARC.body[0].slice(0, 20));
  });

  it("répond à un message envoyé en écrivant à ses destinataires", () => {
    const { result } = mount();

    act(() => {
      result.current.replyTo(SENT);
    });

    const draft = result.current.composeDraft!;
    expect(draft.to).toBe("camille@studio-lilas.fr");
    expect(draft.to).not.toContain("roman@lavande.mail");
    expect(draft.cc).toBe("");
    expect(result.current.composeTitle).toBe("Répondre");
  });

  it("répond à tous depuis un message envoyé avec ses À et son Cc", () => {
    const { result } = mount();

    act(() => {
      result.current.replyTo(SENT, true);
    });

    const draft = result.current.composeDraft!;
    expect(draft.to).toBe("camille@studio-lilas.fr");
    expect(draft.cc).toBe("marc.delaunay@mail.fr");
    expect(result.current.composeTitle).toBe("Répondre à tous");
  });
});

describe("changer la cible du brouillon courant", () => {
  it("garde le corps saisi et réécrit les en-têtes du message visé", () => {
    const { result } = mount();
    act(() => {
      result.current.startBlankDraft();
    });
    act(() => {
      result.current.setComposeDraft({
        ...result.current.composeDraft!,
        body: "<p>Texte en cours</p>",
        cc: "copie@test.fr",
      });
    });

    act(() => {
      result.current.setReplyTarget(MARC);
    });

    const draft = result.current.composeDraft!;
    expect(draft.body).toBe("<p>Texte en cours</p>");
    expect(draft.to).toBe(MARC.email);
    expect(draft.cc).toBe("");
    expect(draft.subject).toBe(`Re: ${MARC.subject}`);
    expect(draft.replyTargetId).toBe(MARC.id);
    expect(draft.inReplyTo).toBe("<marc-1@delaunay.fr>");
    expect(draft.threadId).toBe(MARC.threadId);
    expect(draft.quoted).toContain("a écrit");
    expect(result.current.composeTitle).toBe("Répondre");
    expect(result.current.notices).toHaveLength(0);
  });

  it("garde le compte du brouillon courant", () => {
    const { result } = mount();
    act(() => {
      result.current.startBlankDraft();
    });
    const account = result.current.composeDraft!.account;

    act(() => {
      result.current.setReplyTarget(CAMILLE);
    });

    expect(result.current.composeDraft!.account).toBe(account);
  });

  it("réoriente vers « à tous » en reprenant le Cc du message visé", () => {
    const { result } = mount();
    act(() => {
      result.current.startBlankDraft();
    });

    act(() => {
      result.current.setReplyTarget(CAMILLE, true);
    });

    const draft = result.current.composeDraft!;
    expect(draft.cc).toBe("marc.delaunay@mail.fr");
    expect(result.current.composeTitle).toBe("Répondre à tous");
  });

  it("se comporte comme Répondre sans brouillon ouvert", () => {
    const { result } = mount();

    act(() => {
      result.current.setReplyTarget(MARC);
    });

    const draft = result.current.composeDraft!;
    expect(draft.to).toBe(MARC.email);
    expect(draft.replyTargetId).toBe(MARC.id);
    expect(result.current.composeTitle).toBe("Répondre");
  });
});

describe("règle partagée « répondre à tous »", () => {
  it("suit les autres destinataires, y compris sur un message envoyé", () => {
    expect(canReplyAll(CAMILLE, "roman@lavande.mail")).toBe(true);
    expect(canReplyAll(SENT, "roman@lavande.mail")).toBe(true);
    expect(canReplyAll({ ...SENT, to: "roman@lavande.mail", cc: "" }, "roman@lavande.mail")).toBe(
      false,
    );
    expect(canReplyAll({ ...CAMILLE, folder: "drafts" }, "roman@lavande.mail")).toBe(false);
  });
});
