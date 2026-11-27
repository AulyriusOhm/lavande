import { useCallback, useEffect, useRef, useState } from "react";
import { ImageOff, Loader2 } from "lucide-react";
import { errorText } from "@/lib/api";
import { demoReadOnly } from "@/lib/demo-mode";
import type { MailSource } from "@/lib/mail";
import { htmlImagesOf } from "@/lib/mail-backend";
import { openExternal } from "@/lib/open-external";
import { usePrefs } from "@/lib/prefs";
import { normalizeTrustedSender } from "@/lib/triage";
import { cn } from "@/lib/utils";
import jakartaFont from "@/assets/fonts/plus-jakarta-sans-latin.woff2?url";
import jakartaFontExt from "@/assets/fonts/plus-jakarta-sans-latin-ext.woff2?url";

type Reveal = { key: string; html?: string; error?: string; busy?: boolean };

type Palette = {
  ink: string;
  inkSoft: string;
  inkMuted: string;
  line: string;
  surface2: string;
  accentMix: string;
  accentWeight: number;
};

const LIGHT: Palette = {
  ink: "#1b1523",
  inkSoft: "#6b6478",
  inkMuted: "#726c7f",
  line: "#ece8f5",
  surface2: "#f6f3fd",
  accentMix: "#241b3a",
  accentWeight: 58,
};

const DARK: Palette = {
  ink: "#f4f1fa",
  inkSoft: "#a8a1b8",
  inkMuted: "#8c8699",
  line: "#2a2438",
  surface2: "#1d1929",
  accentMix: "#ffffff",
  accentWeight: 55,
};

const DEFAULT_ACCENT = "#8b7cf6";
const HEX = /^#[0-9a-f]{3,8}$/i;
const MAX_HEIGHT = 900;
const MOBILE_WIDTH = 720;
/** Agrandissement maximal du document mail sur un panneau large (ultrawide). */
const MAX_ZOOM = 1.8;
/** En dessous de ce facteur, le gain ne vaut pas la mise à l'échelle. */
const ZOOM_DEADBAND = 1.05;

const UNIT_PX: Record<string, number> = {
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
};

function absolutePx(value: string): number | null {
  const match = /^\s*(-?\d*\.?\d+)\s*(px|pt|pc|in|cm|mm|q)\s*$/i.exec(value);
  if (!match) return null;
  const size = Number.parseFloat(match[1]) * UNIT_PX[match[2].toLowerCase()];
  return Number.isFinite(size) ? size : null;
}

type Theme = { dark: boolean; accent: string };

function themeSnapshot(): Theme {
  const root = document.documentElement;
  const accent = root.style.getPropertyValue("--accent").trim();
  return { dark: root.classList.contains("dark"), accent: HEX.test(accent) ? accent : DEFAULT_ACCENT };
}

/** Feuille de repli du document mail : la palette de DESIGN.md pour le contenu
 *  que le mail ne style pas lui-même, sans dépendre du CSS de l'app (l'iframe a
 *  son propre document). Aucune règle de mise en page au-dessus de 720px : les
 *  bordures de cellules, les marges de paragraphes et la largeur des tables
 *  appartiennent au mail. En dessous, la feuille ne pose que des aides neutres
 *  (`box-sizing`, `html` et `body` à 100%, cellules `nowrap` autorisées à
 *  replier, images sans hauteur figée) : aucune règle `!important` n'écrase le
 *  design de l'expéditeur. Les largeurs absolues qui débordent vraiment sont
 *  neutralisées à la source par `fitMailWidth`. */
export function mailStyles({ dark, accent }: Theme) {
  const palette = dark ? DARK : LIGHT;
  return `@font-face{font-family:"Plus Jakarta Sans";font-style:normal;font-weight:300 800;font-display:swap;src:url("${jakartaFont}") format("woff2")}
@font-face{font-family:"Plus Jakarta Sans";font-style:normal;font-weight:300 800;font-display:swap;src:url("${jakartaFontExt}") format("woff2")}
:root{
  color-scheme:${dark ? "dark" : "light"};
  --accent:${accent};
  --ink:${palette.ink};
  --ink-soft:${palette.inkSoft};
  --ink-muted:${palette.inkMuted};
  --line:${palette.line};
  --surface-2:${palette.surface2};
  --accent-ink:color-mix(in oklab,var(--accent) ${palette.accentWeight}%,${palette.accentMix});
}
html{background:transparent;color:var(--ink)}
body{margin:0;background:transparent;color:var(--ink-soft);font-family:"Plus Jakarta Sans",ui-sans-serif,system-ui,-apple-system,sans-serif;font-size:13.5px;line-height:1.7;font-weight:500;overflow-wrap:anywhere}
img{max-width:100%;height:auto}
a{color:var(--accent-ink);text-decoration:underline;text-underline-offset:2px}
blockquote{margin:0 0 .85em;padding-left:.9em;border-left:3px solid var(--line);color:var(--ink-muted)}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}
pre{white-space:pre-wrap;background:var(--surface-2);padding:.6em;border-radius:.5em}
@media (max-width:720px){
*,:before,:after{box-sizing:border-box!important}
html,body{width:100%!important;max-width:100%!important;min-width:0!important}
td,th{white-space:normal!important}
img{height:auto!important}
}`;
}

const MAIL_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob: http: https:; font-src 'self' data:; script-src 'none'";

export function mailDocument(body: string, theme: Theme) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${MAIL_CSP}">
<base target="_blank">
<style>${mailStyles(theme)}</style>
</head>
<body>${body}</body>
</html>`;
}

/**
 * Sous 720px, neutralise **à la source** les contraintes de largeur que le mail
 * impose et que notre feuille de repli ne cherche plus à battre :
 * `body{width:600px}` ou `.wrap{min-width:600px}` réinjectés en tête du body,
 * styles inline et attributs `width` de table, de cellule et d'image. Une
 * largeur absolue plus large que le cadre passe à `100%`, une largeur minimale
 * à `0` ; couleurs, polices, marges et remplissages ne sont jamais touchés, le
 * mail garde son identité.
 */
export function fitMailWidth(contentDocument: Document, available: number) {
  if (!(available > 0) || available >= MOBILE_WIDTH) return;

  const constrain = (style: CSSStyleDeclaration | null) => {
    if (!style) return;
    for (const property of ["width", "min-width"]) {
      const size = absolutePx(style.getPropertyValue(property));
      if (size === null || size <= available) continue;
      const important = style.getPropertyPriority(property) === "important";
      const next = property === "width" ? "100%" : "0";
      style.setProperty(property, next, important ? "important" : "");
    }
  };

  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested) walk(nested);
      constrain((rule as CSSStyleRule).style ?? null);
    }
  };

  for (const sheet of Array.from(contentDocument.styleSheets)) {
    try {
      const rules = sheet.cssRules;
      if (rules) walk(rules);
    } catch {
      continue;
    }
  }

  for (const element of Array.from(contentDocument.querySelectorAll<HTMLElement>("*"))) {
    constrain(element.style);
    const attribute = element.getAttribute("width");
    if (!attribute) continue;
    const tag = element.tagName.toLowerCase();
    if (tag !== "table" && tag !== "td" && tag !== "th" && tag !== "img") continue;
    const size = absolutePx(/^\d+(\.\d+)?$/.test(attribute) ? `${attribute}px` : attribute);
    if (size !== null && size > available) element.setAttribute("width", "100%");
  }

  for (const element of [contentDocument.documentElement, contentDocument.body]) {
    element?.style.setProperty("width", "100%", "important");
    element?.style.setProperty("min-width", "0", "important");
  }
}

/**
 * Facteur d'agrandissement du document mail pour la largeur disponible : jamais
 * de réduction (plancher 1), plafond à 1,8 pour que le texte reste lisible quand
 * un mail de 600px laisserait vide la moitié d'un écran ultrawide. Sous le
 * deadband de 1,05 le gain est invisible : on garde le rendu natif.
 */
export function mailZoomScale(available: number, design: number): number {
  if (!(available > 0) || !(design > 0)) return 1;
  const scale = Math.min(available / design, MAX_ZOOM);
  return scale < ZOOM_DEADBAND ? 1 : scale;
}

/**
 * Sur un panneau plus large que le design du mail (ultrawide à 3440px, lettre
 * d'info large de 600px), le document est mis à l'échelle pour occuper la
 * largeur disponible au lieu de laisser des marges vides : proportions et design
 * intacts, seule la taille de rendu change.
 *
 * La largeur naturelle du design est relevée à zoom 1 : tout `zoom` est retiré,
 * les largeurs de `body` et de `html` passent à `max-content` le temps de lire
 * `body.scrollWidth`, puis les largeurs d'origine sont restaurées telles quelles
 * (une largeur inline du mail, `body{width:600px}`, survit à la mesure). Le
 * facteur vient de `mailZoomScale` : plafond 1,8, deadband 1,05. La propriété
 * CSS `zoom` met le **layout** à l'échelle (et non une transformation visuelle),
 * donc la hauteur relue ensuite par `measure()` via
 * `documentElement.scrollHeight` suit le facteur — d'où l'ordre `fitMailWidth`,
 * `fitMailZoom`, `measure`. Un mail déjà fluide (`width:100%`) a un design proche
 * de la largeur disponible : il n'est pas agrandi. Sous 720px rien n'est zoomé,
 * le rendu reste gouverné par `fitMailWidth`. Les tables centrées (`margin:auto`)
 * restent centrées dans l'espace zoomé.
 */
export function fitMailZoom(contentDocument: Document, available: number) {
  const body = contentDocument.body;
  if (!body) return;

  body.style.removeProperty("zoom");
  if (!(available > 0) || available < MOBILE_WIDTH) return;

  const root = contentDocument.documentElement;
  const saved = [body, root].map((element) => ({
    style: element.style,
    width: element.style.getPropertyValue("width"),
    priority: element.style.getPropertyPriority("width"),
  }));
  body.style.setProperty("width", "max-content");
  root.style.setProperty("width", "max-content");
  const design = body.scrollWidth;
  for (const entry of saved) {
    if (entry.width) entry.style.setProperty("width", entry.width, entry.priority);
    else entry.style.removeProperty("width");
  }

  const scale = mailZoomScale(available, design);
  if (scale > 1) body.style.setProperty("zoom", String(scale));
}

type Rgb = { r: number; g: number; b: number; a: number };

/** En deçà de cette luminance relative (WCAG), un texte est noir. */
const BLACK_TEXT_LUMINANCE = 0.12;
/** En deçà, un texte est sombre : noir sur le fond sombre de l'app. */
const DARK_TEXT_LUMINANCE = 0.42;
/** Au-delà, un fond est clair : le texte sombre posé dessus reste lisible. */
const LIGHT_BACKDROP_LUMINANCE = 0.5;
/** Un fond plus transparent que ça laisse voir celui du dessous. */
const OPAQUE_BACKDROP_ALPHA = 0.5;

const COLOR_NAMES: Record<string, string> = {
  transparent: "#00000000",
  black: "#000000",
  white: "#ffffff",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  dimgray: "#696969",
  dimgrey: "#696969",
  gainsboro: "#dcdcdc",
  whitesmoke: "#f5f5f5",
  red: "#ff0000",
  maroon: "#800000",
  orange: "#ffa500",
  yellow: "#ffff00",
  olive: "#808000",
  lime: "#00ff00",
  green: "#008000",
  teal: "#008080",
  blue: "#0000ff",
  navy: "#000080",
  aqua: "#00ffff",
  cyan: "#00ffff",
  purple: "#800080",
  fuchsia: "#ff00ff",
  magenta: "#ff00ff",
};

/** Luminance relative WCAG : 0 pour le noir, 1 pour le blanc. */
function relativeLuminance({ r, g, b }: Rgb): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function hexColor(digits: string): Rgb | null {
  if (!/^[0-9a-f]+$/.test(digits)) return null;
  const full = digits.length <= 4 ? [...digits].map((digit) => digit + digit).join("") : digits;
  if (full.length !== 6 && full.length !== 8) return null;
  const byte = (start: number) => Number.parseInt(full.slice(start, start + 2), 16);
  return { r: byte(0), g: byte(2), b: byte(4), a: full.length === 8 ? byte(6) / 255 : 1 };
}

/** `#hex` (3, 4, 6, 8), `rgb()`/`rgba()`, quelques noms CSS ; le reste rend `null`. */
function parseColor(value: string): Rgb | null {
  const text = value.trim().toLowerCase();
  const hex = COLOR_NAMES[text] ?? (text.startsWith("#") ? text : null);
  if (!hex) {
    const channels = /^rgba?\(([^)]*)\)$/
      .exec(text)?.[1].split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (!channels) return null;
    if (channels.length < 3 || channels.length > 4 || !channels.every(Number.isFinite)) return null;
    const [r, g, b, a = 1] = channels;
    const inRange = (channel: number, max: number) => channel >= 0 && channel <= max;
    if (!inRange(r, 255) || !inRange(g, 255) || !inRange(b, 255) || !inRange(a, 1)) return null;
    return { r, g, b, a };
  }
  return hexColor(hex.slice(1));
}

/**
 * Thème sombre : un mail qui impose son texte en noir (style inline ou règle
 * d'un bloc `<style>`) reste noir sur le fond sombre de l'app, donc illisible.
 * Ces couleurs remontent vers la palette claire — mais seulement là où le fond
 * effectif derrière l'élément est sombre : un encadré au fond jaune garde son
 * texte noir. Un fond introuvable (aucun ancêtre opaque jusqu'à `html`/`body`,
 * que la feuille de repli laisse transparents) vaut le fond de l'app, donc
 * sombre. La passe n'est appelée qu'en thème sombre.
 */
export function liftDarkText(contentDocument: Document) {
  const view = contentDocument.defaultView;
  if (!view) return;
  const elements = Array.from(contentDocument.querySelectorAll<HTMLElement>("*"));
  const texts = elements.map((element) => parseColor(view.getComputedStyle(element).color));
  const backdrops = new Map<Element, boolean>();

  const onLightBackdrop = (element: Element | null): boolean => {
    if (!element) return false;
    const known = backdrops.get(element);
    if (known !== undefined) return known;
    const background = parseColor(view.getComputedStyle(element).backgroundColor);
    const light =
      background && background.a >= OPAQUE_BACKDROP_ALPHA
        ? relativeLuminance(background) >= LIGHT_BACKDROP_LUMINANCE
        : onLightBackdrop(element.parentElement);
    backdrops.set(element, light);
    return light;
  };

  elements.forEach((element, index) => {
    const text = texts[index];
    if (!text || onLightBackdrop(element)) return;
    const luminance = relativeLuminance(text);
    if (luminance >= DARK_TEXT_LUMINANCE) return;
    element.style.setProperty(
      "color",
      luminance <= BLACK_TEXT_LUMINANCE ? DARK.ink : DARK.inkSoft,
      "important",
    );
  });
}

/**
 * Corps du message : le HTML est **déjà assaini côté service** (liste blanche
 * stricte, styles filtrés, images de tracking retirées, liens `noopener`), on ne
 * fait donc que le rendre — dans une iframe `srcdoc` sandboxée, sans fuite de
 * styles vers l'app. `allow-scripts` est requis : sans lui, WebKitGTK (coquille
 * Linux) refuse d'exécuter dans le document du cadre le listener de clic posé
 * par le parent, et les liens ne partent jamais (mesuré ; Chromium l'exécute).
 * Le mail n'a de toute façon aucun script à lui : l'assainissement ammonia en
 * amont les exclut tous, et la sandbox verrouille le reste (navigation du haut,
 * formulaires, plugins).
 * La feuille injectée est un simple **repli**, placée dans le `<head>` : le mail garde sa propre mise en
 * page (styles inline, blocs `<style>` réinjectés en tête du body, attributs de
 * table) et notre palette ne sert qu'au contenu non stylé — le rendu fidèle
 * prime, y compris en thème sombre (sauf sous 720px, où la feuille ramène
 * tables et images à la largeur de l'écran et où `fitMailWidth` neutralise dans
 * le document les largeurs absolues que le mail impose). Sur un panneau plus
 * large que le design du mail, `fitMailZoom` met le document à l'échelle (plafond
 * 1,8, deadband 1,05) pour occuper la largeur disponible sans toucher à sa mise
 * en page. Une fois le cadre chargé, `liftDarkText` y remonte en thème sombre les
 * textes restés sombres sur le fond de l'app. Les liens sont interceptés côté parent (listener en capture
 * sur le document du cadre) et remis au navigateur du système, la base
 * `target="_blank"` ne restant qu'un repli. Sans HTML, on retombe sur les paragraphes texte.
 *
 * Les images distantes restent masquées par défaut : le bandeau ne fait que
 * demander au service de relire ce message-ci, jamais d'office, et le markup qui
 * revient est assaini à nouveau là-bas. `encrypted` ne sert qu'à ce rachat : un
 * message chiffré d'un compte dont l'interrupteur PGP est fermé est refusé, un
 * message en clair passe.
 */
export function MailBody({
  html,
  paragraphs,
  source,
  encrypted = false,
  senderEmail,
  className,
}: {
  html?: string;
  paragraphs: string[];
  source?: MailSource;
  encrypted?: boolean;
  /** Adresse de l'expéditeur : base de l'autorisation d'images par expéditeur. */
  senderEmail?: string;
  className?: string;
}) {
  const { imagesAllowedSenders, setImagesAllowedSenders } = usePrefs();
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [theme, setTheme] = useState<Theme>(themeSnapshot);
  const [height, setHeight] = useState<number | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const widthRef = useRef(0);
  const fittedRef = useRef(false);
  const frameDocumentRef = useRef("");

  const key = source ? `${source.accountId}:${source.folderPath}:${source.uid}` : undefined;
  const current = key && reveal?.key === key ? reveal : null;
  const body = current?.html ?? html;
  const sender = senderEmail ? normalizeTrustedSender(senderEmail) : "";
  const senderAllowed = sender !== "" && imagesAllowedSenders.includes(sender);
  const autoRevealed = useRef<string | null>(null);

  const showImages = useCallback(async () => {
    if (!source || !key) return;
    setReveal({ key, busy: true });
    try {
      setReveal({ key, html: await htmlImagesOf(source, encrypted) });
    } catch (error) {
      setReveal({ key, error: errorText(error) });
    }
  }, [encrypted, key, source]);

  useEffect(() => {
    if (!senderAllowed || !key || autoRevealed.current === key) return;
    autoRevealed.current = key;
    void showImages();
  }, [key, senderAllowed, showImages]);

  const allowSender = () => {
    if (!sender || senderAllowed) return;
    setImagesAllowedSenders([...imagesAllowedSenders, sender]);
    autoRevealed.current = key ?? null;
    void showImages();
  };

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      const next = themeSnapshot();
      setTheme((previous) =>
        previous.dark === next.dark && previous.accent === next.accent ? previous : next,
      );
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, []);

  const frameDocument = body ? mailDocument(body, theme) : "";
  frameDocumentRef.current = frameDocument;

  const measure = useCallback(() => {
    const root = frameRef.current?.contentDocument?.documentElement;
    if (!root) return;
    const measured = Math.ceil(root.scrollHeight);
    if (measured > 0) setHeight(Math.min(measured, MAX_HEIGHT));
  }, []);

  const fitWidth = useCallback(() => {
    const element = frameRef.current;
    const contentDocument = element?.contentDocument;
    if (!element || !contentDocument) return;
    if (element.clientWidth < MOBILE_WIDTH) fittedRef.current = true;
    fitMailWidth(contentDocument, element.clientWidth);
  }, []);

  const fitZoom = useCallback(() => {
    const element = frameRef.current;
    const contentDocument = element?.contentDocument;
    if (!element || !contentDocument) return;
    fitMailZoom(contentDocument, element.clientWidth);
  }, []);

  const syncHeight = useCallback(() => {
    fitWidth();
    fitZoom();
    measure();
    observerRef.current?.disconnect();
    observerRef.current = null;
    const contentBody = frameRef.current?.contentDocument?.body;
    if (!contentBody || typeof ResizeObserver === "undefined") return;
    observerRef.current = new ResizeObserver(() => measure());
    observerRef.current.observe(contentBody);
  }, [fitZoom, measure]);

  const interceptLinks = useCallback(() => {
    const contentDocument = frameRef.current?.contentDocument;
    if (!contentDocument) return;
    contentDocument.addEventListener(
      "click",
      (event) => {
        const target = event.target as Element | null;
        if (typeof target?.closest !== "function") return;
        const href = target.closest("a[href]")?.getAttribute("href");
        if (!href) return;
        let url: URL;
        try {
          url = new URL(href, contentDocument.baseURI);
        } catch {
          return;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") return;
        event.preventDefault();
        openExternal(url.href);
      },
      { capture: true },
    );
  }, []);

  const adaptColors = useCallback(() => {
    if (!theme.dark) return;
    const contentDocument = frameRef.current?.contentDocument;
    if (!contentDocument) return;
    liftDarkText(contentDocument);
  }, [theme.dark]);

  const handleFrameLoad = useCallback(() => {
    syncHeight();
    interceptLinks();
    adaptColors();
  }, [adaptColors, interceptLinks, syncHeight]);

  useEffect(() => {
    if (!body) return;
    syncHeight();
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [body, frameDocument, syncHeight]);

  useEffect(() => {
    const element = frameRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === widthRef.current) return;
      widthRef.current = element.clientWidth;
      if (element.clientWidth >= MOBILE_WIDTH && fittedRef.current) {
        fittedRef.current = false;
        element.srcdoc = frameDocumentRef.current;
        return;
      }
      fitWidth();
      fitZoom();
      measure();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fitWidth, fitZoom, measure, body]);

  if (!body) {
    return (
      <div className={cn("space-y-3.5", className)}>
        {paragraphs.map((paragraph, index) => (
          <p key={index} className="whitespace-pre-line">
            {paragraph}
          </p>
        ))}
      </div>
    );
  }

  const banner =
    Boolean(html) && Boolean(key) && !current?.html && !(senderAllowed && !current?.error);

  return (
    <div className={className}>
      {banner && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <ImageOff className="size-3.5 shrink-0 text-ink-muted" aria-hidden />
          <span role="status" aria-live="polite" className="text-[10.5px] font-semibold text-ink-muted">
            {current?.error ? `Images non affichées · ${current.error}` : "Images masquées"}
          </span>
          {!current?.error && <span className="text-[10.5px] text-ink-muted/60">·</span>}
          <button
            type="button"
            disabled={current?.busy}
            onClick={() => void showImages()}
            aria-label="Afficher les images de ce message"
            className="focus-ring inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] font-bold text-accent-ink transition-colors hover:bg-accent-soft disabled:opacity-60"
          >
            {current?.busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
            {current?.busy ? "Chargement…" : current?.error ? "Réessayer" : "Afficher"}
          </button>
          {sender && !senderAllowed && !demoReadOnly ? (
            <button
              type="button"
              disabled={current?.busy}
              onClick={allowSender}
              aria-label="Toujours autoriser les images de cet expéditeur"
              className="focus-ring inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] font-bold text-accent-ink transition-colors hover:bg-accent-soft disabled:opacity-60"
            >
              Toujours pour cet expéditeur
            </button>
          ) : null}
        </div>
      )}

      <iframe
        ref={frameRef}
        title="Contenu du message"
        sandbox="allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={frameDocument}
        onLoad={handleFrameLoad}
        className="block w-full border-0 bg-transparent"
        style={{ height: height ?? "65vh" }}
      />
    </div>
  );
}

export function MailBodyLoading({ className }: { className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn("space-y-2.5", className)}>
      <p className="flex items-center gap-2 text-[12px] font-semibold text-ink-muted">
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
        Chargement du message…
      </p>
      <div className="space-y-2.5 pt-1" aria-hidden>
        {["88%", "72%", "94%", "58%"].map((width) => (
          <span key={width} style={{ width }} className="block h-3 animate-pulse rounded-full bg-surface-2" />
        ))}
      </div>
    </div>
  );
}
