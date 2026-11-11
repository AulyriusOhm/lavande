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
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function htmlToText(html: string): string {
  if (!html || !html.trim()) return "";
  const withBreaks = html
    .replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/li|\/blockquote|\/pre|\/tr)\s*\/?>/gi, "\n")
    .replace(/<\s*hr\s*\/?>/gi, "\n");
  const doc = new DOMParser().parseFromString(withBreaks, "text/html");
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

export function isHtmlEmpty(html: string): boolean {
  return htmlToText(html).length === 0;
}

export function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

export function ensureHtml(value: string): string {
  if (!value.trim()) return "";
  return looksLikeHtml(value) ? value : textToHtml(value);
}