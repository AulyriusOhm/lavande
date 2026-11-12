import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const MICROSOFT_ID = "291c5ae6-2601-4cb5-8ae9-c6edbe9c3c1d";
const GOOGLE_ID = "1234567890-lavande.apps.googleusercontent.com";
const OTHER_MICROSOFT_ID = "aaaaaaaa-1111-2222-3333-444444444444";

const { oauthStart, oauthStatus, health, openExternal } = vi.hoisted(() => ({
  oauthStart: vi.fn(),
  oauthStatus: vi.fn(),
  health: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  errorText: (error: unknown) => (error instanceof Error ? error.message : "erreur inconnue"),
  mailApi: {
    health,
    oauthStart,
    oauthStatus,
    setSyncFolders: vi.fn(),
  },
}));

vi.mock("@/lib/open-external", () => ({ openExternal, isTauriShell: () => false }));

vi.mock("@/lib/store", () => ({
  useMailStore: () => ({
    createAccount: vi.fn(),
    useDemo: vi.fn(),
    phase: "empty",
    refreshMailbox: vi.fn(),
    notify: vi.fn(),
  }),
}));

const { ConnectScreen, builtInClientId, resolveClientId } = await import(
  "@/screens/connect-screen"
);

const GOOGLE_FIELD = "Identifiant d'application Google (client_id)";
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

describe("Écran de connexion · identifiant par fournisseur", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    health.mockResolvedValue({});
    oauthStatus.mockResolvedValue({ status: "failed", error: "consentement refusé" });
    oauthStart.mockResolvedValue({ session: "s1", auth_url: "https://exemple.test/consent" });
    vi.spyOn(window, "open").mockReturnValue(null);
    vi.stubEnv("VITE_OAUTH_CLIENT_ID", MICROSOFT_ID);
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
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
});
