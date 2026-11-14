import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

// Démo vitrine : le flag est posé avant l'évaluation des modules, comme dans un
// build `VITE_MAIL_BACKEND=demo VITE_DEMO_READONLY=1 vite build`.
vi.hoisted(() => {
  vi.stubEnv("VITE_MAIL_BACKEND", "demo");
  vi.stubEnv("VITE_DEMO_READONLY", "1");
});

import { MAILS } from "@/lib/mail";
import { demoReadOnly, mailMode } from "@/lib/mail-backend";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider, usePrefs } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { createMemoryStorage } from "@/lib/sync/storage";

const NOTICE = "Démo en lecture seule";

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

const folderOf = (mails: { id: string; folder: string }[], id: string) =>
  mails.find((mail) => mail.id === id)?.folder;

beforeEach(() => {
  window.localStorage.clear();
});

describe("démo lecture seule", () => {
  it("active le flag seulement avec le mode démo et VITE_DEMO_READONLY", () => {
    expect(mailMode()).toBe("demo");
    expect(demoReadOnly).toBe(true);

    const { result } = mount();
    expect(result.current.readOnly).toBe(true);
    expect(result.current.mails).toHaveLength(MAILS.length);
  });

  it("laisse la navigation et la lecture intactes", () => {
    const { result } = mount();
    const mail = result.current.mails.find((entry) => entry.folder === "inbox")!;

    act(() => {
      result.current.setFolder("archive");
    });
    expect(result.current.folder).toBe("archive");

    act(() => {
      result.current.openMessage(mail);
    });
    expect(result.current.openMail?.id).toBe(mail.id);
    expect(result.current.notices).toHaveLength(0);
  });

  it("n'archive pas : mutation refusée et notification", () => {
    const { result } = mount();
    const mail = result.current.mails.find((entry) => entry.folder === "inbox")!;

    act(() => {
      result.current.mailAction("archive", mail);
    });

    expect(folderOf(result.current.mails, mail.id)).toBe("inbox");
    expect(result.current.notices.at(-1)?.message).toBe(NOTICE);
  });

  it("ne supprime pas : corbeille et vidage refusés", () => {
    const { result } = mount();
    const inbox = result.current.mails.find((entry) => entry.folder === "inbox")!;
    const before = result.current.mails.length;

    act(() => {
      result.current.mailAction("delete", inbox);
    });
    expect(folderOf(result.current.mails, inbox.id)).toBe("inbox");

    act(() => {
      result.current.emptyTrash();
    });
    expect(result.current.mails).toHaveLength(before);
    expect(result.current.notices.at(-1)?.message).toBe(NOTICE);
  });

  it("n'étoile pas et ne change pas l'état lu", () => {
    const { result } = mount();
    const mail = result.current.mails.find((entry) => entry.folder === "inbox")!;

    act(() => {
      result.current.toggleStar(mail.id);
    });
    act(() => {
      result.current.mailAction("read", mail);
    });

    const current = result.current.mails.find((entry) => entry.id === mail.id)!;
    expect(current.starred).toBe(mail.starred);
    expect(current.unread).toBe(mail.unread);
  });

  it("ne restaure pas et ne renvoie pas en boîte de réception", () => {
    const { result } = mount();
    const spam = result.current.mails.find((entry) => entry.folder === "spam")!;
    const archive = result.current.mails.find((entry) => entry.folder === "archive")!;

    act(() => {
      result.current.restoreMail(spam);
    });
    expect(folderOf(result.current.mails, spam.id)).toBe("spam");

    act(() => {
      result.current.moveToInbox(archive);
    });
    expect(folderOf(result.current.mails, archive.id)).toBe("archive");
    expect(result.current.notices.at(-1)?.message).toBe(NOTICE);
  });

  it("bloque la rédaction : composer, réponse, brouillon, envoi", async () => {
    const { result } = mount();
    const mail = result.current.mails.find((entry) => entry.folder === "inbox")!;

    act(() => {
      result.current.openComposer();
    });
    expect(result.current.composeOpen).toBe(false);
    expect(result.current.composeDraft).toBeNull();

    act(() => {
      result.current.startBlankDraft();
    });
    expect(result.current.composeDraft).toBeNull();

    act(() => {
      result.current.replyTo(mail);
      result.current.forwardMail(mail);
    });
    expect(result.current.composeOpen).toBe(false);

    act(() => {
      result.current.resumeCompose();
    });
    expect(result.current.composeOpen).toBe(false);

    let saved = true;
    await act(async () => {
      saved = await result.current.saveToDrafts(result.current.composeDraft ?? ({} as never));
    });
    expect(saved).toBe(false);
    expect(result.current.notices.at(-1)?.message).toBe(NOTICE);
  });

  it("bloque la synchronisation, la connexion et la suppression de compte", async () => {
    const { result } = mount();

    act(() => {
      result.current.syncFolder();
    });
    expect(result.current.notices.at(-1)?.message).toBe(NOTICE);

    act(() => {
      result.current.openConnect();
    });
    expect(result.current.connectOpen).toBe(false);

    await act(async () => {
      const created = await result.current.createAccount({
        email: "demo@exemple.tld",
        label: "Démo",
        incoming: { host: "imap.exemple.tld", port: 993, encryption: "tls" },
        outgoing: { host: "smtp.exemple.tld", port: 465, encryption: "tls" },
        username: "demo@exemple.tld",
        password: "secret",
      });
      expect(created).toBe("");
    });
    expect(result.current.accounts).toHaveLength(3);

    const account = result.current.accounts[0];
    act(() => {
      result.current.askRemoveAccount(account);
    });
    expect(result.current.removeTarget).toBeNull();
  });

  it("bloque les tâches et les suggestions de la planification", () => {
    const { result } = mount();
    const task = result.current.tasks[0];
    const suggestion = result.current.suggestions[0];

    act(() => {
      result.current.setTasks((current) =>
        current.map((entry) => (entry.id === task.id ? { ...entry, state: "done" as const } : entry)),
      );
    });
    expect(result.current.tasks.find((entry) => entry.id === task.id)?.state).toBe(task.state);

    act(() => {
      result.current.addSuggestion(suggestion);
    });
    expect(result.current.suggestions.some((entry) => entry.id === suggestion.id)).toBe(true);
    expect(result.current.notices.at(-1)?.message).toBe(NOTICE);

    act(() => {
      result.current.dismissSuggestion(suggestion);
    });
    expect(result.current.suggestions.some((entry) => entry.id === suggestion.id)).toBe(true);
  });

  it("bloque les événements de l'agenda", () => {
    const { result } = mount();
    const before = result.current.events.length;

    act(() => {
      result.current.setEvents((current) => [
        ...current,
        {
          id: "demo:test",
          date: "2026-03-15",
          start: "09:00",
          end: "10:00",
          title: "Événement de test",
          calendar: "Pro",
        },
      ]);
    });

    expect(result.current.events).toHaveLength(before);
  });
});

describe("réglages en lecture seule", () => {
  it("n'écrit aucune préférence", () => {
    const { result } = renderHook(() => usePrefs(), {
      wrapper: ({ children }: { children: ReactNode }) => <PrefsProvider>{children}</PrefsProvider>,
    });
    const before = result.current.summary;

    act(() => {
      result.current.setSummary({ enabled: !before.enabled });
      result.current.setLlm({ endpoint: "https://exemple.tld/v1" });
      result.current.setCalendarEnabled(!result.current.calendarEnabled);
      result.current.setNotifications({ enabled: !result.current.notifications.enabled });
    });

    expect(result.current.summary).toEqual(before);
    expect(result.current.llm.endpoint).toBe("");
    expect(result.current.calendarEnabled).toBe(true);
  });
});
