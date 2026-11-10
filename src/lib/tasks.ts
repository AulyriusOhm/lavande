export type TaskState = "todo" | "doing" | "waiting" | "review" | "done";

export type Subtask = { title: string; done: boolean };

export type Task = {
  id: string;
  title: string;
  meta: string;
  state: TaskState;
  due: string;
  dueTone: "late" | "soon" | "soft" | "none";
  dueDate?: string;
  progress?: number;
  description?: string;
  subtasks?: Subtask[];
  mailId?: string;
};

export const TASK_STATES: {
  id: TaskState;
  label: string;
  dot: string;
  chip: string;
}[] = [
  { id: "todo", label: "À faire", dot: "bg-accent", chip: "bg-accent-soft text-accent-ink" },
  { id: "doing", label: "En cours", dot: "bg-sky-500", chip: "bg-sky-500/12 text-sky-700 dark:text-sky-300" },
  { id: "waiting", label: "En attente", dot: "bg-amber-500", chip: "bg-amber-500/12 text-amber-700 dark:text-amber-300" },
  { id: "review", label: "À valider", dot: "bg-fuchsia-500", chip: "bg-fuchsia-500/12 text-fuchsia-700 dark:text-fuchsia-300" },
  { id: "done", label: "Fait", dot: "bg-emerald-500", chip: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" },
];

export function stateMeta(state: TaskState) {
  return TASK_STATES.find((entry) => entry.id === state) ?? TASK_STATES[0];
}

export const TASKS: Task[] = [
  {
    id: "t10",
    title: "Valider la v3 pour la démo client",
    meta: "mail · Perso · Camille",
    state: "todo",
    due: "vendredi",
    dueTone: "soon",
    dueDate: isoToday(3),
    mailId: "1",
    description:
      "Camille veut figer la v3 avant la démo. Relire les écrans, vérifier les contrastes en extérieur et répondre avec les deux points bloquants (barre de recherche flottante, hiérarchie des chips).",
    subtasks: [
      { title: "Relire les écrans de la boîte", done: true },
      { title: "Vérifier le contraste en extérieur", done: false },
      { title: "Répondre à Camille", done: false },
    ],
  },
  {
    id: "t2",
    title: "Atelier couleur & tokens",
    meta: "événement · Studio · 14:00 → 15:30",
    state: "doing",
    due: "aujourd'hui",
    dueTone: "soon",
    dueDate: isoToday(0),
    progress: 45,
    description:
      "Passer la palette en revue avec l'équipe : accent personnalisable, variantes sombres et nouveaux tokens de surface.",
    subtasks: [
      { title: "Préparer la planche de couleurs", done: true },
      { title: "Exporter les tokens JSON", done: false },
    ],
  },
  {
    id: "t3",
    title: "Accès serveur (Marc)",
    meta: "mail · Studio · sans réponse depuis 3 j",
    state: "waiting",
    due: "il y a 2 j",
    dueTone: "late",
    dueDate: isoToday(-2),
    mailId: "3",
    description:
      "Marc devait transmettre les accès serveur dans la journée. Relancer si rien n'arrive avant la fin de semaine.",
    subtasks: [{ title: "Relancer Marc", done: false }],
  },
  {
    id: "t4",
    title: "Avenant phase 2 signé",
    meta: "pièce jointe · PDF · à archiver",
    state: "review",
    due: "demain",
    dueTone: "soon",
    dueDate: isoToday(1),
    mailId: "3",
    description: "L'avenant signé est arrivé en pièce jointe. Le classer dans le dossier administratif du projet.",
    subtasks: [
      { title: "Vérifier la signature", done: true },
      { title: "Archiver dans le dossier projet", done: false },
    ],
  },
  {
    id: "t6",
    title: "Importer la clé PGP de Léa",
    meta: "sécurité · clé expirée le 2 juin",
    state: "todo",
    due: "cette semaine",
    dueTone: "soft",
    dueDate: isoEndOfWeek(),
    description:
      "La clé de Léa n'est plus vérifiée et a expiré. Lui demander une nouvelle clé signée, puis la marquer de confiance complète.",
  },
  {
    id: "t7",
    title: "Point maquettes avec Camille",
    meta: "événement · visio · 10:00",
    state: "done",
    due: "terminé",
    dueTone: "none",
    description: "Point de 30 minutes : arbitrage sur la v3 et sur la barre de recherche.",
  },
  {
    id: "t8",
    title: "Archiver le brief v2",
    meta: "mail · Perso",
    state: "done",
    due: "hier",
    dueTone: "none",
    mailId: "11",
    description: "Version validée et archivée. Les deux variantes de barre de recherche restent dans Figma.",
  },
  {
    id: "t11",
    title: "Ranger le dossier Design System",
    meta: "manuel",
    state: "done",
    due: "lundi dernier",
    dueTone: "none",
    description: "Trier les pages obsolètes et fusionner les doublons de tokens.",
  },
];

export type MailSuggestion = {
  id: string;
  mailId: string;
  account: "perso" | "pro" | "gmail";
  from: string;
  subject: string;
  proposal: string;
  due: string;
  dueTone: Task["dueTone"];
  tone: number;
  description: string;
};

export const MAIL_SUGGESTIONS: MailSuggestion[] = [
  {
    id: "s1",
    mailId: "1",
    account: "perso",
    from: "Camille Rousseau",
    subject: "Maquettes mobiles — version 3",
    proposal: "Répondre à Camille",
    due: "vendredi",
    dueTone: "soon",
    tone: 0,
    description:
      "Camille attend un retour sur la v3 des maquettes avant vendredi : contrastes, hiérarchie, et variante de barre de recherche flottante.",
  },
  {
    id: "s2",
    mailId: "2",
    account: "perso",
    from: "GitHub",
    subject: "[lavande] Rust backend: 3 pull requests",
    proposal: "Relire les 3 pull requests",
    due: "jeudi",
    dueTone: "soft",
    tone: 2,
    description: "feat/imap-sync, fix/oauth-refresh et chore/tauri-v2 attendent une revue.",
  },
  {
    id: "s3",
    mailId: "8",
    account: "pro",
    from: "OVHcloud",
    subject: "Facture F2026-1187 disponible",
    proposal: "Envoyer la facture au comptable",
    due: "cette semaine",
    dueTone: "soft",
    tone: 0,
    description: "Facture de 11,98 € TTC pour octobre, prélèvement le 15.",
  },
];

export function isoDate(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function isoToday(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return isoDate(date);
}

export function isoEndOfWeek() {
  return isoToday(6 - ((new Date().getDay() + 6) % 7));
}

const DUE_FMT = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short" });

export function formatDueDate(iso: string) {
  if (iso === isoToday(0)) return "aujourd'hui";
  if (iso === isoToday(1)) return "demain";
  return DUE_FMT.format(new Date(`${iso}T12:00:00`)).replace(/\./g, "").replace(/[\u202f\u00a0]/g, " ");
}

export function dueToneFor(iso: string): Task["dueTone"] {
  const today = isoToday();
  if (iso < today) return "late";
  if (iso <= isoToday(1)) return "soon";
  return "soft";
}

const DUE_ORDER: Record<Task["dueTone"], number> = { late: 0, soon: 1, soft: 2, none: 3 };

export function taskFromSuggestion(suggestion: MailSuggestion, id: string): Task {
  return {
    id,
    title: suggestion.proposal,
    meta: "mail · " + suggestion.from,
    state: "todo",
    due: suggestion.due,
    dueTone: suggestion.dueTone,
    description: suggestion.description,
    mailId: suggestion.mailId,
  };
}

export function sortTasks(tasks: Task[]) {
  return [...tasks].sort((a, b) => {
    if (a.state === "done" && b.state !== "done") return 1;
    if (b.state === "done" && a.state !== "done") return -1;
    const byDue = DUE_ORDER[a.dueTone] - DUE_ORDER[b.dueTone];
    return byDue !== 0 ? byDue : a.title.localeCompare(b.title);
  });
}
