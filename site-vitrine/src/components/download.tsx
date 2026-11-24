import { Brand, type BrandName } from "@/components/brand";
import { Icon, type IconName } from "@/components/icons";
import { BorderBeam } from "@/components/magicui/border-beam";
import { DotPattern } from "@/components/magicui/dot-pattern";
import { Reveal } from "@/components/ui/reveal";
import { SectionHead } from "@/components/ui/section-head";
import { container, sectionPad } from "@/lib/layout";

interface Platform {
  name: string;
  os: string;
  brand: BrandName;
  copy: string;
  file: string;
  href: string;
  cta: string;
  featured?: boolean;
}

const PLATFORMS: Platform[] = [
  {
    name: "Linux · AppImage",
    os: "x86_64",
    brand: "linux",
    copy: "Un fichier unique, sans installation : rendez-le exécutable et lancez-le. C’est le format qui se met à jour en place.",
    file: "Lavande_0.5.6_amd64.AppImage.tar.gz",
    href: "/updates/Lavande_0.5.6_amd64.AppImage.tar.gz",
    cta: "Télécharger l’AppImage",
    featured: true,
  },
  {
    name: "Linux · RPM",
    os: "Fedora · RHEL",
    brand: "linux",
    copy: "Paquet système pour Fedora et dérivés RHEL. Installation et mises à jour via polkit ou sudo. Sur Fedora Atomic, Bazzite ou Silverblue (système immuable), prenez l’AppImage : c’est le seul format qui se met à jour en place.",
    file: "Lavande-0.5.6-1.x86_64.rpm",
    href: "/updates/Lavande-0.5.6-1.x86_64.rpm",
    cta: "Télécharger le RPM",
  },
  {
    name: "Linux · DEB",
    os: "Debian · Ubuntu",
    brand: "linux",
    copy: "Paquet système pour Debian, Ubuntu et dérivés. Installation et mises à jour via sudo.",
    file: "Lavande_0.5.6_amd64.deb",
    href: "/updates/Lavande_0.5.6_amd64.deb",
    cta: "Télécharger le DEB",
  },
  {
    name: "Windows · Installeur",
    os: "x64",
    brand: "windows",
    copy: "Installeur NSIS pour Windows 10/11 (WebView2 préinstallé). Le moteur mail et l’agenda tournent en local, comme sur Linux.",
    file: "Lavande_0.5.6_x64-setup.exe",
    href: "/updates/Lavande_0.5.6_x64-setup.exe",
    cta: "Télécharger l’installeur",
  },
  {
    name: "Android · APK",
    os: "arm64",
    brand: "android",
    copy: "La même interface, en plein écran, avec le moteur mail embarqué. L’APK se réinstalle à la main à chaque version.",
    file: "Lavande.apk",
    href: "/updates/Lavande.apk",
    cta: "Télécharger l’APK",
  },
];

const META: { icon: IconName; label: string }[] = [
  { icon: "package", label: "Paquets signés GPG" },
  { icon: "refresh", label: "Mises à jour signées minisign" },
  { icon: "lock", label: "Aucun compte requis" },
];

export function Download() {
  return (
    <section id="telecharger" aria-labelledby="download-title" className={`relative overflow-hidden ${sectionPad}`}>
      <DotPattern
        className="text-ink/15 [mask-image:radial-gradient(52%_60%_at_50%_35%,#000_0%,transparent_75%)]"
        width={30}
        height={30}
        cr={1}
      />
      <div className={`relative ${container}`}>
        <SectionHead index="05" kicker="Téléchargement" title="Installez-la chez vous" titleId="download-title">
          Version 0.5.6. Paquets signés pour Linux et Android, mises à jour automatiques sur le bureau.
        </SectionHead>

        <Reveal className="mt-5 flex flex-wrap gap-x-5 gap-y-2">
          {META.map((item) => (
            <span key={item.label} className="inline-flex items-center gap-1.5 text-[0.78rem] font-semibold text-ink-muted">
              <Icon name={item.icon} className="size-4 text-accent" />
              {item.label}
            </span>
          ))}
        </Reveal>

        <div className="mt-9 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PLATFORMS.map((platform, index) => (
            <Reveal
              key={platform.name}
              delay={index * 0.06}
              className={platform.featured ? "sm:col-span-2 lg:col-span-1 lg:row-span-1" : undefined}
            >
              <article
                className={`group relative flex h-full flex-col overflow-hidden rounded-2xl border p-6 transition-all duration-500 hover:-translate-y-0.5 hover:shadow-[var(--shadow-soft)] ${
                  platform.featured
                    ? "border-accent-ring/70 bg-[linear-gradient(160deg,var(--accent-soft),var(--surface)_58%)]"
                    : "border-line bg-surface/55 hover:border-accent-ring/60 hover:bg-surface"
                }`}
              >
                {platform.featured ? (
                  <BorderBeam size={130} duration={8} colorFrom="var(--accent-bright)" colorTo="var(--accent-deep)" />
                ) : null}
                {platform.featured ? (
                  <span className="mb-3 w-fit rounded-full bg-accent/90 px-2.5 py-0.5 text-[0.66rem] font-extrabold tracking-[0.1em] text-white uppercase">
                    Recommandé
                  </span>
                ) : null}
                <div className="flex items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-xl border border-line bg-surface-2 text-ink transition-colors group-hover:border-accent-ring group-hover:text-accent">
                    <Brand name={platform.brand} className="size-5" />
                  </span>
                  <h3 className="text-lg text-ink">{platform.name}</h3>
                </div>
                <span className="mt-1 text-[0.72rem] font-bold tracking-[0.1em] text-ink-muted uppercase">
                  {platform.os}
                </span>
                <p className="mt-3 text-sm leading-relaxed text-ink-soft">{platform.copy}</p>
                <code className="mt-3 block truncate rounded-lg border border-line bg-canvas/70 px-2.5 py-1.5 text-[0.72rem] text-ink-muted">
                  {platform.file}
                </code>
                <a
                  href={platform.href}
                  className={`mt-4 inline-flex w-fit items-center gap-2 rounded-full px-4 py-2.5 text-[0.85rem] font-bold transition-all duration-300 hover:-translate-y-0.5 ${
                    platform.featured
                      ? "bg-[linear-gradient(135deg,var(--accent-strong),var(--accent-deep))] text-white shadow-[0_16px_34px_-20px_var(--glow)]"
                      : "border border-line-strong bg-surface/80 text-ink hover:border-accent-ring hover:bg-surface-2"
                  }`}
                >
                  <Icon name="download" className="size-4" />
                  {platform.cta}
                </a>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal className="mt-6 flex flex-col gap-3 rounded-2xl border border-line bg-surface/55 p-5 sm:flex-row sm:items-start">
          <Icon name="shield" className="size-5 shrink-0 text-accent" />
          <div>
            <p className="text-sm leading-relaxed text-ink-soft">
              <strong className="text-ink">Mises à jour automatiques signées.</strong> L’application
              interroge le manifeste <code className="rounded bg-surface-2 px-1.5 py-0.5 text-[0.8rem]">latest.json</code>,
              vérifie la signature minisign du paquet et refuse toute version qui ne correspond pas à la
              version signée. Les paquets Linux sont en plus signés GPG.
            </p>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[0.82rem] font-semibold">
              <a href="/updates/latest.json" className="text-accent-ink underline-offset-4 hover:underline">
                Manifeste de mise à jour
              </a>
              <a href="/updates/lavande-release.asc" className="text-accent-ink underline-offset-4 hover:underline">
                Clé publique GPG
              </a>
            </div>
          </div>
        </Reveal>

      </div>
    </section>
  );
}
