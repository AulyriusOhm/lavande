/**
 * Le compte dont on règle le Zimbra : seuls les comptes à mot de passe donnent
 * accès au serveur (filtres, absence, étiquettes, annuaire). Un compte Google
 * n'a rien à y faire.
 */

import { useState } from "react";
import type { Account } from "@/lib/accounts";
import { useMailStore } from "@/lib/store";

/**
 * Le compte dont les réglages Zimbra vivent sur le serveur : celui qui est
 * ouvert s'il est à mot de passe, sinon l'unique compte à mot de passe du
 * produit. Deux serveurs possibles = rien, plutôt qu'un serveur au hasard.
 */
export function zimbraAccountOf(accounts: Account[], current = ""): Account | null {
  const zimbra = accounts.filter((account) => !account.oauth);
  const opened = zimbra.find((account) => account.id === current);
  if (opened) return opened;
  return zimbra.length === 1 ? zimbra[0] : null;
}

export function useZimbraAccount(): {
  /** Tous les comptes, pour distinguer « aucun » de « que des comptes OAuth ». */
  accounts: Account[];
  zimbra: Account[];
  account: Account | null;
  select: (id: string) => void;
} {
  const { accounts } = useMailStore();
  const zimbra = accounts.filter((account) => !account.oauth);
  const [selected, setSelected] = useState<string | null>(null);
  const account = zimbra.find((entry) => entry.id === selected) ?? zimbra[0] ?? null;
  return { accounts, zimbra, account, select: setSelected };
}
