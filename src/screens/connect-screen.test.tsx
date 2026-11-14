import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const MICROSOFT_ID = "291c5ae6-2601-4cb5-8ae9-c6edbe9c3c1d";
const GOOGLE_ID = "1234567890-lavande.apps.googleusercontent.com";
const GOOGLE_SECRET = "GOCSPX-lavande";
const OTHER_MICROSOFT_ID = "aaaaaaaa-1111-2222-3333-444444444444";

const {
  oauthStart,
  oauthStatus,
  oauthComplete,
  health,
  openExternal,
  previewFolders,
  createAccount,
  setAccountPerimeter,
} = vi.hoisted(() => ({
  oauthStart: vi.fn(),
  oauthStatus: vi.fn(),
  oauthComplete: vi.fn(),
  health: vi.fn(),
  openExternal: vi.fn(),
  previewFolders: vi.fn(),
  createAccount: vi.fn(),
  setAccountPerimeter: vi.fn(),
}));

vi.mock("@/lib/prefs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prefs")>()),
  usePrefs: () => ({ setAccountPerimeter }),
}));

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  errorText: (error: unknown) => (error instanceof Error ? error.message : "erreur inconnue"),
  mailApi: {
    health,
    oauthStart,
    oauthStatus,
    oauthComplete,
    setSyncFolders: vi.fn(),
    previewFolders,
  },
}));

vi.mock("@/lib/open-external", () => ({ openExternal, isTauriShell: () => false }));

vi.mock("@/lib/store", () => ({
  useMailStore: () => ({
    createAccount,
    useDemo: vi.fn(),
    phase: "empty",
    refreshMailbox: vi.fn(),
    notify: vi.fn(),
  }),
}));

const {
  ConnectScreen,
  builtInClientId,
  resolveClientId,
  builtInClientSecret,
  resolveClientSecret,
} = await import("@/screens/connect-screen");

const GOOGLE_FIELD = "Identifiant d'application Google (client_id)";
const GOOGLE_SECRET_FIELD = "Secret d'application Google (client_secret)";
const MICROSOFT_FIELD = "Identifiant d'application Microsoft (client_id)";

function renderConnect() {
  return render(<ConnectScreen />);
}

function fillRequired() {
  fireEvent.change(screen.getByLabelText("Adresse e-mail"), {
    target: { value: "prenom@domaine.fr" },
  });
  fireEvent.change(screen.getByLabelText("Hôte IMAP"), { target: { value: "imap.domaine.fr" } });
  fireEvent.change(screen.getByLabelText("Hôte SMTP"), { target: { value: "smtp.domaine.fr" } });
}

async function startWith(provider: "Google" | "Microsoft") {
  fireEvent.click(screen.getByRole("button", { name: provider }));
  await waitFor(() => expect(oauthStart).toHaveBeenCalledTimes(1));
  return oauthStart.mock.calls[0][0];
}

describe("client_id OAuth résolu par fournisseur", () => {
  it("google ne reprend jamais l'identifiant Microsoft embarqué", () => {
    const env = { VITE_OAUTH_CLIENT_ID: MICROSOFT_ID };

    expect(resolveClientId("google", "", env)).toBe("");
    expect(builtInClientId("google", env)).toBe("");
  });

  it("google préfère la saisie manuelle", () => {
    expect(resolveClientId("google", GOOGLE_ID, { VITE_OAUTH_CLIENT_ID: MICROSOFT_ID })).toBe(
      GOOGLE_ID,
    );
    expect(resolveClientId("google", `  ${GOOGLE_ID}  `, {})).toBe(GOOGLE_ID);
  });

  it("google utilise son propre identifiant embarqué", () => {
    expect(
      resolveClientId("google", "", {
        VITE_OAUTH_CLIENT_ID: MICROSOFT_ID,
        VITE_GOOGLE_CLIENT_ID: GOOGLE_ID,
      }),
    ).toBe(GOOGLE_ID);
  });

  it("microsoft utilise l'identifiant embarqué, y compris l'ancien nom de variable", () => {
    expect(resolveClientId("microsoft", "", { VITE_OAUTH_CLIENT_ID: MICROSOFT_ID })).toBe(
      MICROSOFT_ID,
    );
    expect(resolveClientId("microsoft", "", { VITE_MICROSOFT_CLIENT_ID: OTHER_MICROSOFT_ID })).toBe(
      OTHER_MICROSOFT_ID,
    );
    expect(
      resolveClientId("microsoft", "", {
        VITE_OAUTH_CLIENT_ID: MICROSOFT_ID,
        VITE_MICROSOFT_CLIENT_ID: OTHER_MICROSOFT_ID,
      }),
    ).toBe(MICROSOFT_ID);
  });

  it("custom n'a aucun identifiant embarqué", () => {
    expect(
      builtInClientId("custom", {
        VITE_OAUTH_CLIENT_ID: MICROSOFT_ID,
        VITE_MICROSOFT_CLIENT_ID: MICROSOFT_ID,
        VITE_GOOGLE_CLIENT_ID: GOOGLE_ID,
      }),
    ).toBe("");
  });
});

describe("client_secret OAuth résolu par fournisseur", () => {
  it("google reprend le secret embarqué", () => {
    expect(builtInClientSecret("google", {})).toBe("");
    expect(builtInClientSecret("google", { VITE_GOOGLE_CLIENT_SECRET: GOOGLE_SECRET })).toBe(
      GOOGLE_SECRET,
    );
    expect(
      resolveClientSecret("google", "", { VITE_GOOGLE_CLIENT_SECRET: GOOGLE_SECRET }),
    ).toBe(GOOGLE_SECRET);
  });

  it("google préfère la saisie manuelle, espaces retirés", () => {
    expect(
      resolveClientSecret("google", `  ${GOOGLE_SECRET}-main  `, {
        VITE_GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
      }),
    ).toBe(`${GOOGLE_SECRET}-main`);
    expect(resolveClientSecret("google", `  ${GOOGLE_SECRET}  `, {})).toBe(GOOGLE_SECRET);
  });

  it("microsoft et custom n'ont aucun secret, même embarqué", () => {
    const env = { VITE_GOOGLE_CLIENT_SECRET: GOOGLE_SECRET };

    expect(builtInClientSecret("microsoft", env)).toBe("");
    expect(builtInClientSecret("custom", env)).toBe("");
    expect(resolveClientSecret("microsoft", "", env)).toBe("");
    expect(resolveClientSecret("custom", "", env)).toBe("");
  });
});

describe("Écran de connexion · identifiant par fournisseur", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    health.mockResolvedValue({});
    oauthStatus.mockResolvedValue({ status: "failed", error: "consentement refusé" });
    oauthStart.mockResolvedValue({ session: "s1", auth_url: "https://exemple.test/consent" });
    vi.spyOn(window, "open").mockReturnValue(null);
    vi.stubEnv("VITE_OAUTH_CLIENT_ID", MICROSOFT_ID);
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
    vi.stubEnv("VITE_GOOGLE_CLIENT_SECRET", "");
    vi.stubEnv("VITE_MICROSOFT_CLIENT_ID", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("affiche un champ Google tant qu'aucun identifiant Google n'est embarqué", () => {
    renderConnect();

    expect((screen.getByLabelText(GOOGLE_FIELD) as HTMLInputElement).value).toBe("");
    expect(screen.queryByLabelText(MICROSOFT_FIELD)).toBeNull();
  });

  it("n'envoie pas l'identifiant Microsoft quand on choisit Google", async () => {
    renderConnect();
    fillRequired();

    const sent = await startWith("Google");

    expect(sent.provider).toBe("google");
    expect(sent.client_id).toBeUndefined();
    expect(sent.client_secret).toBeUndefined();
  });

  it("envoie l'identifiant Google saisi à la main", async () => {
    renderConnect();
    fillRequired();
    fireEvent.change(screen.getByLabelText(GOOGLE_FIELD), {
      target: { value: `  ${GOOGLE_ID}  ` },
    });

    const sent = await startWith("Google");

    expect(sent.provider).toBe("google");
    expect(sent.client_id).toBe(GOOGLE_ID);
  });

  it("envoie l'identifiant Microsoft embarqué pour Microsoft", async () => {
    renderConnect();
    fillRequired();

    const sent = await startWith("Microsoft");

    expect(sent.provider).toBe("microsoft");
    expect(sent.client_id).toBe(MICROSOFT_ID);
  });

  it("envoie l'identifiant Google embarqué quand la variable est renseignée", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", GOOGLE_ID);
    renderConnect();
    fillRequired();

    expect(screen.queryByLabelText(GOOGLE_FIELD)).toBeNull();

    const sent = await startWith("Google");

    expect(sent.client_id).toBe(GOOGLE_ID);
  });

  it("envoie le secret Google embarqué quand la variable est renseignée", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", GOOGLE_ID);
    vi.stubEnv("VITE_GOOGLE_CLIENT_SECRET", GOOGLE_SECRET);
    renderConnect();
    fillRequired();

    const sent = await startWith("Google");

    expect(sent.client_id).toBe(GOOGLE_ID);
    expect(sent.client_secret).toBe(GOOGLE_SECRET);
  });

  it("n'envoie aucun secret quand la variable est vide", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", GOOGLE_ID);
    renderConnect();
    fillRequired();

    const sent = await startWith("Google");

    expect(sent.client_secret).toBeUndefined();
  });

  it("envoie le secret Google saisi à la main", async () => {
    renderConnect();
    fillRequired();
    fireEvent.change(screen.getByLabelText(GOOGLE_FIELD), { target: { value: GOOGLE_ID } });
    fireEvent.change(screen.getByLabelText(GOOGLE_SECRET_FIELD), {
      target: { value: `  ${GOOGLE_SECRET}  ` },
    });

    const sent = await startWith("Google");

    expect(sent.client_id).toBe(GOOGLE_ID);
    expect(sent.client_secret).toBe(GOOGLE_SECRET);
  });

  it("déclenche l'échange une fois le code reçu", async () => {
    oauthStatus
      .mockResolvedValueOnce({ status: "code_received" })
      .mockResolvedValue({ status: "failed", error: "échange refusé" });
    oauthComplete.mockResolvedValue({ status: "failed", error: "échange refusé" });
    renderConnect();
    fillRequired();

    await startWith("Microsoft");

    await waitFor(() => expect(oauthComplete).toHaveBeenCalledWith("s1"));
  });
});

const PREVIEWED = [
  {
    account_id: "prenom-domaine-fr",
    path: "INBOX",
    name: "INBOX",
    role: "inbox",
    uidvalidity: 1,
    uidnext: 2,
    last_sync_at: null,
    delimiter: "/",
  },
  {
    account_id: "prenom-domaine-fr",
    path: "INBOX/Travail",
    name: "Travail",
    role: "other",
    uidvalidity: 1,
    uidnext: 2,
    last_sync_at: null,
    delimiter: "/",
  },
  {
    account_id: "prenom-domaine-fr",
    path: "INBOX/Travail/2026",
    name: "2026",
    role: "other",
    uidvalidity: 1,
    uidnext: 2,
    last_sync_at: null,
    delimiter: "/",
  },
  {
    account_id: "prenom-domaine-fr",
    path: "Envoyés",
    name: "Envoyés",
    role: "sent",
    uidvalidity: 1,
    uidnext: 2,
    last_sync_at: null,
    delimiter: "/",
  },
];

function fillForm() {
  fireEvent.change(screen.getByLabelText("Libellé"), { target: { value: "Perso" } });
  fireEvent.change(screen.getByLabelText("Adresse e-mail"), {
    target: { value: "prenom@domaine.fr" },
  });
  fireEvent.change(screen.getByLabelText("Mot de passe"), { target: { value: "secret" } });
  fireEvent.change(screen.getByLabelText("Hôte IMAP"), { target: { value: "imap.domaine.fr" } });
  fireEvent.change(screen.getByLabelText("Hôte SMTP"), { target: { value: "smtp.domaine.fr" } });
}

const preview = async () => {
  fireEvent.click(screen.getByRole("button", { name: /Prévisualiser les dossiers/ }));
  await waitFor(() => expect(previewFolders).toHaveBeenCalledTimes(1));
};

const checkbox = (name: string) => screen.getByLabelText(`Synchroniser ${name}`) as HTMLInputElement;

describe("Écran de connexion · sélection des dossiers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    health.mockResolvedValue({});
    previewFolders.mockResolvedValue(PREVIEWED);
    createAccount.mockResolvedValue("prenom-domaine-fr");
    vi.stubEnv("VITE_OAUTH_CLIENT_ID", "");
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("prévisualise les dossiers du serveur avant toute création", async () => {
    renderConnect();
    fillForm();

    await preview();

    expect(previewFolders.mock.calls[0][0]).toMatchObject({
      label: "Perso",
      email: "prenom@domaine.fr",
      username: "prenom@domaine.fr",
      imap: { host: "imap.domaine.fr", port: 993, encryption: "tls" },
      smtp: { host: "smtp.domaine.fr", port: 465, encryption: "tls" },
      auth: { kind: "password", password: "secret" },
    });
    expect(createAccount).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Dossiers à synchroniser" })).toBeTruthy();
  });

  it("coche tous les dossiers par défaut", async () => {
    renderConnect();
    fillForm();

    await preview();

    expect(checkbox("INBOX").checked).toBe(true);
    expect(checkbox("Travail").checked).toBe(true);
    expect(checkbox("2026").checked).toBe(true);
    expect(checkbox("Envoyés").checked).toBe(true);
  });

  it("crée le compte avec les seuls dossiers cochés", async () => {
    renderConnect();
    fillForm();
    await preview();

    fireEvent.click(checkbox("2026"));
    fireEvent.click(screen.getByRole("button", { name: /Connecter le compte/ }));

    await waitFor(() => expect(createAccount).toHaveBeenCalledTimes(1));
    expect(createAccount.mock.calls[0][0].synced_folders).toEqual([
      "INBOX",
      "INBOX/Travail",
      "Envoyés",
    ]);
  });

  it("propose le périmètre du compte avant de le connecter", async () => {
    renderConnect();
    fillForm();
    await preview();

    const mails = screen.getByRole("switch", { name: /^Mails/ });
    const calendar = screen.getByRole("switch", { name: /^Agenda/ });
    expect(mails.getAttribute("aria-checked")).toBe("true");
    expect(calendar.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("switch", { name: /^Contacts/ })).toBeNull();
    expect(screen.getByText("Contacts : bientôt disponible")).toBeTruthy();

    fireEvent.click(calendar);
    fireEvent.click(screen.getByRole("button", { name: /Connecter le compte/ }));

    await waitFor(() => expect(setAccountPerimeter).toHaveBeenCalledTimes(1));
    expect(setAccountPerimeter.mock.calls[0]).toEqual([
      "prenom-domaine-fr",
      { mails: true, calendar: false, contacts: false },
    ]);
  });

  it("décoche tout un sous-arbre quand on décoche le parent", async () => {
    renderConnect();
    fillForm();
    await preview();

    fireEvent.click(checkbox("Travail"));
    expect(checkbox("2026").checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Connecter le compte/ }));

    await waitFor(() => expect(createAccount).toHaveBeenCalledTimes(1));
    expect(createAccount.mock.calls[0][0].synced_folders).toEqual(["INBOX", "Envoyés"]);
  });

  it("replie un palier de l'arbre", async () => {
    renderConnect();
    fillForm();
    await preview();

    fireEvent.click(screen.getByLabelText("Replier Travail"));
    expect(screen.queryByLabelText("Synchroniser 2026")).toBeNull();

    fireEvent.click(screen.getByLabelText("Déplier Travail"));
    expect(screen.getByLabelText("Synchroniser 2026")).toBeTruthy();
  });

  it("revient au formulaire sans rien créer", async () => {
    renderConnect();
    fillForm();
    await preview();

    fireEvent.click(screen.getByRole("button", { name: /Revenir au formulaire/ }));

    expect(screen.getByRole("heading", { name: "Ajouter un compte" })).toBeTruthy();
    expect(screen.queryByLabelText("Synchroniser INBOX")).toBeNull();
    expect(createAccount).not.toHaveBeenCalled();
  });

  it("affiche le refus du serveur et reste sur le formulaire", async () => {
    previewFolders.mockRejectedValue(new Error("identifiants refusés"));
    renderConnect();
    fillForm();

    await preview();

    expect(screen.getByRole("alert").textContent).toBe("identifiants refusés");
    expect(screen.queryByRole("heading", { name: "Dossiers à synchroniser" })).toBeNull();
    expect(createAccount).not.toHaveBeenCalled();
  });
});
