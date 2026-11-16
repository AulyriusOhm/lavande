import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true, async: false });

export function markdownToHtml(markdown: string): string {
  return marked.parse(markdown) as string;
}

export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\([^)\n]+\)|`[^`\n]+`/.test(
    text,
  );
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function textToHtml(text: string): string {
  if (!text.trim()) return "";
  return text
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim())
    .map((paragraph) => `<p>${escapeHtml(paragraph.replace(/^\n+|\n+$/g, "")).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

const IMAGE_TAG = /<img\b[^>]*>/gi;
const IMAGE_ALT = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/** Une image ne rend aucun texte : elle devient son `alt`, ou `[image]`. */
function imageLabel(tag: string): string {
  const alt = IMAGE_ALT.exec(tag);
  const label = (alt?.[1] ?? alt?.[2] ?? "").trim();
  return label ? `[${label}]` : "[image]";
}

const AUTOLINK = /<((?:https?|mailto|ftp):[^<>\s]+)>/gi;

export function htmlToText(html: string): string {
  if (!html || !html.trim()) return "";
  const withBreaks = html
    .replace(AUTOLINK, "$1")
    .replace(IMAGE_TAG, imageLabel)
    .replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/li|\/blockquote|\/pre|\/tr)\s*\/?>/gi, "\n")
    .replace(/<\s*hr\s*\/?>/gi, "\n");
  const doc = new DOMParser().parseFromString(withBreaks, "text/html");
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

export function isHtmlEmpty(html: string): boolean {
  return htmlToText(html).length === 0;
}

const IMAGE_TOKEN = /⟦img-(\d+)⟧/g;

/** Remplace chaque image par un jeton ⟦img-N⟧ pour la faire traverser une réécriture de texte. */
export function extractImageTokens(html: string): { text: string; images: string[] } {
  const images: string[] = [];
  const withTokens = html.replace(IMAGE_TAG, (tag) => {
    images.push(tag);
    return `⟦img-${images.length - 1}⟧`;
  });
  return { text: htmlToText(withTokens), images };
}

/** Réinsère les images à la place de leur jeton ; celles dont le jeton a disparu sont ajoutées en fin. */
export function restoreImageTokens(text: string, images: string[]): string {
  if (images.length === 0) return textToHtml(text);
  const used = new Set<number>();
  let html = "";
  let cursor = 0;
  for (const match of text.matchAll(IMAGE_TOKEN)) {
    html += textToHtml(text.slice(cursor, match.index));
    const index = Number(match[1]);
    if (images[index] && !used.has(index)) {
      used.add(index);
      html += images[index];
    }
    cursor = match.index + match[0].length;
  }
  html += textToHtml(text.slice(cursor));
  const missing = images.filter((_tag, index) => !used.has(index));
  return html + missing.join("");
}

/** L'historique cité voyage dans un bloc à part, marqué pour être reconnu au retour. */
export function buildQuotedHtml(attribution: string, innerHtml: string): string {
  return `<blockquote class="lavande-quote"><p class="lavande-quote-head">${escapeHtml(attribution)}</p>${innerHtml}</blockquote>`;
}

/** Sépare le nouveau message de l'historique cité qu'un brouillon rechargé contient encore. */
export function splitQuotedBody(html: string): { body: string; quoted: string } {
  if (!html || !html.trim()) return { body: html ?? "", quoted: "" };
  const doc = new DOMParser().parseFromString(html, "text/html");
  const block = doc.body.querySelector("blockquote.lavande-quote");
  if (!block) return { body: html, quoted: "" };
  const quoted = block.outerHTML;
  block.remove();
  const body = doc.body.innerHTML.replace(/(?:<br\s*\/?>\s*)+$/i, "").trimEnd();
  return { body, quoted };
}

const HTML_TAG =
  /<\/?(?:article|blockquote|body|center|code|div|font|head|html|img|pre|section|span|strong|table|tbody|td|th|thead|tr|ul|hr|br|h[1-6]|a|b|em|i|u|li|ol|p)\b[^>]*>/i;

export function looksLikeHtml(value: string): boolean {
  return HTML_TAG.test(value);
}

export function ensureHtml(value: string): string {
  if (!value.trim()) return "";
  return looksLikeHtml(value) ? value : textToHtml(value);
}

const BLOCKED_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "form",
  "input",
  "button",
  "textarea",
  "select",
]);

/** Nettoie un HTML riche avant rendu : pas de script, d'iframe ni de gestionnaire d'événement. */
export function sanitizeHtml(html: string): string {
  if (!html || !html.trim()) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.body.querySelectorAll("*").forEach((el) => {
    if (BLOCKED_TAGS.has(el.tagName.toLowerCase())) {
      el.remove();
      return;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith("on") || ((name === "href" || name === "src") && value.startsWith("javascript:"))) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body.innerHTML;
}