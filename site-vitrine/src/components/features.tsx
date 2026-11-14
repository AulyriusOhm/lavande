import { BentoCard, BentoGrid } from "@/components/magicui/bento-grid";
import { Icon, type IconName } from "@/components/icons";
import { PhoneShell } from "@/components/ui/phone-shell";
import { Reveal } from "@/components/ui/reveal";
import { SectionHead } from "@/components/ui/section-head";
import { ThemeShot } from "@/components/ui/theme-shot";
import { container, sectionPad } from "@/lib/layout";

function bentoIcon(name: IconName) {
  return function BentoIcon({ className }: { className?: string }) {
    return <Icon name={name} className={className} />;
  };
}

function WideShot({ name, alt }: { name: string; alt: string }) {
  return (
    <ThemeShot
      name={name}
      alt={alt}
      width={1600}
      height={1000}
      wrapperClassName="block h-full w-full"
      className="aspect-[16/10] w-full object-cover object-top transition-transform duration-700 group-hover:scale-[1.02]"
    />
  );
}

function PhoneShot({ name, alt }: { name: string; alt: string }) {
  return (
    <div className="relative flex aspect-[4/5] items-center justify-center overflow-hidden bg-[radial-gradient(85%_65%_at_50%_28%,var(--accent-soft),var(--surface)_78%)]">
      <PhoneShell className="relative w-[10.5rem] transition-transform duration-700 group-hover:scale-[1.02]">
        <ThemeShot
          name={name}
          alt={alt}
          width={780}
          height={1688}
          wrapperClassName="block w-full"
          className="block aspect-[390/844] w-full object-cover object-top"
        />
      </PhoneShell>
    </div>
  );
}

export function Features() {
  return (
    <section id="fonctionnalites" aria-labelledby="features-title" className={`relative ${sectionPad}`}>
      <div className={container}>
        <SectionHead index="01" kicker="Fonctionnalités" title="L’essentiel, sans détour" titleId="features-title">
          Lire, planifier, préparer la semaine — au même endroit, sur PC comme sur mobile. Pas de
          fenêtres éparpillées, pas d’onglets oubliés.
        </SectionHead>

        <Reveal className="mt-10">
          <BentoGrid>
            <BentoCard
              className="sm:col-span-2 lg:col-span-4"
              name="Mail"
              Icon={bentoIcon("mail")}
              description="Vos boîtes unifiées : IMAP et SMTP directs, OAuth2 Google et Microsoft. Fils de discussion, pièces jointes, recherche côté serveur, notifications à l’arrivée. L’état PGP — signé, chiffré — s’affiche avant la lecture."
              tags={["IMAP · SMTP", "OAuth2", "Multi-comptes", "OpenPGP"]}
              background={<WideShot name="pc-inbox" alt="Boîte de réception Lavande : comptes unifiés, résumé IA et fil de discussion ouvert dans le panneau de lecture." />}
            />
            <BentoCard
              className="lg:col-span-2"
              name="Agenda"
              Icon={bentoIcon("calendar")}
              description="Mois, semaine, jour. Calendriers locaux et externes côte à côte. Un rendez-vous reçu par mail se crée en un geste, avec son lien vers le message d’origine."
              tags={["CalDAV", "Google Agenda", "ICS"]}
              background={<PhoneShot name="mobile-agenda" alt="Agenda Lavande sur téléphone : vue du mois et rendez-vous de la journée." />}
            />
            <BentoCard
              className="lg:col-span-2"
              name="Planification"
              Icon={bentoIcon("columns")}
              description="Cinq états, du kanban sur PC à la liste filtrée sur mobile. Glisser-déposer, échéances, sous-tâches — et chaque tâche garde le lien vers son mail."
              tags={["Kanban", "5 états", "Suggestions"]}
              background={<PhoneShot name="mobile-planning" alt="Planification Lavande sur téléphone : tâches classées par état, suggestions issues des mails." />}
            />
            <BentoCard
              className="sm:col-span-2 lg:col-span-4"
              name="IA, à votre main"
              Icon={bentoIcon("sparkles")}
              description="Résumés de fil, propositions de réponse, réécriture — correction, concis, formel, chaleureux. Vous branchez l’endpoint compatible OpenAI de votre choix, modèle local compris. Rien d’imposé, rien qui fuite."
              tags={["Résumés", "Réponses", "Réécriture", "Endpoint au choix"]}
              background={<WideShot name="pc-compose" alt="Rédaction Lavande : suggestion de réponse et outils de réécriture assistée." />}
            />
          </BentoGrid>
        </Reveal>
      </div>
    </section>
  );
}
