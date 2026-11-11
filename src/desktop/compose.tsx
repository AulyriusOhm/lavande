import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Maximize2, Minimize2, PenLine, PictureInPicture2, X } from "lucide-react";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useMailStore } from "@/lib/store";
import { ComposeScreen } from "@/screens/compose-screen";
import { DIconButton } from "@/desktop/ui";
import { composeWindowUrl } from "@/lib/compose-bus";
import { isTauriShell } from "@/lib/open-external";
import { cn } from "@/lib/utils";

type Geometry = { x: number; y: number; w: number; h: number };
type Direction = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
type ComposeWindowHandle = { kind: "tauri"; window: WebviewWindow } | { kind: "browser"; window: Window };

const MIN_W = 420;
const MIN_H = 360;
const GEOM_KEY = "lavande.compose.geom.v1";
const SLIDE = { duration: 0.22, ease: [0.22, 1, 0.36, 1] } as const;

const HANDLES: { dir: Direction; className: string }[] = [
  { dir: "n", className: "inset-x-3 top-0 h-1.5 cursor-ns-resize" },
  { dir: "s", className: "inset-x-3 bottom-0 h-1.5 cursor-ns-resize" },
  { dir: "e", className: "inset-y-3 right-0 w-1.5 cursor-ew-resize" },
  { dir: "w", className: "inset-y-3 left-0 w-1.5 cursor-ew-resize" },
  { dir: "ne", className: "right-0 top-0 size-3.5 cursor-nesw-resize" },
  { dir: "nw", className: "left-0 top-0 size-3.5 cursor-nwse-resize" },
  { dir: "se", className: "bottom-0 right-0 size-3.5 cursor-nwse-resize" },
  { dir: "sw", className: "bottom-0 left-0 size-3.5 cursor-nesw-resize" },
];

const viewport = () => ({ vw: window.innerWidth, vh: window.innerHeight });

function clampGeometry(next: Geometry): Geometry {
  const { vw, vh } = viewport();
  const w = Math.min(Math.max(next.w, MIN_W), vw);
  const h = Math.min(Math.max(next.h, MIN_H), vh);
  return {
    w,
    h,
    x: Math.min(Math.max(next.x, 0), Math.max(0, vw - w)),
    y: Math.min(Math.max(next.y, 0), Math.max(0, vh - h)),
  };
}

function defaultGeometry(): Geometry {
  const { vw, vh } = viewport();
  const w = Math.min(600, vw - 24);
  const h = Math.min(660, vh - 120);
  return clampGeometry({ x: vw - w - 24, y: vh - h - 96, w, h });
}

function loadGeometry(): Geometry {
  try {
    const raw = window.localStorage.getItem(GEOM_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Geometry;
      if ([parsed.x, parsed.y, parsed.w, parsed.h].every((n) => typeof n === "number" && Number.isFinite(n))) {
        return clampGeometry(parsed);
      }
    }
  } catch {
    // géométrie corrompue : on repart de la position par défaut
  }
  return defaultGeometry();
}

export function DesktopCompose() {
  const {
    composeOpen,
    composeDraft,
    composeTitle,
    composeDetached,
    setComposeDraft,
    sendDraft,
    resumeCompose,
    minimizeCompose,
    closeCompose,
    detachCompose,
    dockCompose,
    detachClosed,
    notify,
  } = useMailStore();

  const [geometry, setGeometry] = useState<Geometry>(loadGeometry);
  const [maximized, setMaximized] = useState(false);
  const restoreGeometry = useRef<Geometry | null>(null);
  const windowRef = useRef<ComposeWindowHandle | null>(null);
  const detachedRef = useRef(composeDetached);
  detachedRef.current = composeDetached;

  useEffect(() => {
    try {
      window.localStorage.setItem(GEOM_KEY, JSON.stringify(geometry));
    } catch {
      // stockage indisponible : la géométrie reste en mémoire
    }
  }, [geometry]);

  useEffect(() => {
    const onResize = () => setGeometry((current) => clampGeometry(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const closeDetachedWindow = useCallback(() => {
    const handle = windowRef.current;
    windowRef.current = null;
    if (!handle) return;
    if (handle.kind === "tauri") void handle.window.close().catch(() => {});
    else handle.window.close();
  }, []);

  const openDetachedWindow = useCallback(async () => {
    const url = composeWindowUrl();
    if (isTauriShell()) {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const existing = await WebviewWindow.getByLabel("compose");
      if (!detachedRef.current) return;
      if (existing) {
        windowRef.current = { kind: "tauri", window: existing };
        await existing.setFocus();
        return;
      }
      const created = new WebviewWindow("compose", {
        url,
        title: "Nouveau message — Lavande",
        width: 640,
        height: 720,
        minWidth: 480,
        minHeight: 420,
        center: true,
      });
      if (!detachedRef.current) {
        void created.close().catch(() => {});
        return;
      }
      windowRef.current = { kind: "tauri", window: created };
      void created.once("tauri://error", () => {
        windowRef.current = null;
        notify("Impossible d'ouvrir la fenêtre de composition.");
        detachClosed();
      });
    } else {
      const popup = window.open(url, "lavande-compose", "width=640,height=720");
      if (!popup) {
        notify("Fenêtre bloquée par le navigateur : autorise les pop-ups pour détacher le brouillon.");
        detachClosed();
        return;
      }
      windowRef.current = { kind: "browser", window: popup };
    }
  }, [detachClosed, notify]);

  useEffect(() => {
    if (composeDetached && !windowRef.current) void openDetachedWindow();
    if (!composeDetached && windowRef.current) closeDetachedWindow();
  }, [composeDetached, openDetachedWindow, closeDetachedWindow]);

  useEffect(() => {
    if (!composeDetached) return;
    const timer = window.setInterval(() => {
      const handle = windowRef.current;
      if (handle?.kind === "browser" && handle.window.closed) {
        windowRef.current = null;
        detachClosed();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [composeDetached, detachClosed]);

  const toggleMaximize = useCallback(() => {
    if (maximized) {
      setMaximized(false);
      if (restoreGeometry.current) setGeometry(clampGeometry(restoreGeometry.current));
      return;
    }
    restoreGeometry.current = geometry;
    setMaximized(true);
    const { vw, vh } = viewport();
    setGeometry({ x: 0, y: 0, w: vw, h: vh });
  }, [maximized, geometry]);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (maximized || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, select, input, a")) return;
    event.preventDefault();
    const origin = geometry;
    const px = event.clientX;
    const py = event.clientY;
    const move = (e: PointerEvent) =>
      setGeometry(
        clampGeometry({ ...origin, x: origin.x + e.clientX - px, y: origin.y + e.clientY - py }),
      );
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startResize = (direction: Direction) => (event: React.PointerEvent<HTMLDivElement>) => {
    if (maximized || event.button !== 0) return;
    event.preventDefault();
    const origin = geometry;
    const px = event.clientX;
    const py = event.clientY;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - px;
      const dy = e.clientY - py;
      let { x, y, w, h } = origin;
      if (direction.includes("e")) w = origin.w + dx;
      if (direction.includes("s")) h = origin.h + dy;
      if (direction.includes("w")) {
        w = origin.w - dx;
        x = origin.x + dx;
      }
      if (direction.includes("n")) {
        h = origin.h - dy;
        y = origin.y + dy;
      }
      if (w < MIN_W) {
        if (direction.includes("w")) x -= MIN_W - w;
        w = MIN_W;
      }
      if (h < MIN_H) {
        if (direction.includes("n")) y -= MIN_H - h;
        h = MIN_H;
      }
      setGeometry(clampGeometry({ x, y, w, h }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const pillClass =
    "absolute right-6 bottom-24 z-40 flex max-w-[calc(100vw-3rem)] items-center gap-1 rounded-full border border-line py-1 pr-1 pl-3.5 glass shadow-[0_18px_44px_-26px_var(--accent)]";

  return (
    <AnimatePresence initial={false}>
      {composeDetached && composeDraft ? (
        <motion.div
          key="compose-detached"
          data-testid="desktop-compose-detached"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 14 }}
          transition={SLIDE}
          className={pillClass}
        >
          <button
            type="button"
            onClick={dockCompose}
            aria-label="Reprendre le brouillon dans la fenêtre principale"
            className="focus-ring flex min-w-0 items-center gap-2 rounded-full py-1.5 text-left"
          >
            <PictureInPicture2 className="size-4 shrink-0 text-accent-ink" strokeWidth={2.2} />
            <span className="max-w-[240px] truncate text-[12.5px] font-semibold text-ink">
              {composeDraft.subject.trim() || "Brouillon"} · fenêtre séparée
            </span>
          </button>
          <button
            type="button"
            onClick={closeCompose}
            aria-label="Fermer le brouillon"
            title="Fermer le brouillon"
            className="focus-ring grid size-8 shrink-0 place-items-center rounded-full text-ink-muted transition-colors duration-200 hover:bg-surface-2 hover:text-ink"
          >
            <X className="size-3.5" strokeWidth={2.2} />
          </button>
        </motion.div>
      ) : composeOpen && composeDraft ? (
        <motion.div
          key="compose"
          data-testid="desktop-compose"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 18 }}
          transition={SLIDE}
          style={{ left: geometry.x, top: geometry.y, width: geometry.w, height: geometry.h }}
          className={cn(
            "absolute z-40 flex flex-col overflow-hidden border border-line bg-canvas shadow-[0_30px_80px_-40px_var(--accent)]",
            maximized ? "rounded-none" : "rounded-[22px]",
          )}
        >
          {!maximized &&
            HANDLES.map((handle) => (
              <div
                key={handle.dir}
                aria-hidden
                onPointerDown={startResize(handle.dir)}
                className={cn("absolute z-10", handle.className)}
              />
            ))}
          <div className="min-h-0 flex-1">
            <ComposeScreen
              title={composeTitle}
              draft={composeDraft}
              onDraftChange={setComposeDraft}
              onSend={sendDraft}
              onMinimize={minimizeCompose}
              onClose={closeCompose}
              onHeaderPointerDown={startDrag}
              onHeaderDoubleClick={toggleMaximize}
              headerActions={
                <>
                  <DIconButton
                    label={maximized ? "Restaurer la taille de la fenêtre" : "Agrandir la fenêtre"}
                    onClick={toggleMaximize}
                    className="size-8"
                  >
                    {maximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                  </DIconButton>
                  <DIconButton
                    label="Détacher dans une nouvelle fenêtre"
                    onClick={detachCompose}
                    className="size-8"
                  >
                    <PictureInPicture2 className="size-4" />
                  </DIconButton>
                </>
              }
            />
          </div>
        </motion.div>
      ) : composeDraft ? (
        <motion.div
          key="compose-pill"
          data-testid="desktop-compose-pill"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 14 }}
          transition={SLIDE}
          className={pillClass}
        >
          <button
            type="button"
            onClick={resumeCompose}
            aria-label="Reprendre le brouillon"
            className="focus-ring flex min-w-0 items-center gap-2 rounded-full py-1.5 text-left"
          >
            <PenLine className="size-4 shrink-0 text-accent-ink" strokeWidth={2.2} />
            <span className="max-w-[240px] truncate text-[12.5px] font-semibold text-ink">
              {composeDraft.subject.trim() || "Brouillon"}
            </span>
          </button>
          <button
            type="button"
            onClick={closeCompose}
            aria-label="Fermer le brouillon"
            title="Fermer le brouillon"
            className="focus-ring grid size-8 shrink-0 place-items-center rounded-full text-ink-muted transition-colors duration-200 hover:bg-surface-2 hover:text-ink"
          >
            <X className="size-3.5" strokeWidth={2.2} />
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
