import type { ReactNode } from "react";

import { Icon } from "@/components/icons";
import { useTheme } from "@/hooks/useTheme";
import { container } from "@/lib/layout";
import { cn } from "@/lib/utils";

const REPO = "https://git.lanro.eu/Roman/lavande";
const CONTACT = "lavande@lanro.eu";
const UPDATED = "21/11/2026";

const PROSE = "max-w-[46rem]";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-11">
      <h2 id={id} className="text-[clamp(1.32rem,2.5vw,1.7rem)] text-ink">
        {title}
      </h2>
      <div className="mt-3 space-y-3.5 text-[1rem] leading-relaxed text-ink-soft">{children}</div>
    </section>
  );
}

function List({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-2 pl-5 marker:text-accent">{children}</ul>;
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1 font-semibold text-accent-ink no-underline transition-colors hover:text-ink"
    >
      {children}
      <Icon name="external" className="size-3.5 shrink-0" />
    </a>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[0.86em] text-ink">
      {children}
    </code>
  );
}

export function PrivacyPage() {
  const { theme, toggle } = useTheme();
  const nextTheme = theme === "dark" ? "clair" : "sombre";

  return (
    <>
      <a
        href="#contenu"
        className="sr-only rounded-b-xl bg-accent-strong px-4 py-2.5 text-sm font-bold text-white no-underline focus:not-sr-only focus:fixed focus:top-0 focus:left-1/2 focus:z-[70] focus:-translate-x-1/2"
      >
        Aller au contenu
      </a>

      <header className="border-b border-line">
        <div className={`${container} flex min-h-[4.4rem] items-center gap-3`}>
          <a href="/" className="inline-flex items-center gap-2.5 text-ink no-underline">
            <img
              src={`${import.meta.env.BASE_URL}favicon.svg`}
              alt=""
              aria-hidden="true"
              className="size-9 rounded-xl shadow-[0_8px_20px_-8px_var(--glow)]"
            />
            <span className="text-[1.05rem] font-extrabold tracking-[-0.025em]">Lavande</span>
          </a>

          <div className="ml-auto flex items-center gap-2">
            <a
              href="/"
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/80 px-4 py-2 text-[0.84rem] font-semibold text-ink-soft no-underline transition-colors hover:border-accent-ring hover:bg-surface-2 hover:text-ink"
            >
              <Icon name="chevronLeft" className="size-4" />
              Retour au site
            </a>
            <button
              type="button"
              onClick={toggle}
              aria-pressed={theme === "light"}
              aria-label={`Passer en thème ${nextTheme}`}
              title={`Thème ${nextTheme}`}
              className="grid size-10 place-items-center rounded-full border border-line bg-surface/80 text-ink-soft transition-colors hover:border-accent-ring hover:bg-surface-2 hover:text-ink"
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} className="size-[1.15rem]" />
            </button>
          </div>
        </div>
      </header>

      <main id="contenu" className={cn(container, "py-12 sm:py-16")}>
        <article className={PROSE}>
          <p className="text-[0.72rem] font-extrabold tracking-[0.14em] text-accent-ink uppercase">
            Confidentialité
          </p>
          <h1 className="mt-4 text-[clamp(2rem,5vw,2.9rem)] text-ink">Politique de confidentialité</h1>
          <p className="mt-4 text-[1.06rem] leading-relaxed text-ink-soft">
            Lavande est une application <strong className="font-semibold text-ink">local-first</strong> : vos mails,
            votre agenda et vos tâches restent sur votre appareil. Aucun serveur Lavande ne les reçoit. Cette page
            détaille, sans formule vague, ce qui est stocké, où, et ce qui sort de votre machine — et sous votre
            contrôle.
          </p>
          <p className="mt-3 text-[0.86rem] text-ink-muted">Dernière mise à jour : {UPDATED}</p>

          <Section id="qui-sommes-nous" title="Qui sommes-nous">
            <p>
              Lavande est un projet personnel open source développé par Roman. Il n’existe ni société, ni équipe
              support : le code source est public sur <Ext href={REPO}>le dépôt du projet</Ext>, et le site comme
              l’application sont auto-hébergés.
            </p>
            <p>
              Pour toute question relative à cette politique, contactez{" "}
              <Ext href={`mailto:${CONTACT}`}>{CONTACT}</Ext> — un ticket sur le dépôt convient aussi.
            </p>
          </Section>

          <Section id="local-first" title="Le principe local-first">
            <p>
              Aucun serveur Lavande ne collecte, ne stocke ni ne relaie vos données. Le démon de l’application tourne
              sur votre propre machine, à l’adresse <Code>127.0.0.1</Code> : l’interface lui parle en local, et lui
              seul dialogue avec vos fournisseurs de mail et d’agenda.
            </p>
            <p>
              Il n’y a donc pas de compte Lavande, pas de synchronisation dans le cloud, pas de base de données
              distante à consulter ni à supprimer.
            </p>
          </Section>

          <Section id="donnees-locales" title="Données stockées sur votre appareil">
            <p>Lavande conserve localement, dans une base SQLite sur l’appareil :</p>
            <List>
              <li>les en-têtes des mails synchronisés ;</li>
              <li>le corps des mails que vous ouvrez ;</li>
              <li>les pièces jointes, téléchargées à la demande ;</li>
              <li>un index de recherche construit à partir de ces contenus.</li>
            </List>
            <p>
              Pour tout effacer, retirez le compte dans <strong className="font-semibold text-ink">Réglages →
              Comptes</strong> : ses données locales et ses secrets sont supprimés.
            </p>
          </Section>

          <Section id="secrets" title="Secrets et authentification">
            <p>
              Les mots de passe et les tokens OAuth sont conservés dans le trousseau système de l’appareil (à défaut,
              dans un fichier local chiffré). Ils ne quittent l’appareil que pour l’authentification directe auprès
              de votre fournisseur.
            </p>
          </Section>

          <Section id="flux-mail" title="Flux mail et OAuth Google">
            <p>
              Les échanges IMAP et SMTP sont chiffrés (TLS) et se font en direct entre votre appareil et votre
              fournisseur — Gmail, Outlook, un serveur personnel. Aucune donnée mail ne transite par
              lavande.lanro.eu.
            </p>
            <p>
              Si vous connectez un compte Google, l’application demande les autorisations suivantes lors du
              consentement :
            </p>
            <List>
              <li>
                <Code>https://mail.google.com/</Code> — lecture et envoi de mail ;
              </li>
              <li>
                <Code>https://www.googleapis.com/auth/calendar</Code> — accès à l’agenda ;
              </li>
              <li>
                <Code>openid</Code> et <Code>email</Code> — identité au moment du consentement.
              </li>
            </List>
            <p>
              Ces autorisations servent uniquement à la synchronisation. Le refresh token est stocké localement et
              reste révocable à tout moment depuis{" "}
              <Ext href="https://myaccount.google.com/permissions">les autorisations de votre compte Google</Ext>.
            </p>
            <p>
              Transparence : l’application n’est pas vérifiée par Google. L’écran de consentement affiche donc un
              avertissement « application non vérifiée », que vous pouvez contourner en connaissance de cause.
            </p>
          </Section>

          <Section id="ia" title="Intelligence artificielle optionnelle">
            <p>
              Les fonctions d’IA sont désactivables dans <strong className="font-semibold text-ink">Réglages</strong>.
              Quand elles sont actives, les envois se font vers l’endpoint d’inférence que <em>vous</em> configurez
              (préréglage NeuralWatt), jamais vers un serveur Lavande :
            </p>
            <List>
              <li>
                le triage automatique envoie les métadonnées et un extrait du mail — expéditeur, sujet, date,
                aperçu ;
              </li>
              <li>
                les fonctions avancées (tâches, rendez-vous, résumés) envoient le contenu que vous sélectionnez au
                modèle configuré ;
              </li>
              <li>le garde-fou avant envoi analyse le brouillon via ce même endpoint.</li>
            </List>
            <p>Sans configuration IA, rien ne sort de l’appareil.</p>
          </Section>

          <Section id="pgp" title="Chiffrement PGP">
            <p>
              Les clés PGP et le déchiffrement sont entièrement locaux : les clés privées ne quittent pas l’appareil
              et le contenu déchiffré n’est transmis à aucun service.
            </p>
          </Section>

          <Section id="mises-a-jour" title="Mises à jour et journaux">
            <p>
              Pour vérifier les mises à jour, l’application consulte{" "}
              <Ext href="https://lavande.lanro.eu/updates/latest.json">
                https://lavande.lanro.eu/updates/latest.json
              </Ext>
              .
            </p>
            <p>
              Comme tout serveur web, celui de lavande.lanro.eu journalise les requêtes qu’il reçoit : adresse IP,
              horodatage et URL demandée. Ces journaux ne sont ni analysés ni recoupés.
            </p>
          </Section>

          <Section id="site-vitrine" title="Site vitrine">
            <p>
              Ce site n’utilise aucun cookie, aucun traceur et aucune solution d’analytics. Seul votre choix de thème
              clair ou sombre est conservé dans le <Code>localStorage</Code> du navigateur : c’est un stockage
              strictement fonctionnel, qui ne vous identifie pas.
            </p>
          </Section>

          <Section id="vos-droits" title="Vos droits et contact">
            <p>
              Toutes vos données étant sur votre appareil, vous les contrôlez directement : consultation, export et
              suppression se font depuis l’application, sans intermédiaire et sans demande à formuler.
            </p>
            <p>
              Pour une question sur cette politique : <Ext href={`mailto:${CONTACT}`}>{CONTACT}</Ext> (ou un
              ticket sur <Ext href={REPO}>le dépôt du projet</Ext>).
            </p>
          </Section>
        </article>
      </main>

      <footer className="mt-10 border-t border-line bg-surface/30">
        <div
          className={cn(
            container,
            "flex flex-col gap-3 py-7 text-[0.82rem] text-ink-muted sm:flex-row sm:items-center sm:justify-between",
          )}
        >
          <p>© {new Date().getFullYear()} Lavande · auto-hébergé</p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <a href="/" className="font-semibold text-ink-soft no-underline transition-colors hover:text-ink">
              Retour au site
            </a>
            <Ext href={REPO}>Code source</Ext>
          </div>
        </div>
      </footer>
    </>
  );
}
