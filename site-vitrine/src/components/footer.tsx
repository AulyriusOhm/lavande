import { Icon } from "@/components/icons";
import { container } from "@/lib/layout";

const LINKS = [
  { href: "#fonctionnalites", label: "Fonctionnalités" },
  { href: "#demo", label: "Démo" },
  { href: "#mobile", label: "Mobile" },
  { href: "#telecharger", label: "Téléchargement" },
  { href: "#securite", label: "Sécurité" },
];

export function Footer() {
  return (
    <footer className="relative mt-8 border-t border-line bg-surface/30">
      <div className={container}>
        <div className="flex flex-col gap-8 py-12 md:flex-row md:justify-between">
          <div className="max-w-sm">
            <a href="#top" className="inline-flex items-center gap-2.5 text-ink no-underline">
              <span
                aria-hidden="true"
                className="grid size-9 place-items-center rounded-xl bg-[linear-gradient(145deg,var(--accent-bright),var(--accent)_55%,#6d5ce0)] text-sm font-extrabold text-white shadow-[0_8px_20px_-8px_var(--glow)]"
              >
                L
              </span>
              <span className="text-[1.05rem] font-extrabold tracking-[-0.025em]">Lavande</span>
            </a>
            <p className="mt-3 text-sm leading-relaxed text-ink-soft">
              Mail, agenda et planification. Chiffré par compte, auto-hébergé sur vos machines.
            </p>
          </div>

          <nav aria-label="Liens de pied de page" className="flex flex-wrap gap-x-6 gap-y-2 md:max-w-md md:justify-end">
            {LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-sm font-semibold text-ink-soft no-underline transition-colors hover:text-ink"
              >
                {link.label}
              </a>
            ))}
            <a
              href="/updates/latest.json"
              className="text-sm font-semibold text-ink-soft no-underline transition-colors hover:text-ink"
            >
              Manifeste de mise à jour
            </a>
            <a
              href="https://git.lanro.eu/Roman/lavande/src/branch/main/docs"
              className="inline-flex items-center gap-1 text-sm font-semibold text-ink-soft no-underline transition-colors hover:text-ink"
            >
              Documentation
              <Icon name="external" className="size-3.5" />
            </a>
            <a
              href="https://git.lanro.eu/Roman/lavande"
              className="inline-flex items-center gap-1 text-sm font-semibold text-ink-soft no-underline transition-colors hover:text-ink"
            >
              Code source
              <Icon name="external" className="size-3.5" />
            </a>
          </nav>
        </div>

        <div className="flex flex-col gap-2 border-t border-line py-6 text-[0.82rem] text-ink-muted sm:flex-row sm:justify-between">
          <p>© {new Date().getFullYear()} Lavande · auto-hébergé</p>
          <p>Lavande le jour, Orchidée la nuit.</p>
        </div>
      </div>
    </footer>
  );
}
