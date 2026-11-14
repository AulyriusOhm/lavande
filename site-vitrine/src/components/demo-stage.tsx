import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { BorderBeam } from "@/components/magicui/border-beam";
import { Icon, type IconName } from "@/components/icons";
import { PhoneShell } from "@/components/ui/phone-shell";
import { ScaledFrame } from "@/components/ui/scaled-frame";
import type { Theme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";

type Mode = "desktop" | "phone";

const MODES: Record<
  Mode,
  { label: string; icon: IconName; width: number; height: number; src: string; poster: string }
> = {
  desktop: {
    label: "Ordinateur",
    icon: "monitor",
    width: 1280,
    height: 800,
    src: `${import.meta.env.BASE_URL}demo/index.html?desktop`,
    poster: "pc-inbox",
  },
  phone: {
    label: "Téléphone",
    icon: "smartphone",
    width: 390,
    height: 844,
    src: `${import.meta.env.BASE_URL}demo/index.html?app`,
    poster: "mobile-inbox",
  },
};

function defaultMode(): Mode {
  return window.matchMedia("(min-width: 768px)").matches ? "desktop" : "phone";
}

export function DemoStage({ theme }: { theme: Theme }) {
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [loaded, setLoaded] = useState(false);
  const chosen = useRef(false);
  const frame = MODES[mode];

  useEffect(() => {
    setLoaded(false);
  }, [theme, mode]);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const onChange = (event: MediaQueryListEvent) => {
      if (!chosen.current) setMode(event.matches ? "desktop" : "phone");
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const choose = (next: Mode) => {
    chosen.current = true;
    setMode(next);
  };

  const poster = (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 z-10 bg-canvas transition-opacity duration-500",
        loaded ? "opacity-0" : "opacity-100",
      )}
    >
      <span className="block h-full w-full">
        <img
          src={`${import.meta.env.BASE_URL}shots/${frame.poster}-dark.webp`}
          alt=""
          className="shot-dark h-full w-full object-cover object-top"
        />
        <img
          src={`${import.meta.env.BASE_URL}shots/${frame.poster}-light.webp`}
          alt=""
          className="shot-light h-full w-full object-cover object-top"
        />
      </span>
    </div>
  );

  return (
    <div className="relative">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div
          role="group"
          aria-label="Format de la démo"
          className="relative inline-flex rounded-full border border-line-strong bg-surface/80 p-1 backdrop-blur"
        >
          {(Object.keys(MODES) as Mode[]).map((id) => {
            const active = id === mode;
            return (
              <button
                key={id}
                type="button"
                onClick={() => choose(id)}
                aria-pressed={active}
                className={cn(
                  "relative z-10 inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[0.8rem] font-bold transition-colors",
                  active ? "text-white" : "text-ink-soft hover:text-ink",
                )}
              >
                {active ? (
                  <motion.span
                    layoutId="demo-mode-pill"
                    className="absolute inset-0 -z-10 rounded-full bg-[linear-gradient(135deg,var(--accent-strong),var(--accent-deep))] shadow-[0_10px_24px_-14px_var(--glow)]"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                ) : null}
                <Icon name={MODES[id].icon} className="size-3.5" />
                {MODES[id].label}
              </button>
            );
          })}
        </div>
        <span className="inline-flex items-center gap-1.5 text-[0.72rem] font-semibold text-ink-muted">
          <Icon name="shield" className="size-3.5 text-accent" />
          Lecture seule
        </span>
      </div>

      {mode === "desktop" ? (
        <div className="relative overflow-hidden rounded-[1.35rem] border border-line-strong bg-surface/85 shadow-[var(--shadow-soft)]">
          <div className="flex items-center gap-2 border-b border-line bg-surface-2/70 px-3 py-2">
            <span className="flex gap-1.5" aria-hidden="true">
              <i className="block size-2.5 rounded-full bg-[#f87171]/80" />
              <i className="block size-2.5 rounded-full bg-[#fbbf24]/80" />
              <i className="block size-2.5 rounded-full bg-[#34d399]/80" />
            </span>
            <span className="min-w-0 flex-1 truncate text-center text-[0.72rem] font-semibold text-ink-muted">
              Lavande — démo en lecture seule
            </span>
            <Icon name="monitor" className="size-3.5 text-ink-muted/70" />
          </div>
          <ScaledFrame
            width={frame.width}
            height={frame.height}
            src={frame.src}
            title="Lavande — démo en lecture seule"
            frameKey={`${mode}-${theme}`}
            onLoad={() => setLoaded(true)}
            overlay={poster}
          />
          <BorderBeam size={160} duration={7} borderWidth={1.5} colorFrom="var(--accent-bright)" colorTo="var(--accent-deep)" />
        </div>
      ) : (
        <div className="flex justify-center">
          <PhoneShell beam className="w-[min(100%,17.5rem)]">
            <ScaledFrame
              width={frame.width}
              height={frame.height}
              src={frame.src}
              title="Lavande — démo en lecture seule"
              frameKey={`${mode}-${theme}`}
              onLoad={() => setLoaded(true)}
              overlay={poster}
            />
          </PhoneShell>
        </div>
      )}

      <p className="mt-3 flex items-start gap-1.5 text-[0.72rem] leading-relaxed text-ink-muted">
        <Icon name="sparkles" className="mt-0.5 size-3.5 shrink-0 text-accent" />
        Données d’exemple · naviguez librement, rien n’est enregistré
      </p>
    </div>
  );
}
