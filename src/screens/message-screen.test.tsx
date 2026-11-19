import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PrefsProvider } from "@/lib/prefs";
import type { Mail } from "@/lib/mail";
import type { Thread } from "@/lib/threads";

const { attachment, saveBlob } = vi.hoisted(() => ({
  attachment: vi.fn(),
  saveBlob: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  mailApi: { attachment },
  errorText: (error: unknown) => (error instanceof Error ? error.message : "erreur inconnue"),
}));

vi.mock("@/lib/download", () => ({ saveBlob }));

const { MessageScreen } = await import("@/screens/message-screen");

const MAIL: Mail = {
  id: "perso:INBOX:12",
  account: "perso",
  folder: "inbox",
  source: { accountId: "perso", folderPath: "INBOX", uid: 12 },
  name: "Camille Rousseau",
  email: "camille@studio-lilas.fr",
  subject: "Factures de mars",
  preview: "Les factures du mois.",
  body: ["Les factures du mois."],
  time: "09:41",
  unread: false,
  starred: false,
  pgp: "none",
  attachments: [
    { name: "facture.pdf", size: "5 o", mime: "application/pdf", index: 0 },
    { name: "capture.png", size: "9 o", mime: "image/png", index: 1 },
  ],
  tone: 0,
};

const THREAD: Thread = {
  id: "t-factures",
  messages: [MAIL],
  primary: MAIL,
  count: 1,
  unread: 0,
  starred: false,
  encrypted: 0,
  attachments: 2,
  participants: ["Camille Rousseau"],
  subject: MAIL.subject,
  preview: MAIL.preview,
  time: "09:41",
  order: 0,
};

function renderScreen(mail: Mail = MAIL, onOpenPgp?: () => void) {
  const thread: Thread = { ...THREAD, messages: [mail], primary: mail };
  render(
    <PrefsProvider>
      <MessageScreen
        thread={thread}
        onClose={() => {}}
        onToggleStar={() => {}}
        onReply={() => {}}
        onOpenPgp={onOpenPgp}
      />
    </PrefsProvider>,
  );
}

const BANNER = "Message chiffré · PGP désactivé pour ce compte";

function disablePgp(accountId = "perso") {
  window.localStorage.setItem(
    "lavande.prefs",
    JSON.stringify({ pgpAccounts: { [accountId]: { enabled: false, encrypt: true, sign: true } } }),
  );
}

beforeEach(() => {
  attachment.mockReset();
  saveBlob.mockReset();
  window.localStorage.clear();
});

describe("bandeau PGP coupé", () => {
  it("explique pourquoi le corps chiffré reste vide", () => {
    disablePgp();
    renderScreen({ ...MAIL, pgp: "encrypted" });

    expect(screen.getByText(BANNER)).toBeTruthy();
    expect(
      screen.getByText("Active PGP pour ce compte dans les réglages pour le déchiffrer."),
    ).toBeTruthy();
  });

  it("disparaît quand le compte a PGP activé", () => {
    renderScreen({ ...MAIL, pgp: "encrypted" });

    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it("disparaît pour un message non chiffré", () => {
    disablePgp();
    renderScreen(MAIL);

    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it("disparaît une fois le corps chargé", () => {
    disablePgp();
    renderScreen({ ...MAIL, pgp: "encrypted", bodyFetched: true });

    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it("ouvre les réglages depuis le bouton", () => {
    disablePgp();
    const onOpenPgp = vi.fn();
    renderScreen({ ...MAIL, pgp: "encrypted" }, onOpenPgp);

    fireEvent.click(screen.getByText("Ouvrir les réglages"));

    expect(onOpenPgp).toHaveBeenCalledTimes(1);
  });

  it("reste informatif sans bouton quand la navigation n'est pas câblée", () => {
    disablePgp();
    renderScreen({ ...MAIL, pgp: "encrypted" });

    expect(screen.getByText(BANNER)).toBeTruthy();
    expect(screen.queryByText("Ouvrir les réglages")).toBeNull();
  });
});

describe("corps à la demande", () => {
  it("montre le chargement tant que le corps n'est pas revenu", () => {
    render(
      <PrefsProvider>
        <MessageScreen
          thread={THREAD}
          bodyFetching={MAIL.id}
          onClose={() => {}}
          onToggleStar={() => {}}
          onReply={() => {}}
        />
      </PrefsProvider>,
    );

    expect(screen.getByText("Chargement du message…")).toBeTruthy();
    expect(screen.queryByTitle("Contenu du message")).toBeNull();
  });

  it("affiche le corps une fois chargé", () => {
    renderScreen();

    expect(screen.queryByText("Chargement du message…")).toBeNull();
    expect(screen.getByText("Les factures du mois.")).toBeTruthy();
  });

  it("demande le corps d'un message antérieur déplié", () => {
    const onFetchBody = vi.fn();
    const older: Mail = {
      ...MAIL,
      id: "perso:INBOX:9",
      source: { accountId: "perso", folderPath: "INBOX", uid: 9 },
      name: "Marc Delaunay",
      preview: "Aperçu sans corps",
      body: [],
      bodyFetched: false,
      attachments: [],
    };
    const thread: Thread = {
      ...THREAD,
      messages: [older, MAIL],
      count: 2,
      participants: ["Marc Delaunay", "Camille Rousseau"],
    };
    render(
      <PrefsProvider>
        <MessageScreen
          thread={thread}
          onFetchBody={onFetchBody}
          onClose={() => {}}
          onToggleStar={() => {}}
          onReply={() => {}}
        />
      </PrefsProvider>,
    );

    fireEvent.click(screen.getByLabelText("Déplier les 1 message antérieur"));
    fireEvent.click(screen.getByLabelText("Afficher le message de Marc Delaunay"));

    expect(onFetchBody).toHaveBeenCalledWith(older);
  });

  it("montre le chargement du message antérieur en cours de lecture", () => {
    const older: Mail = {
      ...MAIL,
      id: "perso:INBOX:9",
      source: { accountId: "perso", folderPath: "INBOX", uid: 9 },
      name: "Marc Delaunay",
      body: [],
      bodyFetched: false,
      attachments: [],
    };
    const thread: Thread = {
      ...THREAD,
      messages: [older, MAIL],
      count: 2,
      participants: ["Marc Delaunay", "Camille Rousseau"],
    };
    render(
      <PrefsProvider>
        <MessageScreen
          thread={thread}
          bodyFetching={older.id}
          onClose={() => {}}
          onToggleStar={() => {}}
          onReply={() => {}}
        />
      </PrefsProvider>,
    );

    fireEvent.click(screen.getByLabelText("Déplier les 1 message antérieur"));
    fireEvent.click(screen.getByLabelText("Afficher le message de Marc Delaunay"));

    expect(screen.getByText("Chargement du message…")).toBeTruthy();
  });
});

describe("marque « répondu »", () => {
  it("signale le mail auquel on a déjà répondu", () => {
    renderScreen({ ...MAIL, answered: true });

    expect(screen.getByText("Répondu")).toBeTruthy();
  });

  it("ne dit rien d'un mail sans réponse", () => {
    renderScreen();

    expect(screen.queryByText("Répondu")).toBeNull();
  });
});

describe("ancre le mail ouvert dans le fil", () => {
  const REPLY: Mail = {
    ...MAIL,
    id: "perso:Sent:13",
    folder: "sent",
    source: { accountId: "perso", folderPath: "Sent", uid: 13 },
    name: "Roman Lavande",
    email: "roman@lavande.mail",
    preview: "Ma réponse",
    body: ["Ma réponse"],
    time: "10:12",
    attachments: [],
  };

  const renderThread = () =>
    render(
      <PrefsProvider>
        <MessageScreen
          thread={{ ...THREAD, messages: [MAIL, REPLY], primary: MAIL, count: 2 }}
          onClose={() => {}}
          onToggleStar={() => {}}
          onReply={() => {}}
        />
      </PrefsProvider>,
    );

  it("garde le mail ouvert en tête et range la réponse plus récente dans les antérieurs", () => {
    renderThread();

    expect(screen.getByText("Les factures du mois.")).toBeTruthy();
    expect(screen.queryByLabelText("Afficher le message de Camille Rousseau")).toBeNull();

    fireEvent.click(screen.getByLabelText("Déplier les 1 message antérieur"));

    expect(screen.getByLabelText("Afficher le message de Roman Lavande")).toBeTruthy();
    expect(screen.queryByLabelText("Afficher le message de Camille Rousseau")).toBeNull();
  });
});

describe("téléchargement des pièces jointes", () => {
  it("récupère les octets du démon et enregistre le fichier", async () => {
    const blob = new Blob(["hello"], { type: "application/pdf" });
    attachment.mockResolvedValue(blob);
    renderScreen();

    fireEvent.click(screen.getByLabelText("Télécharger facture.pdf (5 o)"));

    await waitFor(() => expect(attachment).toHaveBeenCalledWith("perso", "INBOX", 12, 0));
    expect(saveBlob).toHaveBeenCalledWith(blob, "facture.pdf");
    expect(await screen.findByText("« facture.pdf » téléchargé")).toBeTruthy();
  });

  it("demande l'index de la pièce jointe cliquée", async () => {
    attachment.mockResolvedValue(new Blob(["x"]));
    renderScreen();

    fireEvent.click(screen.getByLabelText("Télécharger capture.png (9 o)"));

    await waitFor(() => expect(attachment).toHaveBeenCalledWith("perso", "INBOX", 12, 1));
  });

  it("affiche l'erreur du démon sans rien enregistrer", async () => {
    attachment.mockRejectedValue(new Error("serveur IMAP : connexion refusée"));
    renderScreen();

    fireEvent.click(screen.getByLabelText("Télécharger facture.pdf (5 o)"));

    expect(await screen.findByText("Téléchargement impossible · serveur IMAP : connexion refusée")).toBeTruthy();
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it("dit qu'une pièce jointe de la maquette n'a pas d'octets", async () => {
    renderScreen({
      ...MAIL,
      source: undefined,
      attachments: [{ name: "inbox-v3.fig", size: "4,2 Mo" }],
    });

    fireEvent.click(screen.getByLabelText("Télécharger inbox-v3.fig (4,2 Mo)"));

    expect(await screen.findByText(/vient de la maquette/)).toBeTruthy();
    expect(attachment).not.toHaveBeenCalled();
    expect(saveBlob).not.toHaveBeenCalled();
  });
});

describe("reprise d'un brouillon", () => {
  const renderDraft = (onResume: (mail: Mail) => void) => {
    const draft: Mail = { ...MAIL, folder: "drafts", to: "marc@test.fr" };
    render(
      <PrefsProvider>
        <MessageScreen
          thread={{ ...THREAD, messages: [draft], primary: draft }}
          onClose={() => {}}
          onToggleStar={() => {}}
          onReply={() => {}}
          onResume={onResume}
        />
      </PrefsProvider>,
    );
    return draft;
  };

  it("remplace « Répondre » par la reprise du brouillon", () => {
    const onResume = vi.fn();
    const draft = renderDraft(onResume);

    fireEvent.click(screen.getAllByRole("button", { name: "Reprendre le brouillon" })[1]);

    expect(onResume).toHaveBeenCalledWith(draft);
    expect(screen.queryAllByLabelText("Répondre")).toHaveLength(0);
  });
});

describe("analyse à la demande", () => {
  const renderWithAnalyse = (
    mail: Mail = MAIL,
    options: { onAnalyse?: (mail: Mail) => void; readOnly?: boolean } = {},
  ) => {
    render(
      <PrefsProvider>
        <MessageScreen
          thread={{ ...THREAD, messages: [mail], primary: mail }}
          readOnly={options.readOnly}
          onClose={() => {}}
          onToggleStar={() => {}}
          onReply={() => {}}
          onAnalyse={options.onAnalyse}
        />
      </PrefsProvider>,
    );
  };

  it("propose le bouton Analyse à côté de Transférer", () => {
    const onAnalyse = vi.fn();
    renderWithAnalyse(MAIL, { onAnalyse });

    expect(screen.getByLabelText("Transférer")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Analyse"));

    expect(onAnalyse).toHaveBeenCalledWith(MAIL);
  });

  it("garde le bouton inactif sans gestionnaire", () => {
    renderWithAnalyse();

    expect((screen.getByLabelText("Analyse") as HTMLButtonElement).disabled).toBe(true);
  });

  it("masque le bouton Analyse en lecture seule", () => {
    renderWithAnalyse(MAIL, { onAnalyse: vi.fn(), readOnly: true });

    expect(screen.queryByLabelText("Analyse")).toBeNull();
  });

  it("masque le bouton Analyse sur un brouillon", () => {
    renderWithAnalyse({ ...MAIL, folder: "drafts" }, { onAnalyse: vi.fn() });

    expect(screen.queryByLabelText("Analyse")).toBeNull();
  });
});

describe("destinataires du message", () => {
  it("affiche les À et Cc du message reçu", () => {
    renderScreen({ ...MAIL, to: "roman@lavande.mail", cc: "marc@test.fr, copie@test.fr" });

    const recipients = within(screen.getByTestId("mail-recipients"));
    expect(recipients.getByText("À")).toBeTruthy();
    expect(recipients.getByText("roman@lavande.mail")).toBeTruthy();
    expect(recipients.getByText("Cc")).toBeTruthy();
    expect(recipients.getByText("marc@test.fr, copie@test.fr")).toBeTruthy();
  });

  it("cache la ligne Cc quand le message n'en a pas", () => {
    renderScreen({ ...MAIL, to: "roman@lavande.mail" });

    const recipients = within(screen.getByTestId("mail-recipients"));
    expect(recipients.getByText("À")).toBeTruthy();
    expect(recipients.queryByText("Cc")).toBeNull();
  });

  it("n'affiche aucun bloc sans destinataire connu", () => {
    renderScreen();

    expect(screen.queryByTestId("mail-recipients")).toBeNull();
  });
});
