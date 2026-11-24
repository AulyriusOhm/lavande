import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { DesktopInbox } from "@/desktop/inbox";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { PgpKey } from "@/lib/pgp";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const SECRET: PgpKey = {
  fingerprint: "9F3A71C4D0B85E624A1788CD2B907F31AE456C08",
  key_id: "2B907F31AE456C08",
  user_id: "Roman <roman@lavande.mail>",
  name: "Roman",
  email: "roman@lavande.mail",
  algorithm: "Curve25519 · Ed25519",
  created_at: "2026-03-12T10:00:00Z",
  expires_at: "2028-03-12T10:00:00Z",
  has_secret: true,
  revoked: false,
  expired: false,
};

const CONTACT: PgpKey = {
  ...SECRET,
  fingerprint: "4B710E9C55A2B3D86F142C9077DE1A3B09F522C7",
  key_id: "77DE1A3B09F522C7",
  user_id: "Camille <camille@studio-lilas.fr>",
  name: "Camille",
  email: "camille@studio-lilas.fr",
  expires_at: "2024-11-04T09:30:00Z",
  has_secret: false,
};

function stubKeys(keys: PgpKey[] | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (!keys) throw new TypeError("network down");
      return {
        ok: true,
        status: 200,
        json: async () => ({ keys }),
        text: async () => JSON.stringify({ keys }),
      } as unknown as Response;
    }),
  );
}

function mount(children: ReactNode) {
  return render(
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>{children}</MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>,
  );
}

function openSection(label: string) {
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Sections des réglages" })).getByRole("button", { name: label }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("Réglages · Sécurité & PGP", () => {
  it("affiche la clé secrète réelle et la liste des clés", async () => {
    stubKeys([SECRET, CONTACT]);
    mount(<DesktopSettings />);
    openSection("Sécurité & PGP");

    await waitFor(() =>
      expect(screen.getByText("9F3A 71C4 D0B8 5E62 4A17 88CD 2B90 7F31 AE45 6C08")).toBeTruthy(),
    );
    expect(screen.getAllByText("Roman").length).toBe(2);
    expect(screen.getByText("12/03/2026")).toBeTruthy();
    expect(screen.getByText("2B907F31AE456C08")).toBeTruthy();
    expect(screen.getAllByText("clé valide").length).toBe(2);
    expect(screen.getByText("publique")).toBeTruthy();
    expect(screen.getByText("secrète")).toBeTruthy();
  });

  it("propose de générer une clé quand le service est injoignable", async () => {
    stubKeys(null);
    mount(<DesktopSettings />);
    openSection("Sécurité & PGP");

    await waitFor(() => expect(screen.getByText("Générer ma clé")).toBeTruthy());
    expect(screen.getByText("Aucune clé secrète")).toBeTruthy();
    expect(screen.getByText("network down")).toBeTruthy();
    expect(screen.getByText("Réessayer")).toBeTruthy();
  });
});

describe("Boîte de réception · panneau PGP", () => {
  it("affiche la clé secrète quand elle existe", async () => {
    stubKeys([SECRET]);
    mount(<DesktopInbox onOpenSearch={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Expire le 12\/03\/2028/)).toBeTruthy());
    expect(screen.getByText(/^Roman ·$/)).toBeTruthy();
  });

  it("reste discret quand aucune clé n'est disponible", async () => {
    stubKeys(null);
    mount(<DesktopInbox onOpenSearch={() => {}} />);

    await waitFor(() => expect(screen.getByText("Aucune clé PGP")).toBeTruthy());
  });
});
