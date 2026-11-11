import { useCallback, useEffect, useRef, useState } from "react";
import { ImageOff, Loader2 } from "lucide-react";
import { errorText } from "@/lib/api";
import type { MailSource } from "@/lib/mail";
import { htmlImagesOf } from "@/lib/mail-backend";
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

type Theme = { dark: boolean; accent: string };

function themeSnapshot(): Theme {
  const root = document.documentElement;
  const accent = root.style.getPropertyValue("--accent").trim();
  return { dark: root.classList.contains("dark"), accent: HEX.test(accent) ? accent : DEFAULT_ACCENT };
}

/** Feuille de style du document mail : la palette de DESIGN.md, sans dépendre
 *  du CSS de l'app (l'iframe a son propre document). */
function mailStyles({ dark, accent }: Theme) {
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
p,div{margin:0 0 .85em}
p:last-child,div:last-child{margin-bottom:0}
a{color:var(--accent-ink);text-decoration:underline;text-underline-offset:2px}
blockquote{margin:0 0 .85em;padding-left:.9em;border-left:3px solid var(--line);color:var(--ink-muted)}
ul,ol{margin:0 0 .85em;padding-left:1.3em;list-style:disc}
ol{list-style:decimal}
h1,h2,h3,h4,h5,h6{margin:0 0 .5em;font-weight:800;font-size:1.05em;color:var(--ink)}
table{width:100%;border-collapse:collapse;margin:0 0 .85em;font-size:.95em}
th,td{border:1px solid var(--line);padding:.35em .5em;text-align:left}
th{font-weight:700}
hr{border:0;border-top:1px solid var(--line);margin:1em 0}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}
pre{white-space:pre-wrap;background:var(--surface-2);padding:.6em;border-radius:.5em}`;
}

function mailDocument(body: string, theme: Theme) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<base target="_blank">
<style>${mailStyles(theme)}</style>
</head>
<body>${body}</body>
</html>`;
}

/**
 * Corps du message : le HTML est **déjà assaini côté service** (liste blanche
 * stricte, images de tracking retirées, liens `noopener`), on ne fait donc que
 * le rendre — dans une iframe `srcdoc` sans `allow-scripts`, donc sans aucun
 * script et sans fuite de styles vers l'app. La feuille injectée reprend la
 * palette de DESIGN.md selon le thème actif, et les liens s'ouvrent dans un
 * nouvel onglet. Sans HTML, on retombe sur les paragraphes texte.
 *
 * Les images distantes restent masquées par défaut : le bandeau ne fait que
 * demander au service de relire ce message-ci, jamais d'office, et le markup qui
 * revient est assaini à nouveau là-bas.
 */
export function MailBody({
  html,
  paragraphs,
  source,
  className,
}: {
  html?: string;
  paragraphs: string[];
  source?: MailSource;
  className?: string;
}) {
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [theme, setTheme] = useState<Theme>(themeSnapshot);
  const [height, setHeight] = useState<number | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const key = source ? `${source.accountId}:${source.folderPath}:${source.uid}` : undefined;
  const current = key && reveal?.key === key ? reveal : null;
  const body = current?.html ?? html;

  const showImages = async () => {
    if (!source || !key || current?.busy) return;
    setReveal({ key, busy: true });
    try {
      setReveal({ key, html: await htmlImagesOf(source) });
    } catch (error) {
      setReveal({ key, error: errorText(error) });
    }
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

  const measure = useCallback(() => {
    const root = frameRef.current?.contentDocument?.documentElement;
    if (!root) return;
    const measured = Math.ceil(root.scrollHeight);
    if (measured > 0) setHeight(Math.min(measured, MAX_HEIGHT));
  }, []);

  const syncHeight = useCallback(() => {
    measure();
    observerRef.current?.disconnect();
    observerRef.current = null;
    const contentBody = frameRef.current?.contentDocument?.body;
    if (!contentBody || typeof ResizeObserver === "undefined") return;
    observerRef.current = new ResizeObserver(() => measure());
    observerRef.current.observe(contentBody);
  }, [measure]);

  useEffect(() => {
    if (!body) return;
    syncHeight();
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [body, frameDocument, syncHeight]);

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

  const banner = Boolean(html) && Boolean(key) && !current?.html;

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
        </div>
      )}

      <iframe
        ref={frameRef}
        title="Contenu du message"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={frameDocument}
        onLoad={syncHeight}
        className="block w-full border-0 bg-transparent"
        style={{ height: height ?? "65vh" }}
      />
    </div>
  );
}
