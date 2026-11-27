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

const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "ins",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const DROPPED_SUBTREE_TAGS = new Set([
  "applet",
  "base",
  "button",
  "embed",
  "form",
  "head",
  "iframe",
  "input",
  "link",
  "math",
  "meta",
  "noscript",
  "object",
  "option",
  "script",
  "select",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
]);

const GENERIC_ATTRS = new Set(["class", "dir", "lang", "title"]);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "rel", "target"]),
  img: new Set(["alt", "height", "src", "width"]),
  table: new Set(["align"]),
  td: new Set(["align", "colspan", "rowspan"]),
  th: new Set(["align", "colspan", "rowspan"]),
};

const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

function normalizeSchemeCandidate(raw: string): string {
  // Retire espaces et caractères de contrôle ASCII que les navigateurs ignorent
  // dans une URL (`java&#x09;script:`, `\u0001javascript:`, etc.).
  return raw.replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
}

function isSafeHref(raw: string): boolean {
  const normalized = normalizeSchemeCandidate(raw);
  if (!normalized) return false;
  if (normalized.startsWith("#") || normalized.startsWith("/")) return true;
  if (
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("mailto:")
  ) {
    return true;
  }
  const colon = normalized.indexOf(":");
  const slash = normalized.indexOf("/");
  return colon === -1 || (slash !== -1 && slash < colon);
}

function isSafeImageSrc(raw: string): boolean {
  const trimmed = raw.trim();
  if (SAFE_DATA_IMAGE.test(trimmed)) return true;
  const normalized = normalizeSchemeCandidate(trimmed);
  if (!normalized) return false;
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) return true;
  if (normalized.startsWith("/")) return true;
  const colon = normalized.indexOf(":");
  const slash = normalized.indexOf("/");
  return colon === -1 || (slash !== -1 && slash < colon);
}

/** Nettoie un HTML riche par liste blanche stricte avant rendu dans le DOM. */
export function sanitizeHtml(html: string): string {
  if (!html || !html.trim()) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");

  const walk = (parent: Element) => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (DROPPED_SUBTREE_TAGS.has(tag)) {
        el.remove();
        continue;
      }
      walk(el);
      if (!ALLOWED_TAGS.has(tag)) {
        el.replaceWith(...Array.from(el.childNodes));
        continue;
      }
      const allowedForTag = TAG_ATTRS[tag];
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (!GENERIC_ATTRS.has(name) && !allowedForTag?.has(name)) {
          el.removeAttribute(attr.name);
          continue;
        }
        if (tag === "a" && name === "href" && !isSafeHref(attr.value)) {
          el.removeAttribute(attr.name);
        } else if (tag === "img" && name === "src" && !isSafeImageSrc(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }
    }
  };

  walk(doc.body);
  return doc.body.innerHTML;
}