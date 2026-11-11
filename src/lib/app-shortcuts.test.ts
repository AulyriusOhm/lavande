import { describe, expect, it, vi } from "vitest";
import { appShortcuts, type AppShortcutActions, type MailNavigation } from "@/lib/app-shortcuts";
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
    next: vi.fn(),
    previous: vi.fn(),
    open: vi.fn(),
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
