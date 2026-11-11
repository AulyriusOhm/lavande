import { useEffect, useMemo, useRef } from "react";

export type ModKey = "meta" | "ctrl";

export type ShortcutGroup = "Navigation" | "Actions" | "Aide";

export type Shortcut = {
  id: string;
  keys: string;
  label: string;
  description: string;
  group: ShortcutGroup;
  run: () => void;
  when?: () => boolean;
  allowInInput?: boolean;
  allowRepeat?: boolean;
};

export type ShortcutEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
};

type ParsedKeys = { mod: boolean; shift: boolean; alt: boolean; key: string };

const MODIFIERS: Record<string, "mod" | "shift" | "alt"> = {
  mod: "mod",
  cmd: "mod",
  ctrl: "mod",
  control: "mod",
  meta: "mod",
  shift: "shift",
  alt: "alt",
  option: "alt",
};

// Rangée de chiffres non shiftée sur AZERTY : ⌘1 physique arrive en « & ».
const AZERTY_DIGITS: Record<string, string> = {
  "&": "1",
  é: "2",
  '"': "3",
  "'": "4",
  "(": "5",
  "-": "6",
  è: "7",
  _: "8",
  ç: "9",
  à: "0",
};

const TEXT_FIELDS = new Set(["input", "textarea", "select"]);

const KEY_LABELS: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  enter: "Entrée",
  escape: "Échap",
};

export function parseKeys(keys: string): ParsedKeys {
  const tokens = keys.split("+").map((token) => token.trim());
  const key = tokens.pop() ?? "";
  if (!key || MODIFIERS[key.toLowerCase()]) {
    throw new Error(`Raccourci invalide : "${keys}"`);
  }

  const parsed: ParsedKeys = { mod: false, shift: false, alt: false, key: key.toLowerCase() };
  for (const token of tokens.filter(Boolean)) {
    const modifier = MODIFIERS[token.toLowerCase()];
    if (!modifier) throw new Error(`Modificateur inconnu dans "${keys}" : "${token}"`);
    parsed[modifier] = true;
  }
  return parsed;
}

export function shortcutKey(keys: string): string {
  const parsed = parseKeys(keys);
  return [parsed.mod ? "mod" : "", parsed.shift ? "shift" : "", parsed.alt ? "alt" : "", parsed.key]
    .filter(Boolean)
    .join("+");
}

export function defineShortcuts(shortcuts: readonly Shortcut[]): Shortcut[] {
  const owners = new Map<string, string>();
  for (const shortcut of shortcuts) {
    const signature = shortcutKey(shortcut.keys);
    const owner = owners.get(signature);
    if (owner) {
      throw new Error(`Raccourci en conflit : "${shortcut.keys}" (${owner} et ${shortcut.id})`);
    }
    owners.set(signature, shortcut.id);
  }
  return [...shortcuts];
}

export function detectModKey(userAgent = navigator.userAgent, platform = navigator.platform): ModKey {
  return /mac|iphone|ipad|ipod/i.test(platform) || /mac os x/i.test(userAgent) ? "meta" : "ctrl";
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (TEXT_FIELDS.has(target.tagName.toLowerCase())) return true;
  return target.isContentEditable || target.closest("[contenteditable]:not([contenteditable='false'])") !== null;
}

function normalizeEventKey(key: string): string {
  const lowered = key.toLowerCase();
  return AZERTY_DIGITS[key] ?? AZERTY_DIGITS[lowered] ?? lowered;
}

export function matchesShortcut(event: ShortcutEvent, keys: string, mod: ModKey): boolean {
  const parsed = parseKeys(keys);
  if (normalizeEventKey(event.key) !== parsed.key) return false;

  const symbol = !/^[a-z0-9]$/.test(parsed.key);
  if (!symbol && event.shiftKey !== parsed.shift) return false;
  if (event.altKey !== parsed.alt) return false;

  const primary = mod === "meta" ? event.metaKey : event.ctrlKey;
  const secondary = mod === "meta" ? event.ctrlKey : event.metaKey;
  return primary === parsed.mod && !secondary;
}

export function resolveShortcut(
  shortcuts: readonly Shortcut[],
  event: ShortcutEvent,
  mod: ModKey,
  editable = isEditableTarget(event.target),
): Shortcut | null {
  for (const shortcut of shortcuts) {
    if (editable && !shortcut.allowInInput) continue;
    if (shortcut.when && !shortcut.when()) continue;
    if (matchesShortcut(event, shortcut.keys, mod)) return shortcut;
  }
  return null;
}

export function availableShortcuts(shortcuts: readonly Shortcut[]): Shortcut[] {
  return shortcuts.filter((shortcut) => shortcut.when?.() !== false);
}

export function keyLabels(keys: string, mod: ModKey): string[] {
  const parsed = parseKeys(keys);
  const labels: string[] = [];
  if (parsed.mod) labels.push(mod === "meta" ? "⌘" : "Ctrl");
  if (parsed.alt) labels.push(mod === "meta" ? "⌥" : "Alt");
  if (parsed.shift) labels.push(mod === "meta" ? "⇧" : "Maj");
  labels.push(KEY_LABELS[parsed.key] ?? parsed.key.toUpperCase());
  return labels;
}

export function useShortcuts(shortcuts: readonly Shortcut[], enabled = true): ModKey {
  const mod = useMemo(() => detectModKey(), []);
  const current = useRef(shortcuts);
  current.current = shortcuts;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const shortcut = resolveShortcut(current.current, event, mod);
      if (!shortcut || (event.repeat && !shortcut.allowRepeat)) return;
      event.preventDefault();
      shortcut.run();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, mod]);

  return mod;
}
