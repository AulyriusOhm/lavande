import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount, ApiMessage } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { createMemoryStorage } from "@/lib/sync/storage";
import { MAILS } from "@/lib/mail";
import type { Mail, MailSource } from "@/lib/mail";
import { loadPersistedCompose, persistCompose } from "@/lib/compose-bus";
import { baseDraft } from "@/lib/draft";

const apiAccount = (id: string): ApiAccount => ({
  id,
  label: id,
  email: `${id}@test.fr`,
  username: `${id}@test.fr`,
  imap: { host: "imap.test", port: 993, encryption: "tls" },
  smtp: { host: "smtp.test", port: 465, encryption: "tls" },
  folders: 0,
});

const reply = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as unknown as Response;

const blobReply = (blob: Blob) =>
  ({ ok: true, status: 200, statusText: "", blob: async () => blob }) as unknown as Response;

const failure = (error: string) =>
  ({
    ok: false,
    status: 500,
    statusText: "",
    json: async () => ({ error, kind: "imap" }),
  }) as unknown as Response;

const SOURCE: MailSource = { accountId: "perso", folderPath: "Drafts", uid: 42 };

const MESSAGE: ApiMessage = {
  account_id: "perso",
  folder_path: "Drafts",
  uid: 42,
  uidvalidity: 1,
  thread_id: "t-planning",
  message_id: "<brouillon@test.fr>",
  in_reply_to: "<parent@test.fr>",
  references: ["<parent@test.fr>"],
  from: { name: "Roman", email: "roman@test.fr" },
  to: [{ name: null, email: "marc@test.fr" }],
  cc: [{ name: null, email: "camille@test.fr" }],
  subject: "Planning phase 2",
  date: "2026-11-10T10:00:00Z",
  flags: { unread: false, starred: false, answered: false },
  size: 240,
  pgp: "none",
  preview: "Bonjour Marc",
  body_text: "Bonjour Marc",
  body_html: "<p>Bonjour Marc</p>",
  attachments: [
    { filename: "planning.pdf", mime: "application/pdf", size: 5, inline: false },
    { filename: "logo.png", mime: "image/png", size: 3, inline: true },
  ],
};

type Backend = {
  attachments: number[];
  deleted: unknown[];
  drafts: unknown[];
  sent: unknown[];
  messageFails: boolean;
  sendFails: boolean;
};

function mockBackend(message: ApiMessage = MESSAGE, sendGate?: Promise<void>): Backend {
  const calls: Backend = {
    attachments: [],
    deleted: [],
    drafts: [],
    sent: [],
    messageFails: false,
    sendFails: false,
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = decodeURIComponent(new URL(String(input), "http://localhost").pathname);
    const method = init?.method ?? "GET";
    if (path.endsWith("/api/accounts")) return reply([apiAccount("perso")]);
    if (/\/pgp$/.test(path)) return reply(apiAccount("perso"));
    if (/\/api\/accounts\/perso\/folders$/.test(path)) return reply([]);
    const attachment = /\/messages\/42\/attachments\/(\d+)$/.exec(path);
    if (attachment) {
      calls.attachments.push(Number(attachment[1]));
      return blobReply(new Blob(["hello"], { type: "application/pdf" }));
    }
    if (/\/messages\/42$/.test(path)) {
      return calls.messageFails ? failure("boîte IMAP injoignable") : reply(message);
    }
    if (/\/drafts$/.test(path) && method === "POST") {
      calls.drafts.push(JSON.parse(String(init?.body)));
      return reply({});
    }
    if (/\/send$/.test(path) && method === "POST") {
      calls.sent.push(JSON.parse(String(init?.body)));
      if (sendGate) await sendGate;
      return calls.sendFails ? failure("relais SMTP refusé") : reply({});
    }
    if (/\/delete$/.test(path) && method === "POST") {
      calls.deleted.push(JSON.parse(String(init?.body)));
      return reply({});
    }
    return reply([]);
  });
  return calls;
}

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

const draftMail = (source: MailSource): Mail => ({
  id: `${source.accountId}:${source.folderPath}:${source.uid}`,
  account: "perso",
  folder: "drafts",
  source,
  name: "Roman",
  email: "roman@test.fr",
  to: "marc@test.fr",
  subject: "Planning phase 2",
  preview: "Bonjour Marc",
  body: ["Bonjour Marc"],
  time: "10:00",
  unread: false,
  starred: false,
  pgp: "none",
  tone: 0,
});

const STORAGE_KEY = "lavande.compose.v1";

beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("reprise d'un brouillon (api)", () => {
  it("ramène destinataires, objet et corps dans l'éditeur, signature comprise", async () => {
    const backend = mockBackend();
    const { result } = mount();

    act(() => result.current.resumeDraft(draftMail(SOURCE)));

    await waitFor(() => expect(result.current.composeDraft).not.toBeNull());
    const draft = result.current.composeDraft!;
    expect(draft.to).toBe("marc@test.fr");
    expect(draft.cc).toBe("camille@test.fr");
    expect(draft.subject).toBe("Planning phase 2");
    expect(draft.body).toBe("<p>Bonjour Marc</p>");
    expect(draft.includeSignature).toBe(false);
    expect(draft.account).toBe("perso");
    expect(draft.inReplyTo).toBe("<parent@test.fr>");
    expect(draft.references).toEqual(["<parent@test.fr>"]);
    expect(draft.threadId).toBe("t-planning");
    expect(result.current.composeOpen).toBe(true);
    expect(result.current.composeTitle).toBe("Brouillon");
    expect(result.current.openMail).toBeNull();
    expect(result.current.notices.map((notice) => notice.message)).toContain("Brouillon repris");
    expect(backend.messageFails).toBe(false);
  });

  it("sépare l'historique cité du corps éditable", async () => {
    const quoted =
      '<blockquote class="lavande-quote"><p class="lavande-quote-head">Le 9 novembre, Support a écrit :</p><p>Bonjour</p></blockquote>';
    mockBackend({ ...MESSAGE, body_html: `<p>Ma réponse</p><br>${quoted}` });
    const { result } = mount();

    act(() => result.current.resumeDraft(draftMail(SOURCE)));

    await waitFor(() => expect(result.current.composeDraft).not.toBeNull());
    const draft = result.current.composeDraft!;
    expect(draft.body).toBe("<p>Ma réponse</p>");
    expect(draft.quoted).toBe(quoted);
    expect(draft.includeSignature).toBe(false);
  });

  it("récupère les pièces jointes non inline et ignore les images du corps", async () => {
    const backend = mockBackend();
    const { result } = mount();

    act(() => result.current.resumeDraft(draftMail(SOURCE)));

    await waitFor(() => expect(result.current.composeDraft?.attachments).toHaveLength(1));
    expect(result.current.composeDraft?.attachments?.[0]).toEqual({
      filename: "planning.pdf",
      mime: "application/pdf",
      data_base64: "aGVsbG8=",
      size: 5,
    });
    expect(backend.attachments).toEqual([0]);
  });

  it("ne supprime pas l'ancien brouillon au moment de la reprise", async () => {
    const backend = mockBackend();
    const { result } = mount();

    act(() => result.current.resumeDraft(draftMail(SOURCE)));

    await waitFor(() => expect(result.current.composeDraft).not.toBeNull());
    expect(backend.deleted).toEqual([]);
    expect(result.current.draftSource).toEqual(SOURCE);
  });

  it("annonce l'échec du chargement au lieu d'une reprise silencieuse", async () => {
    const backend = mockBackend();
    backend.messageFails = true;
    const { result } = mount();

    act(() => result.current.resumeDraft(draftMail(SOURCE)));

    await waitFor(() =>
      expect(result.current.notices.some((notice) => notice.message.startsWith("Brouillon non repris"))).toBe(
        true,
      ),
    );
    expect(result.current.composeDraft).toBeNull();
    expect(result.current.composeOpen).toBe(false);
  });

  it("demande confirmation avant d'écraser un brouillon en cours", async () => {
    mockBackend();
    const { result } = mount();
    act(() => result.current.startBlankDraft());
    act(() => result.current.setComposeDraft({ ...result.current.composeDraft!, body: "Texte en cours" }));

    act(() => result.current.resumeDraft(draftMail(SOURCE)));

    expect(result.current.composeDraft?.body).toBe("Texte en cours");
    expect(result.current.notices[0]?.message).toContain("Abandonner");

    act(() => result.current.notices[0].onAction?.());
    await waitFor(() => expect(result.current.composeDraft?.body).toBe("<p>Bonjour Marc</p>"));
  });
});

describe("ancien brouillon effacé après enregistrement ou envoi", () => {
  it("enregistrer la reprise supprime le brouillon serveur d'origine", async () => {
    const backend = mockBackend();
    const { result } = mount();
    act(() => result.current.resumeDraft(draftMail(SOURCE)));
    await waitFor(() => expect(result.current.composeDraft).not.toBeNull());

    let saved = false;
    await act(async () => {
      saved = await result.current.saveToDrafts(result.current.composeDraft!);
    });

    expect(saved).toBe(true);
    await waitFor(() => expect(backend.deleted).toEqual([{ folder_path: "Drafts", uid: 42 }]));
    expect(result.current.draftSource).toBeNull();
  });

  it("envoyer la reprise supprime le brouillon serveur d'origine", async () => {
    const backend = mockBackend();
    const { result } = mount();
    act(() => result.current.resumeDraft(draftMail(SOURCE)));
    await waitFor(() => expect(result.current.composeDraft).not.toBeNull());

    act(() => result.current.sendDraft(result.current.composeDraft!));

    await waitFor(() => expect(backend.deleted).toEqual([{ folder_path: "Drafts", uid: 42 }]));
    expect(backend.sent).toHaveLength(1);
    expect(result.current.draftSource).toBeNull();
    expect(result.current.composeDraft).toBeNull();
  });

  it("un brouillon écrit de zéro n'efface rien sur le serveur", async () => {
    const backend = mockBackend();
    const { result } = mount();
    act(() => result.current.startBlankDraft());
    act(() => result.current.setComposeDraft({ ...result.current.composeDraft!, subject: "Neuf" }));

    await act(async () => {
      await result.current.saveToDrafts(result.current.composeDraft!);
    });

    expect(backend.deleted).toEqual([]);
  });
});

describe("envoi · un seul départ par brouillon", () => {
  it("ignore les clics répétés pendant l'envoi", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend = mockBackend(MESSAGE, gate);
    const { result } = mount();
    act(() => result.current.resumeDraft(draftMail(SOURCE)));
    await waitFor(() => expect(result.current.composeDraft).not.toBeNull());
    const draft = result.current.composeDraft!;

    act(() => {
      for (let index = 0; index < 36; index += 1) result.current.sendDraft(draft);
    });

    await waitFor(() => expect(backend.sent).toHaveLength(1));
    expect(result.current.composeSending).toBe(true);

    await act(async () => {
      release();
      await gate;
    });

    await waitFor(() => expect(result.current.composeSending).toBe(false));
    expect(result.current.composeDraft).toBeNull();
    expect(result.current.composeOpen).toBe(false);
    expect(backend.sent).toHaveLength(1);
  });

  it("un échec réactive l'envoi avec l'erreur du serveur", async () => {
    const backend = mockBackend();
    backend.sendFails = true;
    const { result } = mount();
    act(() => result.current.resumeDraft(draftMail(SOURCE)));
    await waitFor(() => expect(result.current.composeDraft).not.toBeNull());
    const draft = result.current.composeDraft!;

    await act(async () => result.current.sendDraft(draft));

    await waitFor(() => expect(result.current.composeSendError).toContain("Envoi impossible"));
    expect(result.current.composeSendError).toContain("imap · relais SMTP refusé");
    expect(result.current.composeSending).toBe(false);
    expect(result.current.composeOpen).toBe(true);
    expect(result.current.composeDraft).not.toBeNull();
    expect(result.current.notices.at(-1)?.message).toContain("Envoi impossible");

    act(() => result.current.setComposeDraft({ ...draft, subject: "Planning phase 2 (bis)" }));
    expect(result.current.composeSendError).toBeNull();

    backend.sendFails = false;
    await act(async () => result.current.sendDraft(result.current.composeDraft!));

    await waitFor(() => expect(result.current.composeDraft).toBeNull());
    expect(backend.sent).toHaveLength(2);
  });
});

describe("routage d'un brouillon vers l'éditeur", () => {
  it("ouvrir un message du dossier Brouillons reprend au lieu de lire", async () => {
    mockBackend();
    const { result } = mount();

    act(() => result.current.openMessage(draftMail(SOURCE)));

    await waitFor(() => expect(result.current.composeOpen).toBe(true));
    expect(result.current.composeDraft?.to).toBe("marc@test.fr");
    expect(result.current.openMail).toBeNull();
  });
});

describe("reprise d'un brouillon (démo)", () => {
  const DEMO_DRAFT = () => MAILS.find((mail) => mail.id === "d2")!;

  it("reconstruit le brouillon depuis la maquette, pièce jointe comprise", () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "demo");
    const { result } = mount();

    act(() => result.current.resumeDraft(DEMO_DRAFT()));

    const draft = result.current.composeDraft!;
    expect(draft.to).toBe("camille@studio-lilas.fr");
    expect(draft.subject).toBe("Retours sur les maquettes v3");
    expect(draft.body).toContain("Deux points avant la démo");
    expect(draft.includeSignature).toBe(false);
    expect(draft.attachments).toEqual([
      { filename: "retours-v3.txt", mime: "text/plain", data_base64: DEMO_DRAFT().attachments![0].data, size: 65 },
    ]);
    expect(result.current.composeOpen).toBe(true);
    expect(result.current.composeTitle).toBe("Brouillon");
    expect(result.current.draftSource).toBeNull();
  });

  it("retire la maquette de la liste après enregistrement", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "demo");
    const { result } = mount();
    act(() => result.current.resumeDraft(DEMO_DRAFT()));

    await act(async () => {
      await result.current.saveToDrafts(result.current.composeDraft!);
    });

    expect(result.current.mails.some((mail) => mail.id === "d2")).toBe(false);
  });

  it("ouvrir une maquette de brouillon ouvre l'éditeur", () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "demo");
    const { result } = mount();

    act(() => result.current.openMessage(DEMO_DRAFT()));

    expect(result.current.composeOpen).toBe(true);
    expect(result.current.composeDraft?.subject).toBe("Retours sur les maquettes v3");
    expect(result.current.openMail).toBeNull();
  });
});

describe("persistance du brouillon repris", () => {
  it("garde la source du brouillon avec le brouillon", () => {
    window.localStorage.clear();
    const draft = { ...baseDraft("perso", false, false), subject: "Relu" };
    persistCompose(draft, "Brouillon", SOURCE);
    expect(loadPersistedCompose()).toEqual({ draft, title: "Brouillon", draftSource: SOURCE });
  });

  it("relit un stockage d'avant le suivi de reprise", () => {
    window.localStorage.clear();
    const draft = { ...baseDraft("perso", false, false), subject: "Ancien" };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ draft, title: "Nouveau message" }));
    expect(loadPersistedCompose()).toEqual({ draft, title: "Nouveau message" });
  });

  it("écrit la source dans le stockage et la relit au rechargement", async () => {
    mockBackend();
    const first = mount();
    act(() => first.result.current.resumeDraft(draftMail(SOURCE)));
    await waitFor(() => expect(first.result.current.composeDraft).not.toBeNull());
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!) as { draftSource?: MailSource };
    expect(stored.draftSource).toEqual(SOURCE);
    first.unmount();

    const second = mount();
    expect(second.result.current.draftSource).toEqual(SOURCE);
    expect(second.result.current.composeDraft?.subject).toBe("Planning phase 2");
  });
});
