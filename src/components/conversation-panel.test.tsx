import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ApiMessage, ApiThread } from "@/lib/api";
import { baseDraft } from "@/lib/draft";
import type { Mail } from "@/lib/mail";
import type { MailMode } from "@/lib/demo-mode";
import { setAccountDecryptPolicy, type FolderRecord } from "@/lib/mail-backend";
import { ConversationPanel } from "@/components/conversation-panel";
import { PrefsProvider } from "@/lib/prefs";

const ACCOUNT = "perso";
const INBOX = "INBOX";
const SENT = "Sent";
const THREAD = "t1";

const RECORDS: FolderRecord[] = [
  { accountId: ACCOUNT, path: INBOX, name: INBOX, role: "inbox" },
  { accountId: ACCOUNT, path: SENT, name: SENT, role: "sent" },
];

const message = (overrides: Partial<ApiMessage> = {}): ApiMessage => ({
  account_id: ACCOUNT,
  folder_path: INBOX,
  uid: 1,
  uidvalidity: 1,
  thread_id: THREAD,
  message_id: "<m1@test.fr>",
  in_reply_to: null,
  references: [],
  from: { name: "Camille", email: "camille@test.fr" },
  to: [{ name: null, email: "roman@test.fr" }],
  cc: [],
  subject: "Planning",
  date: "2026-01-05T10:00:00Z",
  flags: { unread: false, starred: false, answered: false },
  size: 512,
  pgp: "none",
  preview: "Aperçu du message reçu",
  body_text: "Corps reçu",
  body_html: null,
  attachments: [],
  ...overrides,
});

const sentMessage = (overrides: Partial<ApiMessage> = {}): ApiMessage =>
  message({
    folder_path: SENT,
    uid: 2,
    message_id: "<m2@test.fr>",
    from: { name: "Roman", email: "roman@test.fr" },
    subject: "Re: Planning",
    date: "2026-01-06T10:00:00Z",
    preview: "Ma réponse",
    body_text: null,
    ...overrides,
  });

const apiThread = (messages: ApiMessage[]): ApiThread => {
  const primary = messages[messages.length - 1] ?? message();
  return {
    id: THREAD,
    account_id: ACCOUNT,
    messages,
    primary,
    count: messages.length,
    unread: messages.filter((entry) => entry.flags.unread).length,
    starred: messages.some((entry) => entry.flags.starred),
    encrypted: messages.filter((entry) => entry.pgp === "encrypted").length,
    attachments: 0,
    participants: messages.map((entry) => entry.from.email),
    subject: primary.subject,
    preview: primary.preview,
  };
};

const reply = (body: unknown, status = 200) =>
  ({ ok: status < 300, status, statusText: "", json: async () => body }) as unknown as Response;

function stubBackend(
  options: { messages?: ApiMessage[]; threadStatus?: number; body?: ApiMessage } = {},
): string[] {
  const calls: string[] = [];
  const messages = options.messages ?? [sentMessage(), message()];
  const threadStatus = options.threadStatus ?? 200;
  const body = options.body ?? message({ body_text: "Corps relu sur le serveur" });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(url.pathname) + url.search;
    calls.push(path);
    if (path === `/api/accounts/${ACCOUNT}/threads/${THREAD}`) return reply(apiThread(messages), threadStatus);
    if (path.includes(`/folders/${SENT}/messages/2`)) return reply(body);
    if (path.includes(`/folders/${INBOX}/messages/1`)) return reply(body);
    return reply({}, 404);
  });
  return calls;
}

const QUOTED = "<blockquote>Le 9 novembre, Support a écrit : Bonjour</blockquote>";

function mount(
  overrides: {
    threadId?: string;
    quoted?: string;
    replyTargetId?: string;
    onRetarget?: (mail: Mail) => void;
    readOnly?: boolean;
  } = {},
  mode: MailMode = "api",
) {
  const { threadId = THREAD, quoted, replyTargetId, onRetarget, readOnly } = overrides;
  return render(
    <PrefsProvider>
      <ConversationPanel
        draft={{ ...baseDraft(ACCOUNT, false, false, threadId), quoted, replyTargetId }}
        mode={mode}
        records={RECORDS}
        onRetarget={onRetarget}
        readOnly={readOnly}
      />
    </PrefsProvider>
  );
}

const toggle = () => screen.getByTestId("conversation-panel").querySelector("button") as HTMLButtonElement;

const rows = () => screen.getAllByTestId("conversation-message");

beforeEach(() => {
  setAccountDecryptPolicy({});
});

afterEach(() => {
  setAccountDecryptPolicy({});
});

describe("panneau conversation · fil du brouillon", () => {
  it("reste replié par défaut et annonce le nombre de messages", async () => {
    stubBackend();
    mount();

    const button = await screen.findByRole("button", { name: "Voir la conversation · 2 messages" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.className).toContain("min-h-11");
    expect(screen.queryByTestId("conversation-messages")).toBeNull();
  });

  it("déplie la pile des messages du fil, expéditeur envoyé nommé Moi", async () => {
    stubBackend();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Voir la conversation · 2 messages" }));

    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    const messages = rows();
    expect(messages).toHaveLength(2);
    expect(messages[0].textContent).toContain("Camille");
    expect(messages[0].textContent).toContain("Aperçu du message reçu");
    expect(messages[1].textContent).toContain("Moi");
    expect(messages[1].textContent).toContain("Ma réponse");

    fireEvent.click(toggle());
    expect(screen.queryByTestId("conversation-messages")).toBeNull();
  });

  it("lit le corps d'un message qui n'en a pas au dépliage de ce message", async () => {
    const calls = stubBackend();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Voir la conversation · 2 messages" }));

    const sent = rows()[1];
    expect(sent.textContent).not.toContain("Corps relu sur le serveur");
    fireEvent.click(within(sent).getByLabelText("Déplier le message de Moi"));

    await waitFor(() =>
      expect(calls).toContain(`/api/accounts/${ACCOUNT}/folders/${SENT}/messages/2?fetch_body=true`),
    );
    await waitFor(() => expect(sent.textContent).toContain("Corps relu sur le serveur"));
    expect(within(sent).queryByRole("status")).toBeNull();
  });

  it("ne lit pas le corps d'un message chiffré quand PGP est coupé pour le compte", async () => {
    setAccountDecryptPolicy({ [ACCOUNT]: false });
    const calls = stubBackend({ messages: [sentMessage({ pgp: "encrypted" }), message()] });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Voir la conversation · 2 messages" }));

    const sent = rows()[1];
    fireEvent.click(within(sent).getByLabelText("Déplier le message de Moi"));

    expect(sent.textContent).toContain("Message chiffré · PGP désactivé pour ce compte");
    expect(calls.filter((call) => call.includes(`/folders/${SENT}/messages/2`))).toEqual([]);
  });

  it("affiche le fil de la démo sans aucun appel réseau", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mount({ threadId: "t-maquettes" }, "demo");

    fireEvent.click(await screen.findByRole("button", { name: "Voir la conversation · 4 messages" }));

    const messages = rows();
    expect(messages).toHaveLength(4);
    expect(messages.map((row) => row.textContent?.includes("Moi"))).toContain(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retombe sur la citation classique sans fil disponible", async () => {
    stubBackend({ threadStatus: 500 });
    const { rerender } = mount({ quoted: QUOTED });

    await waitFor(() => expect(screen.getByTestId("compose-quoted-block")).toBeTruthy());
    expect(screen.queryByTestId("conversation-panel")).toBeNull();

    rerender(
      <PrefsProvider>
        <ConversationPanel
          draft={{ ...baseDraft(ACCOUNT, false, false, undefined), quoted: QUOTED }}
          mode="api"
          records={RECORDS}
        />
      </PrefsProvider>,
    );
    expect(screen.getByTestId("compose-quoted-block")).toBeTruthy();
  });

  it("ne rend rien sans fil ni citation", () => {
    const { container } = mount({ threadId: undefined });
    expect(container.innerHTML).toBe("");
  });
});

describe("panneau conversation · cible du brouillon", () => {
  it("déplie et signale la ligne du message visé", async () => {
    stubBackend();
    mount({ replyTargetId: `${ACCOUNT}:${SENT}:2` });

    const target = await waitFor(() => {
      const found = rows().find((row) => row.dataset.current === "true");
      if (!found) throw new Error("ligne visée absente");
      return found;
    });

    expect(target.textContent).toContain("Moi");
    expect(target.textContent).toContain("Corps relu sur le serveur");
    expect(rows().filter((row) => row.dataset.current === "true")).toHaveLength(1);
  });

  it("réoriente le brouillon vers le message cliqué", async () => {
    const onRetarget = vi.fn();
    stubBackend();
    mount({ onRetarget });

    fireEvent.click(await screen.findByRole("button", { name: "Voir la conversation · 2 messages" }));
    fireEvent.click(within(rows()[0]).getByLabelText("Déplier le message de Camille"));
    fireEvent.click(within(rows()[0]).getByLabelText("Répondre à ce message · Camille"));

    expect(onRetarget).toHaveBeenCalledTimes(1);
    expect(onRetarget.mock.calls[0][0].id).toBe(`${ACCOUNT}:${INBOX}:1`);
  });

  it("n'offre pas la réorientation en démo lecture seule", async () => {
    stubBackend();
    mount({ onRetarget: () => {}, readOnly: true });

    fireEvent.click(await screen.findByRole("button", { name: "Voir la conversation · 2 messages" }));
    fireEvent.click(within(rows()[0]).getByLabelText("Déplier le message de Camille"));

    expect(screen.queryByLabelText(/Répondre à ce message/)).toBeNull();
  });

  it("n'offre rien sans gestionnaire de réorientation", async () => {
    stubBackend();
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Voir la conversation · 2 messages" }));
    fireEvent.click(within(rows()[0]).getByLabelText("Déplier le message de Camille"));

    expect(screen.queryByLabelText(/Répondre à ce message/)).toBeNull();
  });
});
