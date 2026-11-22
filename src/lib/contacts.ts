import { useEffect, useMemo, useState } from "react";
import { mailApi, type ZimbraGalEntry } from "@/lib/api";
import type { Account } from "@/lib/accounts";
import { TONES, frequentContacts, normalize } from "@/lib/mail";
import type { Mail } from "@/lib/mail";
import { useMailStore } from "@/lib/store";

/** Un contact proposé à la saisie, ou listé par la recherche. */
export type ContactSuggestion = {
  name: string | null;
  email: string;
  /** Messages échangés : reçus + envoyés ; 0 pour une entrée de l'annuaire. */
  count: number;
  tone: number;
  /** `group` pour une liste de diffusion de l'annuaire d'entreprise. */
  kind?: "contact" | "group";
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

/** L'annuaire de l'entreprise : ce que le serveur Zimbra connaît de la boîte. */
const fromGal = (entries: ZimbraGalEntry[]): ContactSuggestion[] =>
  entries.map((entry) => ({
    name: entry.name || null,
    email: entry.email,
    count: 0,
    tone: toneOf(entry.email),
    kind: entry.kind,
  }));

/** Carnet local d'abord, annuaire ensuite : une adresse ne s'affiche qu'une fois. */
export function mergeContacts(
  local: ContactSuggestion[],
  gal: ContactSuggestion[],
): ContactSuggestion[] {
  const seen = new Set(local.map((contact) => contact.email.toLowerCase()));
  return [
    ...local,
    ...gal.filter((contact) => {
      const key = contact.email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}

/**
 * Le carnet de contacts : la base du démon quand elle répond, les expéditeurs de
 * la boîte en démo. `query` à `null` coupe la requête (aucun champ ne saisit),
 * une chaîne vide rend les contacts les plus fréquents.
 */
export function useContacts(query: string | null, limit = 6): ContactSuggestion[] {
  const { mode, mails, accounts = [], account = "" } = useMailStore();
  const demo = mode !== "api";
  const [found, setFound] = useState<ContactSuggestion[]>([]);
  const galAccount = galAccountOf(accounts, account);

  useEffect(() => {
    if (demo || query === null) {
      setFound([]);
      return;
    }
    const term = query.trim();
    const galOf = galAccount && term ? galAccount.id : null;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const local = mailApi.contacts(term, limit).then(
        (rows) =>
          rows.map((row) => ({
            name: row.name,
            email: row.email,
            count: row.received + row.sent,
            tone: toneOf(row.email),
          })),
        () => [] as ContactSuggestion[],
      );
      const directory = galOf
        ? mailApi.zimbraGal(galOf, term, limit).then(fromGal, () => [] as ContactSuggestion[])
        : Promise.resolve([] as ContactSuggestion[]);
      void Promise.all([local, directory]).then(([rows, entries]) => {
        if (!cancelled) setFound(mergeContacts(rows, entries));
      });
    }, DEBOUNCE);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [demo, query, limit, galAccount]);

  const contacts = useMemo(() => {
    if (!demo) return found;
    if (query === null) return [];
    const needle = normalize(query.trim());
    return fromDemo(mails).filter((contact) => matches(contact, needle)).slice(0, limit);
  }, [demo, found, mails, query, limit]);

  return contacts;
}

/**
 * Le compte dont l'annuaire répond : le compte ouvert s'il est à mot de passe,
 * sinon l'unique compte à mot de passe du produit. Deux serveurs possibles =
 * pas d'annuaire, plutôt qu'un annuaire au hasard.
 */
function galAccountOf(accounts: Account[], current: string): Account | null {
  const zimbra = accounts.filter((entry) => !entry.oauth);
  const opened = zimbra.find((entry) => entry.id === current);
  if (opened) return opened;
  return zimbra.length === 1 ? zimbra[0] : null;
}
