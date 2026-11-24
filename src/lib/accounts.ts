export type Account = {
  id: string;
  label: string;
  email: string;
  provider: string;
  color: string;
  tone: number;
  synced: string;
  /** Dossiers synchronisés : `null` = tous ceux à rôle connu, `[]` = aucun. */
  syncedFolders?: string[] | null;
  /** Dossiers analysés par l'IA : `null` = réception (INBOX + dossiers perso), `[]` = aucun. */
  aiFolders?: string[] | null;
  /** Connexion OAuth2 : le consentement peut être rejoué sans retirer le compte. */
  oauth?: boolean;
  /** Le refresh token a été refusé : le compte attend une reconnexion. */
  needsReauth?: boolean;
};

export const ACCOUNTS: Account[] = [
  {
    id: "perso",
    label: "Perso",
    email: "roman@lavande.mail",
    provider: "IMAP · lavande.mail",
    color: "#8b7cf6",
    tone: 0,
    synced: "à l'instant",
  },
  {
    id: "pro",
    label: "Studio",
    email: "roman@studio-lilas.fr",
    provider: "IMAP · OVH",
    color: "#38bdf8",
    tone: 2,
    synced: "il y a 2 min",
  },
  {
    id: "gmail",
    label: "Gmail",
    email: "roman.lanro@gmail.com",
    provider: "OAuth · Google",
    color: "#fb7185",
    tone: 3,
    synced: "il y a 5 min",
  },
];

export const ALL_ACCOUNTS = "all";

export function accountById(id: string) {
  return ACCOUNTS.find((account) => account.id === id);
}

/** Libellé lisible d'une boîte source, sans jamais casser l'affichage si l'id est inconnu. */
export function sourceAccountLabel(accounts: Account[], id: string | undefined): string {
  if (!id) return "Boîte";
  return accounts.find((account) => account.id === id)?.label ?? id;
}
