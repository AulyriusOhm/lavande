import { availableShortcuts, keyLabels, SHORTCUT_GROUPS, type ModKey, type Shortcut } from "@/lib/shortcuts";
import { Kbd } from "@/desktop/ui";

export function ShortcutList({ shortcuts, mod }: { shortcuts: readonly Shortcut[]; mod: ModKey }) {
  const items = availableShortcuts(shortcuts);

  return (
    <div>
      {SHORTCUT_GROUPS.map((group) => {
        const rows = items.filter((shortcut) => shortcut.group === group.id);
        if (rows.length === 0) return null;
        return (
          <section key={group.id} className="mb-1 last:mb-0">
            <div className="flex items-baseline justify-between gap-3 px-2 pt-2 pb-1">
              <h3 className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">{group.id}</h3>
              <span className="text-[10.5px] font-semibold text-ink-muted">{group.hint}</span>
            </div>
            <ul>
              {rows.map((shortcut) => (
                <li
                  key={shortcut.id}
                  className="flex items-center justify-between gap-4 rounded-xl px-2 py-1.5 transition-colors duration-200 hover:bg-surface-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[12.5px] font-bold text-ink">{shortcut.label}</p>
                    <p className="truncate text-[11px] font-medium text-ink-muted">{shortcut.description}</p>
                  </div>
                  <span className="flex shrink-0 items-center gap-1">
                    {keyLabels(shortcut.keys, mod).map((label, index) => (
                      <Kbd key={`${shortcut.id}-${index}`}>{label}</Kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
