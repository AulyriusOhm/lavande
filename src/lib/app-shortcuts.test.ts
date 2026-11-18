import { describe, expect, it, vi } from "vitest";
import {
  appShortcuts,
  shortcutCatalog,
  type AppShortcutActions,
  type MailNavigation,
} from "@/lib/app-shortcuts";
import { detectModKey, resolveShortcut, type ShortcutEvent } from "@/lib/shortcuts";

const mod = detectModKey();
const MODIFIER = mod === "meta" ? { metaKey: true } : { ctrlKey: true };
const IDLE = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: null };

const press = (key: string, overrides: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
  key,
  ...IDLE,
  ...overrides,
});

function navigation(overrides: Partial<MailNavigation> = {}): MailNavigation {
  return {
    canMove: () => true,
    canOpen: () => true,
    canAct: () => true,
    current: () => null,
    next: vi.fn(),
    previous: vi.fn(),
    open: vi.fn(),
    selectAll: vi.fn(),
    deleteSelected: vi.fn(),
    archiveSelected: vi.fn(),
    toggleStarSelected: vi.fn(),
    toggleReadSelected: vi.fn(),
    replySelected: vi.fn(),
    forwardSelected: vi.fn(),
    ...overrides,
  };
}

function actions(mail: MailNavigation): AppShortcutActions {
  return {
    navigate: vi.fn(),
    calendarEnabled: true,
    planningEnabled: true,
    calendarActive: false,
    compose: vi.fn(),
    newTask: vi.fn(),
    newEvent: vi.fn(),
    search: vi.fn(),
    toggleHelp: vi.fn(),
    mail,
  };
}

describe("raccourcis · navigation des mails", () => {
  it("déplace la sélection avec les flèches et les alias vim, ouvre avec Entrée", () => {
    const mail = navigation();
    const list = appShortcuts(actions(mail));

    expect(resolveShortcut(list, press("ArrowDown"), mod)?.id).toBe("mail-next");
    expect(resolveShortcut(list, press("ArrowUp"), mod)?.id).toBe("mail-previous");
    expect(resolveShortcut(list, press("j"), mod)?.id).toBe("mail-next-vim");
    expect(resolveShortcut(list, press("k"), mod)?.id).toBe("mail-previous-vim");
    expect(resolveShortcut(list, press("Enter"), mod)?.id).toBe("mail-open");

    resolveShortcut(list, press("ArrowDown"), mod)?.run();
    resolveShortcut(list, press("Enter"), mod)?.run();
    expect(mail.next).toHaveBeenCalledTimes(1);
    expect(mail.open).toHaveBeenCalledTimes(1);
  });

  it("ne navigue pas quand la liste ou la sélection est indisponible", () => {
    const list = appShortcuts(actions(navigation({ canMove: () => false, canOpen: () => false })));

    expect(resolveShortcut(list, press("ArrowDown"), mod)).toBeNull();
    expect(resolveShortcut(list, press("j"), mod)).toBeNull();
    expect(resolveShortcut(list, press("Enter"), mod)).toBeNull();
  });

  it("ignore la navigation depuis un champ de saisie", () => {
    const mail = navigation();
    const list = appShortcuts(actions(mail));
    const field = document.createElement("input");

    expect(resolveShortcut(list, press("ArrowDown", { target: field }), mod)).toBeNull();
    expect(resolveShortcut(list, press("j", { target: field }), mod)).toBeNull();
    expect(resolveShortcut(list, press("Enter", { target: field }), mod)).toBeNull();
  });

  it("laisse les raccourcis existants intacts", () => {
    const list = appShortcuts(actions(navigation()));

    expect(resolveShortcut(list, press("k", MODIFIER), mod)?.id).toBe("search");
    expect(resolveShortcut(list, press("n", MODIFIER), mod)?.id).toBe("compose");
    expect(resolveShortcut(list, press("N", { ...MODIFIER, shiftKey: true }), mod)?.id).toBe("create");
    expect(resolveShortcut(list, press("2", MODIFIER), mod)?.id).toBe("view-calendar");
    expect(resolveShortcut(list, press("?", { shiftKey: true }), mod)?.id).toBe("help-question");
    expect(resolveShortcut(list, press("/", MODIFIER), mod)?.id).toBe("help");
    expect(resolveShortcut(list, press(",", MODIFIER), mod)?.id).toBe("settings-shortcut");
  });
});

describe("raccourcis · actions sur le message", () => {
  const shifted = { ...MODIFIER, shiftKey: true };

  it("associe chaque action à sa combinaison", () => {
    const mail = navigation();
    const list = appShortcuts(actions(mail));

    expect(resolveShortcut(list, press("Delete"), mod)?.id).toBe("mail-delete");
    expect(resolveShortcut(list, press("e", MODIFIER), mod)?.id).toBe("mail-archive");
    expect(resolveShortcut(list, press("S", shifted), mod)?.id).toBe("mail-star");
    expect(resolveShortcut(list, press("U", shifted), mod)?.id).toBe("mail-read");
    expect(resolveShortcut(list, press("R", shifted), mod)?.id).toBe("mail-reply");
    expect(resolveShortcut(list, press("F", shifted), mod)?.id).toBe("mail-forward");

    resolveShortcut(list, press("Delete"), mod)?.run();
    resolveShortcut(list, press("e", MODIFIER), mod)?.run();
    resolveShortcut(list, press("S", shifted), mod)?.run();
    resolveShortcut(list, press("U", shifted), mod)?.run();
    resolveShortcut(list, press("R", shifted), mod)?.run();
    resolveShortcut(list, press("F", shifted), mod)?.run();

    expect(mail.deleteSelected).toHaveBeenCalledTimes(1);
    expect(mail.archiveSelected).toHaveBeenCalledTimes(1);
    expect(mail.toggleStarSelected).toHaveBeenCalledTimes(1);
    expect(mail.toggleReadSelected).toHaveBeenCalledTimes(1);
    expect(mail.replySelected).toHaveBeenCalledTimes(1);
    expect(mail.forwardSelected).toHaveBeenCalledTimes(1);
  });

  it("ne déclenche rien sans message actif", () => {
    const mail = navigation({ canAct: () => false });
    const list = appShortcuts(actions(mail));

    expect(resolveShortcut(list, press("Delete"), mod)).toBeNull();
    expect(resolveShortcut(list, press("e", MODIFIER), mod)).toBeNull();
    expect(resolveShortcut(list, press("S", shifted), mod)).toBeNull();
    expect(resolveShortcut(list, press("U", shifted), mod)).toBeNull();
    expect(resolveShortcut(list, press("R", shifted), mod)).toBeNull();
    expect(resolveShortcut(list, press("F", shifted), mod)).toBeNull();
  });

  it("ne déclenche rien depuis un champ de saisie", () => {
    const mail = navigation();
    const list = appShortcuts(actions(mail));
    const field = document.createElement("input");

    expect(resolveShortcut(list, press("Delete", { ...MODIFIER, target: field }), mod)).toBeNull();
    expect(resolveShortcut(list, press("e", { ...MODIFIER, target: field }), mod)).toBeNull();
    expect(resolveShortcut(list, press("S", { ...shifted, target: field }), mod)).toBeNull();
  });

  it("nomme les combinaisons d'action dans le catalogue des réglages", () => {
    const list = shortcutCatalog();
    const ids = list.map((entry) => entry.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        "mail-select-all",
        "mail-delete",
        "mail-archive",
        "mail-star",
        "mail-read",
        "mail-reply",
        "mail-forward",
      ]),
    );
    expect(
      list
        .filter((entry) => entry.group === "Actions sur le message")
        .map((entry) => entry.keys),
    ).toEqual([
      "mod+a",
      "delete",
      "mod+e",
      "mod+shift+s",
      "mod+shift+u",
      "mod+shift+r",
      "mod+shift+f",
    ]);
  });
});
