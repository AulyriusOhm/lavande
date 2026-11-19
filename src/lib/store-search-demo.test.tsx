import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MAILS, normalize } from "@/lib/mail";
import type { Mail } from "@/lib/mail";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
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

const ids = (mails: Mail[]) => mails.map((mail) => mail.id).sort();
const expected = (keep: (mail: Mail) => boolean) => ids(MAILS.filter(keep));

describe("recherche démo · mêmes critères que le démon", () => {
  it("applique from: comme le démon", async () => {
    const { result } = mount();
    const needle = "from:camille";
    const answer = MAILS.filter((mail) => normalize(`${mail.name} ${mail.email}`).includes("camille"));

    let found: Mail[] = [];
    await act(async () => {
      found = await result.current.searchMails(needle);
    });

    expect(ids(found)).toEqual(ids(answer));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((mail) => normalize(`${mail.name} ${mail.email}`).includes("camille"))).toBe(true);
  });

  it("applique is:unread", async () => {
    const { result } = mount();

    let found: Mail[] = [];
    await act(async () => {
      found = await result.current.searchMails("is:unread");
    });

    expect(found.every((mail) => mail.unread)).toBe(true);
    expect(ids(found)).toEqual(expected((mail) => mail.unread));
  });

  it("applique in:sent au rôle du dossier", async () => {
    const { result } = mount();

    let found: Mail[] = [];
    await act(async () => {
      found = await result.current.searchMails("in:sent");
    });

    expect(found.every((mail) => mail.folder === "sent")).toBe(true);
    expect(found.length).toBeGreaterThan(0);
  });

  it("applique une borne de date", async () => {
    const { result } = mount();

    let found: Mail[] = [];
    await act(async () => {
      found = await result.current.searchMails("after:2000-01-01 before:2000-01-02");
    });

    expect(found).toEqual([]);
  });

  it("garde les filtres du scope en plus du texte", async () => {
    const { result } = mount();
    const subject = MAILS.find((mail) => mail.folder === "inbox")!.subject.split(" ")[0];

    let found: Mail[] = [];
    await act(async () => {
      found = await result.current.searchMails(subject, { unread: true });
    });

    expect(found.every((mail) => mail.unread)).toBe(true);
  });

  it("ne rend rien pour une requête sans critère", async () => {
    const { result } = mount();

    await act(async () => {
      await expect(result.current.searchMails("  ")).resolves.toEqual([]);
    });

    expect(result.current.searchHasMore).toBe(false);
  });
});
