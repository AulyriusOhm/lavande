import { describe, expect, it } from "vitest";
import type { ApiAccount } from "@/lib/api";
import {
  GOOGLE_WINDOW_FUTURE_DAYS,
  GOOGLE_WINDOW_PAST_DAYS,
  googleAccounts,
  googleWindow,
  isGoogleAccount,
} from "@/lib/gcal";

const account = (over: Partial<ApiAccount> = {}): ApiAccount => ({
  id: "a1",
  label: "Perso",
  email: "roman@lavande.mail",
  username: "roman",
  imap: { host: "imap.lavande.mail", port: 993, encryption: "tls" },
  smtp: { host: "smtp.lavande.mail", port: 465, encryption: "tls" },
  folders: 2,
  ...over,
});

const gmail = (over: Partial<ApiAccount> = {}): ApiAccount =>
  account({
    id: "gmail",
    label: "Gmail",
    email: "roman.lanro@gmail.com",
    imap: { host: "imap.gmail.com", port: 993, encryption: "tls" },
    smtp: { host: "smtp.gmail.com", port: 465, encryption: "tls" },
    ...over,
  });

describe("gcal · détection d'un compte Google", () => {
  it("reconnaît un compte dont les hôtes sont ceux de Gmail", () => {
    expect(isGoogleAccount(gmail())).toBe(true);
    expect(isGoogleAccount(gmail({ email: "contact@studio-lilas.fr" }))).toBe(true);
  });

  it("reconnaît un hôte Workspace sur un domaine qui n'est pas gmail.com", () => {
    expect(
      isGoogleAccount(
        account({
          email: "roman@studio-lilas.fr",
          imap: { host: "imap.gmail.com", port: 993, encryption: "tls" },
        }),
      ),
    ).toBe(true);
  });

  it("se fie au point d'échange OAuth2 Google quand la configuration le donne", () => {
    expect(
      isGoogleAccount({
        email: "roman@studio-lilas.fr",
        imap: { host: "imap.studio-lilas.fr" },
        auth: { kind: "oauth2", token_endpoint: "https://oauth2.googleapis.com/token" },
      }),
    ).toBe(true);
  });

  it("ne prend pas un point d'échange OAuth2 étranger pour Google", () => {
    expect(
      isGoogleAccount({
        email: "roman@studio-lilas.fr",
        imap: { host: "outlook.office365.com" },
        smtp: { host: "smtp.office365.com" },
        auth: { kind: "oauth2", token_endpoint: "https://login.microsoftonline.com/token" },
      }),
    ).toBe(false);
  });

  it("garde l'adresse Gmail comme dernier indice", () => {
    expect(isGoogleAccount({ email: "roman.lanro@googlemail.com" })).toBe(true);
  });

  it("laisse un compte IMAP ordinaire de côté", () => {
    expect(isGoogleAccount(account())).toBe(false);
    expect(isGoogleAccount(account({ email: "roman@ovh.tld" }))).toBe(false);
    expect(isGoogleAccount({})).toBe(false);
  });

  it("ne garde que les comptes Google d'une liste", () => {
    expect(googleAccounts([account(), gmail()]).map((entry) => entry.id)).toEqual(["gmail"]);
  });
});

describe("gcal · fenêtre relue", () => {
  it("borne la demande à trois mois passés et un an à venir", () => {
    const now = new Date(2026, 2, 15, 18, 30);
    const window = googleWindow(now);

    expect(window.time_min).toBe(new Date(2025, 11, 15).toISOString());
    expect(window.time_max).toBe(new Date(2027, 2, 15).toISOString());
    const span = Date.parse(window.time_max) - Date.parse(window.time_min);
    expect(Math.round(span / 86_400_000)).toBe(GOOGLE_WINDOW_PAST_DAYS + GOOGLE_WINDOW_FUTURE_DAYS);
  });
});
