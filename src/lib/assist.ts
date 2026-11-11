import { llmChat, type LlmConfig } from "@/lib/llm";

export type ReplySuggestion = { id: string; badge: string; text: string };
export type RewriteOption = {
  id: "correction" | "concis" | "formel" | "chaleureux";
  label: string;
  hint: string;
};

const REPLY_SYSTEM =
  "Tu rédiges des réponses d'emails en français, naturelles et concises. " +
  "Réponds uniquement avec le corps de la réponse, sans objet ni signature, sans markdown.";

const REWRITE_SYSTEM =
  "Tu réécris le corps d'un email en français selon la consigne. " +
  "Réponds uniquement avec le texte réécrit, sans markdown ni commentaire.";

export async function aiComposeReply(
  config: LlmConfig,
  input: { subject: string; to: string; body: string },
  brief: string,
): Promise<ReplySuggestion> {
  const user = `Objet : ${input.subject}\nDestinataire : ${input.to}\nMessage reçu :\n${input.body}\n\nConsigne pour la réponse : ${brief}`;
  const text = await llmChat(config, REPLY_SYSTEM, user);
  return { id: "custom", badge: "IA", text };
}

export async function aiRewrite(config: LlmConfig, label: string, body: string): Promise<string> {
  return llmChat(config, REWRITE_SYSTEM, `Consigne : ${label}\n\nTexte à réécrire :\n${body}`);
}

const QUOTE_MARK = "\n\n---\n";
const EXCERPT_MAX = 90;
const LETTERS = /^[a-zà-öø-ÿ]+$/i;

export function userPart(body: string): string {
  if (body.startsWith("---\n")) return "";
  const at = body.indexOf(QUOTE_MARK);
  return at === -1 ? body : body.slice(0, at);
}

export function replaceUserPart(body: string, next: string): string {
  return next + body.slice(userPart(body).length);
}

function greeting(to: string): string {
  const local = (to.split("@")[0] ?? "").trim();
  const first = local.split(/[._\-\d]/)[0] ?? "";
  if (!LETTERS.test(first)) return "Bonjour,";
  return `Bonjour ${first.charAt(0).toUpperCase()}${first.slice(1).toLowerCase()},`;
}

function firstQuoteLine(text: string): string {
  for (const line of text.split("\n")) {
    if (!/^\s*>/.test(line)) continue;
    const clean = line.replace(/^\s*(>\s*)+/, "").replace(/\s+/g, " ").trim();
    if (!clean) continue;
    return clean.length > EXCERPT_MAX ? `${clean.slice(0, EXCERPT_MAX - 1).trimEnd()}…` : clean;
  }
  return "";
}

function excerptOf(body: string): string {
  return firstQuoteLine(body.slice(userPart(body).length)) || firstQuoteLine(body);
}

export function replySuggestions(input: { subject: string; to: string; body: string }): ReplySuggestion[] {
  const hello = greeting(input.to);
  const excerpt = excerptOf(input.body);
  const about = excerpt ? ` au sujet de « ${excerpt} »` : "";

  return [
    {
      id: "accept",
      badge: "Accepter",
      text: [
        hello,
        `Merci pour ton message${about}. C'est noté de mon côté : je m'en occupe et je te tiens au courant.`,
        "Si un détail change, dis-le-moi simplement.",
      ].join("\n"),
    },
    {
      id: "schedule",
      badge: "Planifier",
      text: [
        hello,
        `Merci pour ton message${about}. On en parle cette semaine ? Je suis dispo mardi et jeudi en fin de matinée.`,
        "Dis-moi le créneau qui t'arrange, je t'envoie l'invitation.",
      ].join("\n"),
    },
    {
      id: "delay",
      badge: "Demander un délai",
      text: [
        hello,
        `Merci pour ton message${about}. J'ai besoin d'un peu plus de temps pour vérifier les éléments avant de te répondre précisément.`,
        "Je te fais un retour complet d'ici vendredi, et je reste joignable si c'est urgent.",
      ].join("\n"),
    },
  ];
}

export function rewriteOptions(): RewriteOption[] {
  return [
    { id: "correction", label: "Correction", hint: "Majuscules, espaces et point final." },
    { id: "concis", label: "Concis", hint: "Deux phrases maximum, droit au but." },
    { id: "formel", label: "Formel", hint: "Vouvoiement et formule de politesse." },
    { id: "chaleureux", label: "Chaleureux", hint: "Ton amical et formule du jour." },
  ];
}

function finish(text: string): string {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed) return "";
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function capitalizeStarts(text: string): string {
  return text.replace(
    /(^|[.!?]\s+|\n[ \t]*)([a-zà-öø-ÿ])/g,
    (_match, lead: string, letter: string) => lead + letter.toUpperCase(),
  );
}

const LINK = /(?:https?:\/\/|www\.)\S+|\S+@\S+/g;

function maskLinks(text: string): { text: string; links: string[] } {
  const links: string[] = [];
  const masked = text.replace(LINK, (match) => {
    links.push(match);
    return `\u0001${links.length - 1}\u0001`;
  });
  return { text: masked, links };
}

function unmaskLinks(text: string, links: string[]): string {
  return text.replace(/\u0001(\d+)\u0001/g, (_match, index: string) => links[Number(index)] ?? "");
}

function correction(text: string): string {
  const masked = maskLinks(text);
  const tightened = masked.text
    .replace(/[ \t]+/g, " ")
    .replace(/ +([,;:.!?])/g, "$1")
    .replace(/([,;:!?.])(?=[A-Za-zà-öø-ÿ])/g, "$1 ")
    .replace(/ {2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/^[ \t]+/gm, "");
  return finish(unmaskLinks(capitalizeStarts(tightened).replace(/^([ \t]*)je\b/gm, "$1Je"), masked.links));
}

function concis(text: string): string {
  const sentences = text.match(/[\s\S]*?[.!?…]+(?=\s|$)|[\s\S]+$/g) ?? [];
  const kept = sentences.slice(0, 2).join("").trim();
  if (!kept) return text;
  const normalized = correction(kept);
  return sentences.length > 2 ? `${normalized} Merci d'avance.` : normalized;
}

function formel(text: string): string {
  const replaced = text
    .replace(/\b(salut|coucou)\b/gi, "Bonjour")
    .replace(/\bça\b/gi, "cela")
    .replace(/\bje te\b/gi, (match) => `${match[0] === "J" ? "Je" : "je"} vous`)
    .replace(/\bton\b/gi, "votre")
    .replace(/\bta\b/gi, "votre")
    .replace(/\btes\b/gi, "vos")
    .replace(/\btu\b/gi, "vous");
  const corrected = correction(replaced);
  return /bien cordialement/i.test(corrected) ? corrected : `${corrected}\n\nBien cordialement,`;
}

function chaleureux(text: string): string {
  const replaced = text
    .replace(/\bBonjour\b/g, "Salut")
    .replace(/\bbonjour\b/g, "salut")
    .replace(/\b(je vous remercie)\b/gi, (match) => (match[0] === "J" ? "Merci beaucoup" : "merci beaucoup"))
    .replace(/\s+$/, "")
    .replace(/(^|\n)([ \t]*)salut\b/g, "$1$2Salut");
  const corrected = correction(replaced);
  return /bonne journée/i.test(corrected) ? corrected : `${corrected}\n\nBonne journée !`;
}

const REWRITES: Record<RewriteOption["id"], (text: string) => string> = {
  correction,
  concis,
  formel,
  chaleureux,
};

export function rewriteBody(id: RewriteOption["id"], body: string): string {
  const part = userPart(body);
  if (!part.trim()) return body;
  return replaceUserPart(body, REWRITES[id](part));
}

const CLOSINGS: { test: RegExp; line: string }[] = [
  { test: /merci|remercie/i, line: "Merci d'avance." },
  { test: /délai|delai|attendre|plus tard|reviens|retour/i, line: "Je te tiens au courant dès que possible." },
  {
    test: /dispo|créneau|creneau|lundi|mardi|jeudi|vendredi|réunion|reunion|appel|point|visio/i,
    line: "Dis-moi ce qui t'arrange.",
  },
  { test: /week-end|weekend|soir|bise|bonne/i, line: "À très vite," },
];

const closingFor = (text: string) => CLOSINGS.find((entry) => entry.test.test(text))?.line ?? "Bonne journée !";

const HAS_CLOSING = /(merci|cordialement|bonne journée|bonne soirée|à très vite|à bientôt|bises?)\s*[.!,]?\s*$/i;

const VERBS: Record<string, string> = {
  accepter: "J'accepte",
  annuler: "J'annule",
  confirmer: "Je confirme",
  decaler: "Je propose de décaler",
  décaler: "Je propose de décaler",
  demander: "Je te demande",
  envoyer: "Je t'envoie",
  preparer: "Je prépare",
  préparer: "Je prépare",
  proposer: "Je te propose",
  refuser: "Je décline",
  remercier: "Je te remercie",
  reporter: "Je propose de reporter",
  repondre: "Je te réponds",
  répondre: "Je te réponds",
  valider: "Je valide",
  verifier: "Je vérifie",
  vérifier: "Je vérifie",
};

function firstPerson(text: string): string {
  const [word, ...rest] = text.split(/\s+/);
  const verb = VERBS[word.toLowerCase().replace(/[.,;:!?]+$/, "")];
  if (!verb || !rest.length) return text;
  return `${verb} ${rest.join(" ")}`;
}

export function composeReply(input: { subject: string; to: string; body: string; brief: string }): ReplySuggestion {
  const raw = input.brief.trim();
  if (!raw) return { ...replySuggestions(input)[0], id: "custom", badge: "Sur mesure" };

  const stripped = correction(raw).replace(/^(bonjour|salut|coucou|hello)\b[^,\n]{0,40},\s*/i, "").trim();
  const payload = firstPerson(stripped.charAt(0).toUpperCase() + stripped.slice(1));
  const excerpt = excerptOf(input.body);
  const mentionsContext = excerpt && payload.toLowerCase().includes(excerpt.slice(0, 24).toLowerCase());
  const politelyAlready = /^(merci|je te remercie|un grand merci)/i.test(payload);
  const context =
    excerpt && payload.length < 70 && !mentionsContext && !politelyAlready
      ? `Merci pour ton message au sujet de « ${excerpt} ». `
      : "";
  const closing = HAS_CLOSING.test(payload) ? "" : `\n\n${closingFor(payload)}`;

  return {
    id: "custom",
    badge: "Sur mesure",
    text: `${greeting(input.to)}\n\n${context}${payload}${closing}`,
  };
}
