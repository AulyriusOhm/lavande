export type PgpState = "none" | "signed" | "encrypted";

export type FolderId = "inbox" | "spam" | "sent" | "archive" | "trash";

export const FOLDERS: { id: FolderId; label: string }[] = [
  { id: "inbox", label: "Boîte de réception" },
  { id: "sent", label: "Envoyés" },
  { id: "archive", label: "Archives" },
  { id: "spam", label: "Spam" },
  { id: "trash", label: "Corbeille" },
];

export function folderLabel(id: FolderId) {
  return FOLDERS.find((folder) => folder.id === id)?.label ?? "Boîte de réception";
}

export type Mail = {
  id: string;
  account: "perso" | "pro" | "gmail";
  folder: FolderId;
  name: string;
  email: string;
  subject: string;
  preview: string;
  body: string[];
  time: string;
  unread: boolean;
  starred: boolean;
  pgp: PgpState;
  attachments?: { name: string; size: string }[];
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

export const MAILS: Mail[] = [
  {
    id: "1",
    account: "perso",
    folder: "inbox",
    name: "Camille Rousseau",
    email: "camille@studio-lilas.fr",
    subject: "Maquettes mobile — version 3",
    preview: "J'ai retravaillé les écrans de la boîte de réception, dis-moi ce que tu penses des nouveaux contrastes…",
    body: [
      "Salut,",
      "J'ai retravaillé les écrans de la boîte de réception cette nuit. Les nouveaux contrastes passent mieux en extérieur, et la hiérarchie est plus lisible une fois l'accent violet appliqué.",
      "J'ai aussi ajouté une variante avec la barre de recherche flottante : elle libère 48 px en haut de l'écran, ce qui n'est pas négligeable sur les petits téléphones.",
      "Dis-moi ce que tu en penses avant vendredi, je voudrais figer la v3 pour la démo client.",
      "À très vite,\nCamille",
    ],
    time: "09:41",
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
    unread: true,
    starred: false,
    pgp: "signed",
    tone: 2,
  },
  {
    id: "3",
    account: "pro",
    folder: "inbox",
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
    unread: true,
    starred: true,
    pgp: "encrypted",
    attachments: [{ name: "avenant-phase2.pdf", size: "310 Ko" }],
    tone: 1,
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
    unread: false,
    starred: false,
    pgp: "none",
    tone: 3,
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
    unread: true,
    starred: false,
    pgp: "none",
    tone: 5,
  },
  {
    id: "10",
    account: "pro",
    folder: "sent",
    name: "Roman",
    email: "roman@studio-lilas.fr",
    subject: "Re: Devis signé — retour de ma part",
    preview: "Parfait Marc, merci. Je lance la phase 2 lundi, je te transmets le planning dans la journée.",
    body: ["Parfait Marc, merci.", "Je lance la phase 2 lundi, je te transmets le planning dans la journée."],
    time: "lun.",
    unread: false,
    starred: false,
    pgp: "encrypted",
    tone: 0,
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
    time: "12 sept.",
    unread: false,
    starred: true,
    pgp: "encrypted",
    tone: 0,
  },
];

export const RECENT_SEARCHES = ["camille", "factures", "devis signé", "figma"];
