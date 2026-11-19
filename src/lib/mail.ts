import type { ApiPgpDetail } from "@/lib/api";
import type { SearchCriteria } from "@/lib/search-query";

export type PgpState = "none" | "signed" | "encrypted";

export type FolderId =
  | "inbox"
  | "spam"
  | "sent"
  | "drafts"
  | "archive"
  | "trash"
  | "other"
  | "unified";

/** Libellés par rôle IMAP : le serveur ne renvoie que des rôles. */
export const FOLDER_LABELS: Record<FolderId, string> = {
  inbox: "Boîte de réception",
  unified: "Boîte unifiée",
  sent: "Envoyés",
  drafts: "Brouillons",
  archive: "Archives",
  spam: "Spam",
  trash: "Corbeille",
  other: "Autres",
};

/** Dossiers que la boîte unifiée rassemble : tout sauf la corbeille et le spam. */
export const UNIFIED_FOLDERS: FolderId[] = ["inbox", "sent", "drafts", "archive", "other"];

export const FOLDERS: { id: FolderId; label: string }[] = [
  { id: "inbox", label: FOLDER_LABELS.inbox },
  { id: "sent", label: FOLDER_LABELS.sent },
  { id: "drafts", label: FOLDER_LABELS.drafts },
  { id: "archive", label: FOLDER_LABELS.archive },
  { id: "spam", label: FOLDER_LABELS.spam },
  { id: "trash", label: FOLDER_LABELS.trash },
];

export function folderLabel(id: FolderId) {
  return FOLDER_LABELS[id] ?? FOLDER_LABELS.inbox;
}

/** L'étiquette affichée : le nom du dossier réel prime sur le rôle générique. */
export function mailFolderLabel(mail: Mail) {
  return mail.folderName ?? folderLabel(mail.folder);
}

export function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function dayOf(value: string): number {
  return new Date(`${value}T00:00:00`).getTime();
}

function folderNames(mail: Mail): string[] {
  return [mail.folder, mail.folderName ?? "", folderLabel(mail.folder), mail.source?.folderPath ?? ""];
}

/** Mêmes critères que le démon, sur les fixtures : une seule grammaire en démo aussi. */
export function mailMatches(mail: Mail, criteria: SearchCriteria) {
  const text = normalize(criteria.text?.trim() ?? "");
  const words = text.split(/\s+/).filter(Boolean);
  const fields = [mail.name, mail.email, mail.subject, mail.preview, ...mail.body].map(normalize);
  const matchesText = words.every((word) => fields.some((field) => field.includes(word)));

  const matches = (value: string | undefined, needle: string | undefined) =>
    needle === undefined || normalize(value ?? "").includes(normalize(needle));

  const folder = criteria.folder;
  const stamp = mail.timestamp;
  const inRange =
    (criteria.after === undefined || (stamp !== undefined && stamp >= dayOf(criteria.after))) &&
    (criteria.before === undefined || (stamp !== undefined && stamp < dayOf(criteria.before)));

  return (
    matchesText &&
    matches([mail.name, mail.email].join(" "), criteria.from) &&
    matches([mail.to, mail.cc].filter(Boolean).join(" "), criteria.to) &&
    matches(mail.subject, criteria.subject) &&
    (folder === undefined || folderNames(mail).some((name) => normalize(name) === normalize(folder))) &&
    (criteria.unread === undefined || mail.unread === criteria.unread) &&
    (criteria.starred === undefined || mail.starred === criteria.starred) &&
    (criteria.hasAttachment === undefined ||
      Boolean(mail.attachments?.length) === criteria.hasAttachment) &&
    inRange
  );
}

export type MailSource = {
  accountId: string;
  folderPath: string;
  uid: number;
};

/**
 * Une pièce jointe reçue. `index` est son rang dans le message côté serveur :
 * c'est ce que le démon attend pour renvoyer les octets. Absent en mode démo,
 * où `data` porte exceptionnellement les octets d'une maquette.
 */
export type MailAttachment = {
  name: string;
  size: string;
  mime?: string;
  index?: number;
  inline?: boolean;
  data?: string;
};

export type Mail = {
  id: string;
  account: string;
  folder: FolderId;
  /** Nom réel du dossier quand il n'a pas de rôle (dossier personnalisé). */
  folderName?: string;
  threadId?: string;
  previousFolder?: FolderId;
  source?: MailSource;
  messageId?: string;
  references?: string[];
  bodyFetched?: boolean;
  name: string;
  email: string;
  to?: string;
  cc?: string;
  subject: string;
  preview: string;
  body: string[];
  html?: string;
  time: string;
  date?: string;
  /** Horodatage réel (ms) : base du filtrage des résumés périodiques. */
  timestamp?: number;
  unread: boolean;
  starred: boolean;
  answered?: boolean;
  pgp: PgpState;
  pgp_detail?: ApiPgpDetail | null;
  attachments?: MailAttachment[];
  tone: number;
};

export const TONES = [
  "from-violet-200 to-indigo-200 text-violet-900",
  "from-fuchsia-200 to-violet-200 text-fuchsia-900",
  "from-sky-200 to-violet-200 text-sky-900",
  "from-rose-200 to-fuchsia-200 text-rose-900",
  "from-teal-200 to-emerald-200 text-teal-900",
  "from-amber-200 to-rose-200 text-amber-900",
];

/** Horodatage des fixtures : relatif au chargement, pour que la fenêtre des
 *  résumés périodiques reste peuplée dans la démo (les libellés restent figés). */
const DEMO_LOADED_AT = Date.now();
const minutesAgo = (minutes: number) => DEMO_LOADED_AT - minutes * 60_000;

export const MAILS: Mail[] = import.meta.env.VITE_DISTRIBUTION === "1" ? [] : [
  {
    id: "1d",
    account: "perso",
    folder: "inbox",
    threadId: "t-maquettes",
    name: "Marc Delaunay",
    email: "marc.delaunay@mail.fr",
    subject: "Maquettes mobiles — version 3",
    preview: "C'est bon pour moi, j'ai signé l'avenant ce matin. On peut lancer la phase 2 dès lundi.",
    body: [
      "C'est bon pour moi, j'ai signé l'avenant ce matin.",
      "On peut lancer la phase 2 dès lundi prochain. Je te transmets les accès serveur dans la journée.",
      "Bien à toi,\nMarc",
    ],
    time: "11:02",
    date: "mardi 10 novembre 2026 · 11:02",
    timestamp: minutesAgo(45),
    unread: true,
    starred: false,
    pgp: "none",
    tone: 1,
  },
  {
    id: "1b",
    account: "perso",
    folder: "sent",
    threadId: "t-maquettes",
    name: "Roman",
    email: "roman@lavande.mail",
    to: "camille@studio-lilas.fr",
    subject: "Re: Maquettes mobiles — version 3",
    preview: "Les contrastes passent mieux en extérieur. Deux remarques : la barre du haut est collée et les mois se tronquent.",
    body: [
      "Salut Camille,",
      "Les contrastes passent mieux en extérieur. Deux remarques : la barre du haut est collée au résumé du matin, et les mois se tronquent dans l'agenda.",
      "Le reste me va, on peut figer la v3 pour la démo.",
    ],
    cc: "marc.delaunay@mail.fr",
    time: "10:12",
    date: "mardi 10 novembre 2026 · 10:12",
    timestamp: minutesAgo(106),
    unread: false,
    starred: false,
    pgp: "none",
    tone: 0,
  },
  {
    id: "10",
    account: "pro",
    folder: "sent",
    threadId: "t-devis",
    name: "Roman",
    email: "roman@studio-lilas.fr",
    subject: "Re: Devis signé — retour de ma part",
    to: "marc.delaunay@mail.fr",
    preview: "Parfait Marc, merci. Je lance la phase 2 lundi, je te transmets le planning dans la journée.",
    body: ["Parfait Marc, merci.", "Je lance la phase 2 lundi, je te transmets le planning dans la journée."],
    time: "10:12",
    date: "mardi 10 novembre 2026 · 10:12",
    timestamp: minutesAgo(105),
    unread: false,
    starred: false,
    pgp: "encrypted",
    tone: 0,
  },
  {
    id: "1",
    account: "perso",
    folder: "inbox",
    threadId: "t-maquettes",
    name: "Camille Rousseau",
    email: "camille@studio-lilas.fr",
    subject: "Maquettes mobiles — version 3",
    preview: "J'ai retravaillé les écrans de la boîte de réception, dis-moi ce que tu penses des nouveaux contrastes…",
    body: [
      "Salut,",
      "J'ai retravaillé les écrans de la boîte de réception cette nuit. Les nouveaux contrastes passent mieux en extérieur, et la hiérarchie est plus lisible une fois l'accent violet appliqué.",
      "J'ai aussi ajouté une variante avec la barre de recherche flottante : elle libère 48 px en haut de l'écran, ce qui n'est pas négligeable sur les petits téléphones.",
      "Dis-moi ce que tu en penses avant vendredi, je voudrais figer la v3 pour la démo client.",
      "À très vite,\nCamille",
    ],
    to: "roman@lavande.mail",
    cc: "marc.delaunay@mail.fr",
    time: "09:41",
    date: "mardi 10 novembre 2026 · 09:41",
    timestamp: minutesAgo(160),
    unread: true,
    starred: true,
    pgp: "encrypted",
    attachments: [
      { name: "inbox-v3.fig", size: "4,2 Mo" },
      { name: "specs-mobile.pdf", size: "820 Ko" },
    ],
    tone: 0,
  },
  {
    id: "3",
    account: "pro",
    folder: "inbox",
    threadId: "t-devis",
    name: "Marc Delaunay",
    email: "marc.delaunay@mail.fr",
    subject: "Devis signé — retour de ma part",
    preview: "C'est bon pour moi, j'ai signé l'avenant ce matin. On peut lancer la phase 2 dès lundi prochain.",
    body: [
      "Bonjour,",
      "C'est bon pour moi, j'ai signé l'avenant ce matin. On peut lancer la phase 2 dès lundi prochain.",
      "Je te transmets les accès serveur dans la journée.",
      "Bien à toi,\nMarc",
    ],
    time: "08:47",
    date: "mardi 10 novembre 2026 · 08:47",
    timestamp: minutesAgo(250),
    unread: true,
    starred: true,
    pgp: "encrypted",
    attachments: [{ name: "avenant-phase2.pdf", size: "310 Ko" }],
    tone: 1,
  },
  {
    id: "2",
    account: "perso",
    folder: "inbox",
    name: "GitHub",
    email: "notifications@github.com",
    subject: "[lavande] Rust backend: 3 pull requests",
    preview: "@marie a demandé une revue sur feat/imap-sync, et 2 autres pull requests attendent ton avis.",
    body: [
      "Trois pull requests attendent ta revue sur le dépôt lavande.",
      "feat/imap-sync — synchronisation IMAP incrémentale, 14 fichiers modifiés.",
      "fix/oauth-refresh — corrige l'expiration silencieuse du refresh token.",
      "chore/tauri-v2 — migration vers Tauri v2 et activation du support Android.",
    ],
    time: "08:12",
    date: "mardi 10 novembre 2026 · 08:12",
    timestamp: minutesAgo(330),
    unread: true,
    starred: false,
    pgp: "signed",
    tone: 2,
  },
  {
    id: "4",
    account: "perso",
    folder: "inbox",
    name: "Léa Fontaine",
    email: "lea@atelier-nova.co",
    subject: "Déjeuner jeudi ?",
    preview: "Il y a ce petit café rue des Lilas qui vient d'ouvrir, il paraît que leur tarte au citron est…",
    body: [
      "Coucou !",
      "Il y a ce petit café rue des Lilas qui vient d'ouvrir. Il paraît que leur tarte au citron est criminelle.",
      "Jeudi 12h30 ? Je réserve si tu confirmes.",
    ],
    time: "Hier",
    date: "lundi 9 novembre 2026 · 18:24",
    timestamp: minutesAgo(1_300),
    unread: false,
    starred: false,
    pgp: "none",
    tone: 3,
  },
  {
    id: "1c",
    account: "perso",
    folder: "inbox",
    threadId: "t-maquettes",
    name: "Camille Rousseau",
    email: "camille@studio-lilas.fr",
    subject: "Maquettes mobiles — version 3",
    preview: "J'ai poussé la v3.1 dans Figma avec les correctifs, tu peux relire tranquille.",
    body: [
      "J'ai poussé la v3.1 dans Figma avec les correctifs dont tu parlais.",
      "Les deux barres sont décollées et les libellés de mois tiennent en entier. Tu peux relire tranquille.",
    ],
    time: "Hier",
    date: "lundi 9 novembre 2026 · 18:02",
    timestamp: minutesAgo(1_340),
    unread: false,
    starred: false,
    pgp: "encrypted",
    tone: 0,
  },
  {
    id: "5",
    account: "gmail",
    folder: "inbox",
    name: "Anaïs Petit",
    email: "anais.petit@gmail.com",
    subject: "Photos du week-end à la mer",
    preview: "J'ai enfin trié les 400 photos, le lien partage est en bas. Il y en a quelques-unes de toi…",
    body: [
      "Salut !",
      "J'ai enfin trié les 400 photos du week-end. Le lien de partage est valable 30 jours.",
      "Il y en a quelques-unes de toi plutôt réussies, notamment celle du ponton au coucher du soleil.",
    ],
    time: "Hier",
    date: "lundi 9 novembre 2026 · 17:08",
    timestamp: minutesAgo(1_420),
    unread: true,
    starred: false,
    pgp: "none",
    tone: 4,
  },
  {
    id: "6",
    account: "pro",
    folder: "inbox",
    name: "Notion",
    email: "team@makenotion.com",
    subject: "Ton récapitulatif hebdomadaire",
    preview: "12 pages modifiées, 4 commentaires et 2 tâches terminées dans l'espace Design System.",
    body: [
      "Voici ce qui s'est passé cette semaine dans ton espace Design System.",
      "12 pages modifiées · 4 commentaires · 2 tâches terminées.",
      "La page « Couleurs & tokens » a été mise à jour par Camille hier à 18:04.",
    ],
    time: "Hier",
    date: "lundi 9 novembre 2026 · 09:15",
    timestamp: minutesAgo(2_000),
    unread: false,
    starred: false,
    pgp: "signed",
    tone: 2,
  },
  {
    id: "7",
    account: "gmail",
    folder: "inbox",
    name: "Spotify",
    email: "no-reply@spotify.com",
    subject: "Ta playlist « Focus lavande » a été mise à jour",
    preview: "18 nouveaux morceaux ont rejoint la playlist que tu suis. De quoi tenir la nuit de debug.",
    body: [
      "18 nouveaux morceaux ont rejoint la playlist « Focus lavande » que tu suis.",
      "Ambient, lo-fi et pas mal de piano. Bonne session.",
    ],
    time: "dim.",
    date: "dimanche 8 novembre 2026 · 21:40",
    timestamp: minutesAgo(2_900),
    unread: false,
    starred: false,
    pgp: "none",
    tone: 5,
  },
  {
    id: "8",
    account: "pro",
    folder: "inbox",
    name: "OVHcloud",
    email: "facturation@ovh.com",
    subject: "Facture F2026-1187 disponible",
    preview: "Ta facture de 11,98 € pour le mois d'octobre est disponible dans ton espace client.",
    body: [
      "Bonjour,",
      "Ta facture F2026-1187 d'un montant de 11,98 € TTC pour le mois d'octobre est disponible dans ton espace client.",
      "Le prélèvement aura lieu le 15 du mois.",
    ],
    time: "lun.",
    date: "lundi 9 novembre 2026 · 14:02",
    timestamp: minutesAgo(1_560),
    unread: false,
    starred: false,
    pgp: "signed",
    attachments: [{ name: "F2026-1187.pdf", size: "88 Ko" }],
    tone: 0,
  },
  {
    id: "9",
    account: "perso",
    folder: "spam",
    name: "Loterie Nationale",
    email: "winner@lucky-draw-7821.top",
    subject: "Félicitations ! Vous avez gagné 2 500 000 €",
    preview: "Pour recevoir votre gain, répondez avec vos coordonnées bancaires sous 24 h…",
    body: [
      "Cher gagnant,",
      "Vous avez été sélectionné pour recevoir 2 500 000 €. Répondez à ce message avec vos coordonnées bancaires sous 24 heures.",
      "Cordialement, le service des gains.",
    ],
    time: "03:12",
    date: "mardi 10 novembre 2026 · 03:12",
    timestamp: minutesAgo(700),
    unread: true,
    starred: false,
    pgp: "none",
    tone: 5,
  },
  {
    id: "11",
    account: "perso",
    folder: "archive",
    name: "Camille Rousseau",
    email: "camille@studio-lilas.fr",
    subject: "Archive — brief v2 (validé)",
    preview: "Version validée et archivée. Les deux variantes de barre de recherche restent dans le fichier Figma.",
    body: [
      "Pour mémoire, la v2 est validée.",
      "Les deux variantes de barre de recherche restent dans le fichier Figma, on tranchera sur la v3.",
    ],
    time: "11 sept.",
    date: "vendredi 11 septembre 2026 · 11:02",
    timestamp: minutesAgo(86_400),
    unread: false,
    starred: true,
    pgp: "encrypted",
    tone: 0,
  },
  {
    id: "d1",
    account: "pro",
    folder: "drafts",
    name: "Roman",
    email: "roman@studio-lilas.fr",
    to: "marc.delaunay@mail.fr",
    subject: "Planning phase 2 — proposition",
    preview: "Voici le planning que je propose pour la phase 2 : deux semaines de mise en place, puis trois…",
    body: [
      "Bonjour Marc,",
      "Voici le planning que je propose pour la phase 2 : deux semaines de mise en place, puis trois semaines de développement.",
      "Je te confirme les créneaux dès demain matin.",
    ],
    time: "Hier",
    date: "lundi 9 novembre 2026 · 16:40",
    timestamp: minutesAgo(1_380),
    unread: false,
    starred: false,
    pgp: "none",
    tone: 1,
  },
  {
    id: "d2",
    account: "perso",
    folder: "drafts",
    name: "Roman",
    email: "roman@lavande.mail",
    to: "camille@studio-lilas.fr",
    subject: "Retours sur les maquettes v3",
    preview: "Deux points avant la démo : la barre du haut reste collée et les libellés de mois se tronquent.",
    body: [
      "Salut Camille,",
      "Deux points avant la démo : la barre du haut reste collée et les libellés de mois se tronquent dans l'agenda.",
      "Le reste me va, on peut figer la v3.",
    ],
    time: "Hier",
    date: "lundi 9 novembre 2026 · 15:12",
    timestamp: minutesAgo(1_470),
    unread: false,
    starred: false,
    pgp: "none",
    attachments: [
      {
        name: "retours-v3.txt",
        size: "65 o",
        mime: "text/plain",
        data: "UmV0b3VycyB2MyA6IGJhcnJlIGR1IGhhdXQgY29sbMOpZSwgbGliZWxsw6lzIGRlIG1vaXMgdHJvbnF1w6lzLgo=",
      },
    ],
    tone: 0,
  },
];

export const RECENT_SEARCHES = import.meta.env.VITE_DISTRIBUTION === "1" ? [] : ["camille", "factures", "devis signé", "figma"];

export type FrequentContact = { name: string; email: string; tone: number; count: number };

/** Contacts réellement présents dans la boîte, du plus fréquent au moins fréquent. */
export function frequentContacts(mails: Mail[]): FrequentContact[] {
  const seen = new Map<string, FrequentContact>();
  for (const mail of mails) {
    if (mail.folder === "sent") continue;
    const entry = seen.get(mail.email) ?? { name: mail.name, email: mail.email, tone: mail.tone, count: 0 };
    entry.count += 1;
    seen.set(mail.email, entry);
  }
  return Array.from(seen.values()).sort((a, b) => b.count - a.count);
}
