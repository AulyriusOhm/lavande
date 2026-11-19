import { useEffect, useMemo, useState } from "react";
import { mailApi } from "@/lib/api";
import { TONES, frequentContacts, normalize } from "@/lib/mail";
import type { Mail } from "@/lib/mail";
import { useMailStore } from "@/lib/store";

/** Un contact proposé à la saisie, ou listé par la recherche. */
export type ContactSuggestion = {
  name: string | null;
  email: string;
  /** Messages échangés : reçus + envoyés. */
  count: number;
  tone: number;
};

const DEBOUNCE = 200;

/** Teinte stable d'une adresse : le démon ne renvoie pas de couleur. */
const toneOf = (email: string) =>
  [...email].reduce((sum, character) => sum + character.charCodeAt(0), 0) % TONES.length;

const fromDemo = (mails: Mail[]): ContactSuggestion[] =>
  frequentContacts(mails).map(({ name, email, count, tone }) => ({ name, email, count, tone }));

const matches = (contact: ContactSuggestion, needle: string) =>
  !needle ||
  normalize(contact.name ?? "").includes(needle) ||
  normalize(contact.email).includes(needle);

/**
 * Le carnet de contacts : la base du démon quand elle répond, les expéditeurs de
 * la boîte en démo. `query` à `null` coupe la requête (aucun champ ne saisit),
 * une chaîne vide rend les contacts les plus fréquents.
 */
export function useContacts(query: string | null, limit = 6): ContactSuggestion[] {
  const { mode, mails } = useMailStore();
  const demo = mode !== "api";
  const [found, setFound] = useState<ContactSuggestion[]>([]);

  useEffect(() => {
    if (demo || query === null) {
      setFound([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void mailApi.contacts(query, limit).then(
        (rows) => {
          if (cancelled) return;
          setFound(
            rows.map((row) => ({
              name: row.name,
              email: row.email,
              count: row.received + row.sent,
              tone: toneOf(row.email),
            })),
          );
        },
        () => {
          if (!cancelled) setFound([]);
        },
      );
    }, DEBOUNCE);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [demo, query, limit]);

  const contacts = useMemo(() => {
    if (!demo) return found;
    if (query === null) return [];
    const needle = normalize(query.trim());
    return fromDemo(mails).filter((contact) => matches(contact, needle)).slice(0, limit);
  }, [demo, found, mails, query, limit]);

  return contacts;
}
