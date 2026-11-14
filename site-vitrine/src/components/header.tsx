import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { Icon } from "@/components/icons";
import type { Theme } from "@/hooks/useTheme";
import { container } from "@/lib/layout";
import { cn } from "@/lib/utils";

const NAV = [
  { id: "fonctionnalites", label: "Fonctionnalités" },
  { id: "demo", label: "Démo" },
  { id: "mobile", label: "Mobile" },
  { id: "telecharger", label: "Télécharger" },
  { id: "securite", label: "Sécurité" },
];

export function Header({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const [stuck, setStuck] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setStuck(window.scrollY > 8));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const sections = NAV.map((item) => document.getElementById(item.id)).filter(
      (element): element is HTMLElement => element !== null,
    );
    if (sections.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { rootMargin: "-45% 0px -50% 0px", threshold: 0 },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  const nextTheme = theme === "dark" ? "clair" : "sombre";

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-[background-color,border-color,backdrop-filter] duration-300",
        stuck
          ? "border-b border-line bg-canvas/80 backdrop-blur-xl backdrop-saturate-150"
          : "border-b border-transparent",
      )}
    >
      <div className={`${container} flex min-h-[4.4rem] items-center gap-3`}>
        <a href="#top" className="inline-flex items-center gap-2.5 text-ink no-underline" aria-label="Lavande, revenir en haut de la page">
          <span
            aria-hidden="true"
            className="grid size-9 place-items-center rounded-xl bg-[linear-gradient(145deg,var(--accent-bright),var(--accent)_55%,#6d5ce0)] text-sm font-extrabold text-white shadow-[0_8px_20px_-8px_var(--glow)]"
          >
            L
          </span>
          <span className="text-[1.05rem] font-extrabold tracking-[-0.025em]">Lavande</span>
        </a>

        <nav aria-label="Navigation principale" className="ml-auto hidden lg:block">
          <ul className="flex items-center gap-1">
            {NAV.map((item) => {
              const current = active === item.id;
              return (
                <li key={item.id}>
                  <a
                    href={`#${item.id}`}
                    aria-current={current ? "true" : undefined}
                    className={cn(
                      "relative inline-flex items-center rounded-full px-3 py-1.5 text-[0.85rem] font-semibold no-underline transition-colors",
                      current ? "text-ink" : "text-ink-soft hover:bg-surface-2 hover:text-ink",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute inset-0 -z-10 rounded-full border border-accent-ring/50 bg-accent-soft transition-opacity duration-300",
                        current ? "opacity-100" : "opacity-0",
                      )}
                    />
                    {item.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-2 lg:ml-3">
          <button
            type="button"
            onClick={onToggleTheme}
            aria-pressed={theme === "light"}
            aria-label={`Passer en thème ${nextTheme}`}
            title={`Thème ${nextTheme}`}
            className="grid size-10 place-items-center rounded-full border border-line bg-surface/80 text-ink-soft transition-colors hover:border-accent-ring hover:bg-surface-2 hover:text-ink"
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} className="size-[1.15rem]" />
          </button>

          <a
            href="#telecharger"
            className="hidden items-center gap-1.5 rounded-full bg-[linear-gradient(135deg,var(--accent-strong),var(--accent-deep))] px-4 py-2.5 text-[0.84rem] font-bold text-white no-underline shadow-[0_14px_30px_-18px_var(--glow)] transition-transform hover:-translate-y-0.5 sm:inline-flex"
          >
            <Icon name="download" className="size-4" />
            Télécharger
          </a>

          <button
            type="button"
            onClick={() => setMenu((open) => !open)}
            aria-expanded={menu}
            aria-controls="menu-mobile"
            aria-label={menu ? "Fermer le menu" : "Ouvrir le menu"}
            className="grid size-10 place-items-center rounded-full border border-line bg-surface/80 text-ink transition-colors hover:border-accent-ring lg:hidden"
          >
            <span className="relative block h-3 w-4" aria-hidden="true">
              <span
                className={cn(
                  "absolute inset-x-0 top-0 h-0.5 rounded-full bg-current transition-transform duration-300",
                  menu && "translate-y-[5px] rotate-45",
                )}
              />
              <span
                className={cn(
                  "absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-current transition-transform duration-300",
                  menu && "-translate-y-[5px] -rotate-45",
                )}
              />
            </span>
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {menu ? (
          <motion.div
            id="menu-mobile"
            key="menu"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: "easeOut" }}
            className="overflow-hidden border-t border-line bg-canvas/95 backdrop-blur-xl lg:hidden"
          >
            <ul className={`${container} flex flex-col gap-1 py-4`}>
              {NAV.map((item) => (
                <li key={item.id}>
                  <a
                    href={`#${item.id}`}
                    onClick={() => setMenu(false)}
                    className="flex items-center justify-between rounded-xl px-3 py-2.5 text-[0.95rem] font-semibold text-ink-soft no-underline transition-colors hover:bg-surface-2 hover:text-ink"
                  >
                    {item.label}
                    <Icon name="arrowRight" className="size-4 text-accent" />
                  </a>
                </li>
              ))}
              <li className="pt-2">
                <a
                  href="#telecharger"
                  onClick={() => setMenu(false)}
                  className="flex items-center justify-center gap-2 rounded-xl bg-[linear-gradient(135deg,var(--accent-strong),var(--accent-deep))] px-4 py-3 text-[0.92rem] font-bold text-white no-underline"
                >
                  <Icon name="download" className="size-4" />
                  Télécharger
                </a>
              </li>
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  );
}
