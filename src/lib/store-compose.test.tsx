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

describe("citation séparée d'un mail texte contenant une URL entre chevrons", () => {
  const QUOTED_BODY = [
    "Bonjour,",
    "Merci de votre retour, voici le suivi :",
    "<https://bbfhigcd.r.af.d.sendibt2.com/tr/cl/abc123>",
    "Je vais relancer.",
  ];

  const targetMail = (result: ReturnType<typeof mount>["result"]) => ({
    ...result.current.mails.find((mail) => mail.folder === "inbox")!,
    body: QUOTED_BODY,
  });

  it("répondre laisse le corps éditable vide et range l'historique dans le bloc cité", () => {
    const { result } = mount();
    const target = targetMail(result);
    act(() => {
      result.current.replyTo(target);
    });

    const draft = result.current.composeDraft!;
    expect(draft.body).toBe("");
    expect(draft.subject).toBe(`Re: ${target.subject}`);
    expect(draft.quoted).toBeDefined();
    expect(draft.quoted).toContain('<blockquote class="lavande-quote">');
    expect(draft.quoted).toContain(`Le ${target.date ?? target.time}, ${target.name} a écrit :`);
    expect(draft.quoted).toContain("&lt;https://bbfhigcd.r.af.d.sendibt2.com/tr/cl/abc123&gt;");
    expect(draft.quoted?.split("<br>").length).toBe(QUOTED_BODY.length);
    expect(draft.quoted).not.toContain("---");
    expect(draft.quoted).not.toContain("&gt; ");
  });

  it("transférer range l'en-tête et le corps transférés dans le bloc cité", () => {
    const { result } = mount();
    const target = targetMail(result);
    act(() => {
      result.current.forwardMail(target);
    });

    const draft = result.current.composeDraft!;
    expect(draft.body).toBe("");
    expect(draft.subject).toBe(`Tr: ${target.subject}`);
    expect(draft.quoted).toContain('<blockquote class="lavande-quote">');
    expect(draft.quoted).toContain("Message transféré");
    expect(draft.quoted).toContain(`De : ${target.name} &lt;${target.email}&gt;`);
    expect(draft.quoted).toContain("Objet : ");
    expect(draft.quoted).toContain("&lt;https://bbfhigcd.r.af.d.sendibt2.com/tr/cl/abc123&gt;");
    expect(draft.quoted).not.toContain("--- Message transféré ---");
  });

  it("garde le sujet déjà préfixé sans le doubler", () => {
    const base = mount();
    const inbox = base.result.current.mails.find((mail) => mail.folder === "inbox")!;
    act(() => {
      base.result.current.replyTo({ ...inbox, subject: "Re: Déjà répondu" });
    });
    expect(base.result.current.composeDraft?.subject).toBe("Re: Déjà répondu");
    base.unmount();
    window.localStorage.clear();


    const forwarded = mount();
    const forwardedInbox = forwarded.result.current.mails.find((mail) => mail.folder === "inbox")!;
    act(() => {
      forwarded.result.current.forwardMail({ ...forwardedInbox, subject: "Tr: Déjà transféré" });
    });
    expect(forwarded.result.current.composeDraft?.subject).toBe("Tr: Déjà transféré");
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

describe("PGP du compte à la composition", () => {
  const setPgp = (pgpAccounts: Record<string, unknown>) =>
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ pgpEncrypt: true, pgpSign: true, pgpAccounts }),
    );

  it("un nouveau brouillon suit le PGP de son compte, pas le global", () => {
    setPgp({ perso: { encrypt: false, sign: true } });
    const { result } = mount();

    act(() => result.current.startBlankDraft());

    expect(result.current.composeDraft?.account).toBe("perso");
    expect(result.current.composeDraft?.pgpEncrypt).toBe(false);
    expect(result.current.composeDraft?.pgpSign).toBe(true);
  });

  it("répondre suit le compte du message d'origine", () => {
    setPgp({ pro: { enabled: false } });
    const { result } = mount();
    const target = MAILS.find((mail) => mail.account === "pro")!;

    act(() => result.current.replyTo(target));

    expect(result.current.composeDraft?.account).toBe("pro");
    expect(result.current.composeDraft?.pgpEncrypt).toBe(false);
    expect(result.current.composeDraft?.pgpSign).toBe(false);
  });

  it("transférer suit le compte du message d'origine", () => {
    setPgp({ perso: { sign: false } });
    const { result } = mount();
    const target = MAILS.find((mail) => mail.account === "perso")!;

    act(() => result.current.forwardMail(target));

    expect(result.current.composeDraft?.pgpEncrypt).toBe(true);
    expect(result.current.composeDraft?.pgpSign).toBe(false);
  });

  it("sans réglage de compte, les défauts globaux restent la référence", () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ pgpEncrypt: false, pgpSign: true }));
    const { result } = mount();

    act(() => result.current.startBlankDraft());

    expect(result.current.composeDraft?.pgpEncrypt).toBe(false);
    expect(result.current.composeDraft?.pgpSign).toBe(true);
  });
});
