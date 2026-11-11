import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  availableShortcuts,
  defineShortcuts,
  detectModKey,
  isEditableTarget,
  keyLabels,
  matchesShortcut,
  parseKeys,
  resolveShortcut,
  shortcutKey,
  useShortcuts,
  type Shortcut,
  type ShortcutEvent,
} from "@/lib/shortcuts";

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
const LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/156.0 Safari/537.36";

const IDLE = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: null };

function event(key: string, overrides: Partial<ShortcutEvent> = {}): ShortcutEvent {
  return { key, ...IDLE, ...overrides };
}

function shortcut(overrides: Partial<Shortcut> = {}): Shortcut {
  return {
    id: "test",
    keys: "mod+k",
    group: "Actions",
    label: "Rechercher",
    description: "Chercher dans tous les comptes",
    run: () => {},
    ...overrides,
  };
}

function typeInWindow(init: KeyboardEventInit): KeyboardEvent {
  const keyboardEvent = new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init });
  window.dispatchEvent(keyboardEvent);
  return keyboardEvent;
}

describe("raccourcis · analyse des touches", () => {
  it("décompose modificateurs et touche finale", () => {
    expect(parseKeys("mod+k")).toEqual({ mod: true, shift: false, alt: false, key: "k" });
    expect(parseKeys("cmd+Shift+n")).toEqual({ mod: true, shift: true, alt: false, key: "n" });
    expect(parseKeys("?")).toEqual({ mod: false, shift: false, alt: false, key: "?" });
    expect(parseKeys("mod+,")).toEqual({ mod: true, shift: false, alt: false, key: "," });
  });

  it("refuse un modificateur ou une touche inconnus", () => {
    expect(() => parseKeys("hyper+k")).toThrow(/Modificateur inconnu/);
    expect(() => parseKeys("mod+")).toThrow(/Raccourci invalide/);
  });

  it("normalise les alias pour comparer les conflits", () => {
    expect(shortcutKey("cmd+K")).toBe("mod+k");
    expect(shortcutKey("shift+mod+n")).toBe("mod+shift+n");
    expect(shortcutKey("control+,")).toBe("mod+,");
  });

  it("refuse deux raccourcis identiques", () => {
    expect(() => defineShortcuts([shortcut(), shortcut({ id: "double", keys: "ctrl+k" })])).toThrow(
      /conflit/,
    );
    const list = [shortcut(), shortcut({ id: "compose", keys: "mod+n" })];
    expect(defineShortcuts(list).map((entry) => entry.id)).toEqual(["test", "compose"]);
  });
});

describe("raccourcis · plateforme", () => {
  it("Cmd sur Mac, Ctrl ailleurs", () => {
    expect(detectModKey(MAC_UA, "MacIntel")).toBe("meta");
    expect(detectModKey(LINUX_UA, "Linux x86_64")).toBe("ctrl");
    expect(detectModKey("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)", "iPhone")).toBe("meta");
  });

  it("affiche les touches selon la plateforme", () => {
    expect(keyLabels("mod+k", "meta")).toEqual(["⌘", "K"]);
    expect(keyLabels("mod+k", "ctrl")).toEqual(["Ctrl", "K"]);
    expect(keyLabels("mod+shift+n", "meta")).toEqual(["⌘", "⇧", "N"]);
    expect(keyLabels("mod+shift+n", "ctrl")).toEqual(["Ctrl", "Maj", "N"]);
    expect(keyLabels("?", "ctrl")).toEqual(["?"]);
  });
});

describe("raccourcis · correspondance", () => {
  it("suit la touche de plateforme", () => {
    expect(matchesShortcut(event("k", { ctrlKey: true }), "mod+k", "ctrl")).toBe(true);
    expect(matchesShortcut(event("k", { metaKey: true }), "mod+k", "meta")).toBe(true);
  });

  it("ignore le modificateur de l'autre plateforme", () => {
    expect(matchesShortcut(event("k", { ctrlKey: true }), "mod+k", "meta")).toBe(false);
    expect(matchesShortcut(event("k", { metaKey: true }), "mod+k", "ctrl")).toBe(false);
  });

  it("exige le modificateur et l'absence de modificateurs parasites", () => {
    expect(matchesShortcut(event("k"), "mod+k", "ctrl")).toBe(false);
    expect(matchesShortcut(event("k", { ctrlKey: true, altKey: true }), "mod+k", "ctrl")).toBe(false);
    expect(matchesShortcut(event("K", { ctrlKey: true }), "mod+k", "ctrl")).toBe(true);
  });

  it("distingue Maj", () => {
    expect(matchesShortcut(event("N", { ctrlKey: true, shiftKey: true }), "mod+shift+n", "ctrl")).toBe(true);
    expect(matchesShortcut(event("n", { ctrlKey: true }), "mod+shift+n", "ctrl")).toBe(false);
    expect(matchesShortcut(event("N", { ctrlKey: true, shiftKey: true }), "mod+n", "ctrl")).toBe(false);
  });

  it("tolère le Maj implicite des symboles", () => {
    expect(matchesShortcut(event("?", { shiftKey: true }), "?", "ctrl")).toBe(true);
    expect(matchesShortcut(event("/", { ctrlKey: true }), "mod+/", "ctrl")).toBe(true);
  });

  it("accepte la rangée de chiffres AZERTY", () => {
    expect(matchesShortcut(event("&"), "mod+1", "ctrl")).toBe(false);
    expect(matchesShortcut(event("&", { ctrlKey: true }), "mod+1", "ctrl")).toBe(true);
    expect(matchesShortcut(event("é", { ctrlKey: true }), "mod+2", "ctrl")).toBe(true);
  });

  it("reconnaît une zone de saisie", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const nested = document.createElement("span");
    editable.append(nested);
    const plain = document.createElement("div");

    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(textarea)).toBe(true);
    expect(isEditableTarget(select)).toBe(true);
    expect(isEditableTarget(editable)).toBe(true);
    expect(isEditableTarget(nested)).toBe(true);
    expect(isEditableTarget(plain)).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("raccourcis · résolution", () => {
  const input = document.createElement("input");

  it("bloque la saisie dans un champ, sauf autorisation explicite", () => {
    const strict = shortcut();
    const allowed = shortcut({ id: "global", allowInInput: true });

    expect(resolveShortcut([strict], event("k", { ctrlKey: true, target: input }), "ctrl")).toBeNull();
    expect(
      resolveShortcut([allowed], event("k", { ctrlKey: true, target: input }), "ctrl")?.id,
    ).toBe("global");
    expect(resolveShortcut([strict], event("k", { ctrlKey: true }), "ctrl")?.id).toBe("test");
  });

  it("respecte la condition d'activation", () => {
    const gated = shortcut({ when: () => false });
    expect(resolveShortcut([gated], event("k", { ctrlKey: true }), "ctrl")).toBeNull();
    expect(availableShortcuts([gated, shortcut({ id: "open" })])).toHaveLength(1);
  });

  it("retient la première définition correspondante", () => {
    const first = shortcut({ id: "first", allowInInput: true });
    const second = shortcut({ id: "second", allowInInput: true });
    expect(resolveShortcut([first, second], event("k", { ctrlKey: true }), "ctrl")?.id).toBe("first");
  });
});

describe("raccourcis · branchement clavier", () => {
  const mod = detectModKey();
  const modifiers: KeyboardEventInit = mod === "meta" ? { metaKey: true } : { ctrlKey: true };

  it("déclenche l'action et consomme l'évènement", () => {
    const run = vi.fn();
    renderHook(() => useShortcuts([shortcut({ run, allowInInput: true })]));

    const keyboardEvent = typeInWindow({ key: "k", ...modifiers });
    expect(run).toHaveBeenCalledTimes(1);
    expect(keyboardEvent.defaultPrevented).toBe(true);
  });

  it("ne déclenche rien depuis un champ de saisie non autorisé", () => {
    const run = vi.fn();
    const field = document.createElement("input");
    document.body.append(field);
    renderHook(() => useShortcuts([shortcut({ run })]));

    field.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true, ...modifiers }));
    expect(run).not.toHaveBeenCalled();

    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "?", shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(run).not.toHaveBeenCalled();
    field.remove();
  });

  it("ignore un évènement déjà consommé, une répétition ou un raccourci désactivé", () => {
    const run = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useShortcuts([shortcut({ run })], enabled),
      { initialProps: { enabled: true } },
    );

    typeInWindow({ key: "k", ...modifiers, repeat: true });
    expect(run).not.toHaveBeenCalled();

    rerender({ enabled: false });
    typeInWindow({ key: "k", ...modifiers });
    expect(run).not.toHaveBeenCalled();

    rerender({ enabled: true });
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", ...modifiers, cancelable: true }),
      );
    });
    expect(run).toHaveBeenCalledTimes(1);

    const consumed = new KeyboardEvent("keydown", { key: "k", ...modifiers, cancelable: true });
    consumed.preventDefault();
    window.dispatchEvent(consumed);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retire l'écoute au démontage", () => {
    const run = vi.fn();
    const { unmount } = renderHook(() => useShortcuts([shortcut({ run })]));
    unmount();

    typeInWindow({ key: "k", ...modifiers });
    expect(run).not.toHaveBeenCalled();
  });

  it("suit la dernière liste fournie", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ run }: { run: () => void }) => useShortcuts([shortcut({ run })]),
      { initialProps: { run: first } },
    );

    rerender({ run: second });
    typeInWindow({ key: "k", ...modifiers });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
