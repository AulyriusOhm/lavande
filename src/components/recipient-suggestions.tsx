import { useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { useContacts } from "@/lib/contacts";
import type { ContactSuggestion } from "@/lib/contacts";
import { splitAddresses } from "@/lib/mail";
import { cn } from "@/lib/utils";

export type RecipientField = "to" | "cc" | "cci";

const LIST_ID = "compose-recipient-suggestions";
const MAX_SUGGESTIONS = 6;

/** Le fragment en cours de saisie : ce qui suit le dernier séparateur. */
export function recipientFragment(value: string): string {
  return value.split(/[\s,;]+/).pop() ?? "";
}

/** Remplace le fragment courant par l'adresse nue, prête pour la suivante. */
export function withContact(value: string, email: string): string {
  const fragment = recipientFragment(value);
  return `${value.slice(0, value.length - fragment.length)}${email}, `;
}

/**
 * L'autocomplétion des trois champs de destinataires : un seul mécanisme, le
 * champ actif est celui qui a le focus. Le démon cherche les contacts, la démo
 * se rabat sur les expéditeurs de la boîte.
 */
export function useRecipientAutocomplete(
  values: Record<RecipientField, string>,
  setValue: (field: RecipientField, value: string) => void,
) {
  const [field, setField] = useState<RecipientField | null>(null);
  const [fragment, setFragment] = useState("");
  const [active, setActive] = useState(0);
  const inputs = useRef<Partial<Record<RecipientField, HTMLInputElement | null>>>({});

  const contacts = useContacts(field && fragment ? fragment : null, MAX_SUGGESTIONS);
  const used = useMemo(
    () => new Set(field ? splitAddresses(values[field]).map((token) => token.toLowerCase()) : []),
    [field, values],
  );
  const options = contacts
    .filter((contact) => !used.has(contact.email.toLowerCase()))
    .slice(0, MAX_SUGGESTIONS);
  const open = field !== null && fragment !== "" && options.length > 0;

  const close = () => {
    setField(null);
    setFragment("");
    setActive(0);
  };

  const pick = (contact: ContactSuggestion) => {
    if (!field) return;
    const next = withContact(values[field], contact.email);
    setValue(field, next);
    const input = inputs.current[field];
    close();
    if (input) {
      requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(next.length, next.length);
      });
    }
  };

  const bind = (current: RecipientField) => ({
    ref: (element: HTMLInputElement | null) => {
      inputs.current[current] = element;
    },
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      setValue(current, event.target.value);
      setField(current);
      setFragment(recipientFragment(event.target.value));
      setActive(0);
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (!open) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((index) => (index + 1) % options.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => (index - 1 + options.length) % options.length);
      } else if (event.key === "Enter") {
        if (event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        event.stopPropagation();
        const contact = options[active];
        if (contact) pick(contact);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    },
    onBlur: () => {
      if (field === current) close();
    },
    "aria-autocomplete": "list" as const,
    "aria-expanded": open && field === current,
    "aria-controls": open && field === current ? LIST_ID : undefined,
    "aria-activedescendant": open && field === current ? `${LIST_ID}-${active}` : undefined,
  });

  return { field, open, options, active, pick, bind };
}

/** La liste sous le champ : `nom · adresse`, une cible tactile par contact. */
export function RecipientSuggestions({
  options,
  active,
  onPick,
}: {
  options: ContactSuggestion[];
  active: number;
  onPick: (contact: ContactSuggestion) => void;
}) {
  return (
    <ul
      role="listbox"
      id={LIST_ID}
      aria-label="Suggestions de contacts"
      className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_18px_40px_-24px_var(--ink)]"
    >
      {options.map((contact, index) => (
        <li
          key={contact.email}
          role="option"
          id={`${LIST_ID}-${index}`}
          aria-selected={index === active}
          data-testid="recipient-suggestion"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(contact)}
          className={cn(
            "flex min-h-11 cursor-pointer flex-col justify-center px-3 py-2 leading-tight transition-colors",
            index === active ? "bg-accent-soft text-accent-ink" : "text-ink-soft hover:bg-surface-2",
          )}
        >
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-bold">{contact.name ?? contact.email}</span>
            {contact.kind === "group" ? (
              <span className="shrink-0 rounded bg-surface-2 px-1 py-0.5 text-[9.5px] font-bold tracking-wide text-ink-muted uppercase">
                liste
              </span>
            ) : null}
          </span>
          {contact.name ? (
            <span className="truncate text-[11px] font-medium text-ink-muted">{contact.email}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
