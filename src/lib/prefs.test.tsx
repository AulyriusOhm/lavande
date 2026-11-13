import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  DEFAULT_NOTIFICATIONS,
  DEFAULT_SYNC,
  PrefsProvider,
  accountPgp,
  asHiddenFolders,
  asNotifications,
  asPgpAccounts,
  asSync,
  isFolderHidden,
  notificationsForAccount,
  resolvePgp,
  usePrefs,
} from "@/lib/prefs";
import type { NotificationPrefs } from "@/lib/prefs";
import { DEFAULT_SUMMARY } from "@/lib/summary";

const mount = () =>
  renderHook(() => usePrefs(), {
    wrapper: ({ children }: { children: ReactNode }) => <PrefsProvider>{children}</PrefsProvider>,
  });

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

beforeEach(() => {
  window.localStorage.clear();
});

describe("préférences · résumés", () => {
  it("démarre sur les valeurs par défaut du moteur", () => {
    const { result } = mount();
    expect(result.current.summary).toEqual(DEFAULT_SUMMARY);
  });

  it("relit une configuration complète", () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({
        summary: {
          enabled: false,
          llmConsent: true,
          morningStart: 7,
          middayStart: 13,
          eveningStart: 19,
          lookbackHours: 12,
        },
      }),
    );

    const { result } = mount();
    expect(result.current.summary).toEqual({
      enabled: false,
      llmConsent: true,
      morningStart: 7,
      middayStart: 13,
      eveningStart: 19,
      lookbackHours: 12,
    });
  });

  it("ignore les valeurs invalides", () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({
        summary: {
          enabled: "oui",
          llmConsent: 1,
          morningStart: 99,
          middayStart: "13",
          eveningStart: -4,
          lookbackHours: 0,
        },
      }),
    );

    const { result } = mount();
    expect(result.current.summary).toEqual(DEFAULT_SUMMARY);
  });

  it("accepte une configuration partielle et borne la fenêtre", () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ summary: { middayStart: 13, lookbackHours: 900 } }),
    );

    const { result } = mount();
    expect(result.current.summary.middayStart).toBe(13);
    expect(result.current.summary.morningStart).toBe(DEFAULT_SUMMARY.morningStart);
    expect(result.current.summary.lookbackHours).toBe(72);
  });

  it("met à jour partiellement et persiste le résultat", () => {
    const { result } = mount();

    act(() => {
      result.current.setSummary({ llmConsent: true, eveningStart: 20 });
    });

    expect(result.current.summary.llmConsent).toBe(true);
    expect(result.current.summary.eveningStart).toBe(20);
    expect(result.current.summary.morningStart).toBe(DEFAULT_SUMMARY.morningStart);
    expect(stored().summary).toMatchObject({ llmConsent: true, eveningStart: 20 });
  });
});

describe("préférences · suggestions de réponse IA", () => {
  it("active le LLM par défaut et relit un réglage désactivé", () => {
    expect(mount().result.current.aiReplyEnabled).toBe(true);

    window.localStorage.setItem("lavande.prefs", JSON.stringify({ aiReplyEnabled: false }));
    const { result } = mount();
    expect(result.current.aiReplyEnabled).toBe(false);
  });

  it("ignore une valeur non booléenne et persiste le changement", () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ aiReplyEnabled: "non" }));
    const { result } = mount();
    expect(result.current.aiReplyEnabled).toBe(true);

    act(() => result.current.setAiReplyEnabled(false));
    expect(result.current.aiReplyEnabled).toBe(false);
    expect(stored().aiReplyEnabled).toBe(false);
  });
});

describe("préférences · suggestions de tâches IA", () => {
  it("démarre activé sur une fenêtre de 48 h, sans compte exclu", () => {
    expect(mount().result.current.aiTasks).toEqual({ enabled: true, windowHours: 48, excludedAccounts: [], events: false });
  });

  it("relit une configuration complète", () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ aiTasks: { enabled: false, windowHours: 6, excludedAccounts: ["pro"], events: true } }),
    );
    expect(mount().result.current.aiTasks).toEqual({
      enabled: false,
      windowHours: 6,
      excludedAccounts: ["pro"],
      events: true,
    });
  });

  it("ne garde que des identifiants de compte valides et dédoublonnés", () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ aiTasks: { excludedAccounts: ["pro", "pro", "", 7, null, "perso"] } }),
    );
    expect(mount().result.current.aiTasks.excludedAccounts).toEqual(["pro", "perso"]);

    window.localStorage.setItem("lavande.prefs", JSON.stringify({ aiTasks: { excludedAccounts: "pro" } }));
    expect(mount().result.current.aiTasks.excludedAccounts).toEqual([]);
  });

  it("ignore les valeurs invalides et borne la fenêtre à 1-168 h", () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ aiTasks: { enabled: "oui", windowHours: 0 } }));
    expect(mount().result.current.aiTasks).toEqual({ enabled: true, windowHours: 48, excludedAccounts: [], events: false });

    window.localStorage.setItem("lavande.prefs", JSON.stringify({ aiTasks: { windowHours: 900 } }));
    expect(mount().result.current.aiTasks.windowHours).toBe(168);

    window.localStorage.setItem("lavande.prefs", JSON.stringify({ aiTasks: { windowHours: 12.4 } }));
    expect(mount().result.current.aiTasks.windowHours).toBe(12);
  });

  it("met à jour partiellement et persiste le résultat, sans toucher aux résumés", () => {
    const { result } = mount();

    act(() => result.current.setAiTasks({ windowHours: 12 }));
    act(() => result.current.setAiTasks({ enabled: false }));
    act(() => result.current.setAiTasks({ excludedAccounts: ["pro"] }));

    expect(result.current.aiTasks).toEqual({ enabled: false, windowHours: 12, excludedAccounts: ["pro"], events: false });
    expect(result.current.summary).toEqual(DEFAULT_SUMMARY);
    expect(stored().aiTasks).toMatchObject({ enabled: false, windowHours: 12, excludedAccounts: ["pro"], events: false });
  });
});

describe("préférences · synchronisation", () => {
  it("active tous les domaines par défaut", () => {
    expect(mount().result.current.sync).toEqual({
      enabled: true,
      mails: true,
      calendar: true,
      kanban: true,
    });
  });

  it("relit des domaines coupés", () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ sync: { enabled: false, mails: false, calendar: false, kanban: false } }),
    );
    expect(mount().result.current.sync).toEqual({
      enabled: false,
      mails: false,
      calendar: false,
      kanban: false,
    });
  });

  it("ignore les valeurs non booléennes et complète les champs manquants", () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ sync: { enabled: "non", mails: 0, calendar: null } }),
    );
    expect(mount().result.current.sync).toEqual({
      enabled: true,
      mails: true,
      calendar: true,
      kanban: true,
    });

    window.localStorage.setItem("lavande.prefs", JSON.stringify({ sync: { kanban: false } }));
    expect(mount().result.current.sync).toEqual({
      enabled: true,
      mails: true,
      calendar: true,
      kanban: false,
    });
  });

  it("tolère une valeur absente ou d'un autre type", () => {
    expect(mount().result.current.sync.enabled).toBe(true);

    window.localStorage.setItem("lavande.prefs", JSON.stringify({ sync: "tout" }));
    expect(mount().result.current.sync).toEqual({
      enabled: true,
      mails: true,
      calendar: true,
      kanban: true,
    });
  });

  it("met à jour partiellement et persiste, sans toucher aux autres préférences", () => {
    const { result } = mount();

    act(() => result.current.setSync({ mails: false }));
    act(() => result.current.setSync({ enabled: false }));

    expect(result.current.sync).toEqual({
      enabled: false,
      mails: false,
      calendar: true,
      kanban: true,
    });
    expect(stored().sync).toMatchObject({ enabled: false, mails: false });
    expect(result.current.summary).toEqual(DEFAULT_SUMMARY);
    expect(result.current.aiTasks).toEqual({ enabled: true, windowHours: 48, excludedAccounts: [], events: false });
    expect(result.current.calendarEnabled).toBe(true);
    expect(result.current.pgpEncrypt).toBe(true);
  });

  it("expose un parseur tolérant pour les tests et la migration", () => {
    expect(asSync(undefined)).toEqual(DEFAULT_SYNC);
    expect(asSync({ kanban: false, mails: "oui" })).toEqual({ ...DEFAULT_SYNC, kanban: false });
  });
});

describe("préférences · toujours autoriser MCP", () => {
  it("démarre sans aucun type autorisé d'avance", () => {
    const { result } = mount();
    expect(result.current.mcpAlwaysAllow).toEqual({});
    expect(result.current.mcpConfirmSend).toBe(true);
  });

  it("relit les types autorisés en ignorant les valeurs invalides", () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ mcpAlwaysAllow: { envoi: true, suppression: false, brouillon: "oui", 12: true } }),
    );

    expect(mount().result.current.mcpAlwaysAllow).toEqual({ envoi: true, suppression: false, 12: true });
  });

  it("tolère une valeur absente ou d'un autre type", () => {
    expect(mount().result.current.mcpAlwaysAllow).toEqual({});

    window.localStorage.setItem("lavande.prefs", JSON.stringify({ mcpAlwaysAllow: "tout" }));
    expect(mount().result.current.mcpAlwaysAllow).toEqual({});
  });

  it("persiste un type autorisé puis le révoque", () => {
    const { result } = mount();

    act(() => result.current.setMcpAlwaysAllow("envoi", true));
    expect(stored().mcpAlwaysAllow).toEqual({ envoi: true });

    act(() => result.current.setMcpAlwaysAllow("envoi", false));
    expect(result.current.mcpAlwaysAllow).toEqual({ envoi: false });
  });

  it("réinitialise les autorisations et le garde-fou historique d'envoi", () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ mcpAlwaysAllow: { envoi: true, suppression: true }, mcpConfirmSend: false }),
    );
    const { result } = mount();

    act(() => result.current.resetMcpAllowances());

    expect(result.current.mcpAlwaysAllow).toEqual({});
    expect(result.current.mcpConfirmSend).toBe(true);
    expect(stored().mcpAlwaysAllow).toEqual({});
    expect(stored().mcpConfirmSend).toBe(true);
  });
});

describe("préférences · PGP par compte", () => {
  it("démarre sans réglage explicite et suit les défauts globaux", () => {
    const { result } = mount();

    expect(result.current.pgpAccounts).toEqual({});
    expect(accountPgp(result.current, "perso")).toEqual({ enabled: true, encrypt: true, sign: true });
    expect(resolvePgp(result.current, "perso")).toEqual({ enabled: true, encrypt: true, sign: true });
    expect(resolvePgp(result.current, undefined)).toEqual({ enabled: true, encrypt: true, sign: true });
  });

  it("relit un record partiel et complète avec les défauts globaux", () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({
        pgpEncrypt: false,
        pgpSign: true,
        pgpAccounts: {
          perso: { sign: false },
          pro: { enabled: false, encrypt: true },
          gmail: "oui",
          muet: {},
        },
      }),
    );
    const { result } = mount();

    expect(result.current.pgpAccounts).toEqual({
      perso: { enabled: true, encrypt: false, sign: false },
      pro: { enabled: false, encrypt: true, sign: true },
    });
    expect(result.current.pgpEncrypt).toBe(false);
    expect(result.current.pgpSign).toBe(true);
  });

  it("expose un parseur tolérant pour la migration", () => {
    const fallback = { encrypt: true, sign: false };
    expect(asPgpAccounts(undefined, fallback)).toEqual({});
    expect(asPgpAccounts("tout", fallback)).toEqual({});
    expect(asPgpAccounts({ a: null, b: 4 }, fallback)).toEqual({});
    expect(asPgpAccounts({ a: { enabled: "non", encrypt: 1 } }, fallback)).toEqual({});
    expect(asPgpAccounts({ a: { encrypt: false } }, fallback)).toEqual({
      a: { enabled: true, encrypt: false, sign: false },
    });
  });

  it("résout l'interrupteur maître sur le chiffrement, la signature et le déchiffrement", () => {
    const prefs = {
      pgpEncrypt: true,
      pgpSign: true,
      pgpAccounts: { pro: { enabled: false, encrypt: true, sign: true } },
    };

    expect(resolvePgp(prefs, "pro")).toEqual({ enabled: false, encrypt: false, sign: false });
    expect(resolvePgp(prefs, "perso")).toEqual({ enabled: true, encrypt: true, sign: true });
    expect(accountPgp(prefs, "pro")).toEqual({ enabled: false, encrypt: true, sign: true });
  });

  it("enregistre un compte sans toucher aux autres ni aux défauts globaux", () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ pgpSign: false, pgpAccounts: { pro: { enabled: false, encrypt: true, sign: true } } }),
    );
    const { result } = mount();

    act(() => result.current.setAccountPgp("perso", { sign: false }));

    expect(result.current.pgpAccounts).toEqual({
      pro: { enabled: false, encrypt: true, sign: true },
      perso: { enabled: true, encrypt: true, sign: false },
    });
    expect(stored().pgpAccounts).toEqual(result.current.pgpAccounts);
    expect(result.current.pgpSign).toBe(false);

    act(() => result.current.setAccountPgp("perso", { enabled: false }));

    expect(result.current.pgpAccounts.perso).toEqual({ enabled: false, encrypt: true, sign: false });
    expect(resolvePgp(result.current, "perso")).toEqual({ enabled: false, encrypt: false, sign: false });
  });
});

describe("préférences · dossiers masqués", () => {
  it("démarre sans dossier masqué", () => {
    const { result } = mount();
    expect(result.current.hiddenFolders).toEqual({});
    expect(isFolderHidden(result.current.hiddenFolders, "a1", "Projets")).toBe(false);
  });

  it("relit les chemins masqués par compte en ignorant les valeurs invalides", () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({
        hiddenFolders: { a1: ["Projets", "", 12], a2: "Projets", a3: [], a4: ["Archives"] },
      }),
    );

    expect(mount().result.current.hiddenFolders).toEqual({ a1: ["Projets"], a4: ["Archives"] });
  });

  it("tolère une valeur absente ou d'un autre type", () => {
    expect(asHiddenFolders(undefined)).toEqual({});
    expect(asHiddenFolders("tout")).toEqual({});
    expect(asHiddenFolders({ a1: null })).toEqual({});
  });

  it("masque puis réaffiche un chemin et persiste le réglage", () => {
    const { result } = mount();

    act(() => result.current.setFolderHidden("a1", "Projets", true));
    expect(result.current.hiddenFolders).toEqual({ a1: ["Projets"] });
    expect(stored().hiddenFolders).toEqual({ a1: ["Projets"] });

    act(() => result.current.setFolderHidden("a1", "Projets", true));
    expect(result.current.hiddenFolders).toEqual({ a1: ["Projets"] });

    act(() => result.current.setFolderHidden("a2", "Projets", true));
    expect(result.current.hiddenFolders).toEqual({ a1: ["Projets"], a2: ["Projets"] });

    act(() => result.current.setFolderHidden("a1", "Projets", false));
    expect(result.current.hiddenFolders).toEqual({ a2: ["Projets"] });
    expect(stored().hiddenFolders).toEqual({ a2: ["Projets"] });
  });
});

describe("préférences · notifications", () => {
  it("démarre notifiées, tous comptes confondus, avec rappel dix minutes avant", () => {
    const { result } = mount();
    expect(result.current.notifications).toEqual(DEFAULT_NOTIFICATIONS);
    expect(DEFAULT_NOTIFICATIONS).toEqual({
      enabled: true,
      accounts: {},
      calendar: true,
      calendarMinutes: 10,
    });
  });

  it("relit une configuration complète", () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({
        notifications: { enabled: false, accounts: { a1: false, a2: true }, calendar: false, calendarMinutes: 30 },
      }),
    );

    expect(mount().result.current.notifications).toEqual({
      enabled: false,
      accounts: { a1: false, a2: true },
      calendar: false,
      calendarMinutes: 30,
    });
  });

  it("ignore les valeurs invalides et borne le délai", () => {
    expect(asNotifications(undefined)).toEqual(DEFAULT_NOTIFICATIONS);
    expect(asNotifications("tout")).toEqual(DEFAULT_NOTIFICATIONS);
    expect(asNotifications({ enabled: "oui", accounts: { a1: "non", a2: false }, calendar: 1 })).toEqual({
      enabled: true,
      accounts: { a2: false },
      calendar: true,
      calendarMinutes: 10,
    });
    expect(asNotifications({ calendarMinutes: -5 }).calendarMinutes).toBe(10);
    expect(asNotifications({ calendarMinutes: 12.4 }).calendarMinutes).toBe(12);
    expect(asNotifications({ calendarMinutes: 999 }).calendarMinutes).toBe(120);
  });

  it("un compte absent suit l'interrupteur général", () => {
    const open: NotificationPrefs = { ...DEFAULT_NOTIFICATIONS, accounts: { a1: false } };
    expect(notificationsForAccount(open, "a1")).toBe(false);
    expect(notificationsForAccount(open, "a2")).toBe(true);
    expect(notificationsForAccount(open, null)).toBe(true);
    expect(notificationsForAccount({ ...open, enabled: false }, "a2")).toBe(false);
    expect(notificationsForAccount({ ...open, enabled: false }, "a1")).toBe(false);
  });

  it("coupe puis rétablit les notifications d'un compte et persiste", () => {
    const { result } = mount();

    act(() => result.current.setAccountNotification("a1", false));
    expect(result.current.notifications.accounts).toEqual({ a1: false });
    expect(stored().notifications).toMatchObject({ accounts: { a1: false } });

    act(() => result.current.setAccountNotification("a1", true));
    expect(result.current.notifications.accounts).toEqual({ a1: true });

    act(() => result.current.setNotifications({ enabled: false, calendarMinutes: 15 }));
    expect(result.current.notifications.enabled).toBe(false);
    expect(result.current.notifications.calendarMinutes).toBe(15);
    expect(stored().notifications).toMatchObject({ enabled: false, calendarMinutes: 15 });
  });
});
