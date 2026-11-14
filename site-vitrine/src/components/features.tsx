import { BentoCard, BentoGrid } from "@/components/magicui/bento-grid";
import { Icon, type IconName } from "@/components/icons";
import { Reveal } from "@/components/ui/reveal";
import { SectionHead } from "@/components/ui/section-head";
import { ThemeShot } from "@/components/ui/theme-shot";
import { container, sectionPad } from "@/lib/layout";

function bentoIcon(name: IconName) {
  return function BentoIcon({ className }: { className?: string }) {
    return <Icon name={name} className={className} />;
  };
}

function Shot({
  name,
  alt,
  ratio = "aspect-[16/10]",
}: {
  name: string;
  alt: string;
  ratio?: string;
}) {
  return (
    <ThemeShot
      name={name}
      alt={alt}
      width={1600}
      height={1000}
      wrapperClassName="block h-full w-full"
      className={`${ratio} w-full object-cover object-top transition-transform duration-700 group-hover:scale-[1.03]`}
    />
  );
}

export function Features() {
  return (
    <section id="fonctionnalites" aria-labelledby="features-title" className={`relative ${sectionPad}`}>
      <div className={container}>
        <SectionHead kicker="Fonctionnalités" title="Trois outils, une seule boîte" titleId="features-title">
          Pas de fenêtres éparpillées ni d’onglets oubliés : lire, planifier et préparer la semaine se
          fait au même endroit, sur PC comme sur mobile.
        </SectionHead>

        <Reveal className="mt-10">
          <BentoGrid>
            <BentoCard
              className="sm:col-span-2 lg:col-span-3"
              name="Mail"
              Icon={bentoIcon("mail")}
              description="IMAP et SMTP directs, OAuth2 Google et Microsoft. Dossiers, fils de discussion, pièces jointes, recherche côté serveur et notifications à l’arrivée."
              tags={["IMAP · SMTP", "OAuth2", "Multi-comptes"]}
              background={
                <Shot
                  name="pc-inbox"
                  alt="Boîte de réception Lavande sur ordinateur : comptes unifiés, filtres et aperçu des messages."
                />
              }
            />
            <BentoCard
              className="sm:col-span-2 lg:col-span-3"
              name="Agenda"
              Icon={bentoIcon("calendar")}
              description="Vue du mois et du jour, calendriers locaux et externes. Un rendez-vous reçu par mail se crée en un geste, avec son lien vers le message d’origine."
              tags={["CalDAV", "Google Agenda", "ICS"]}
              background={
                <Shot
                  name="pc-agenda"
                  alt="Agenda Lavande sur ordinateur : vue du jour et calendriers superposés."
                />
              }
            />
            <BentoCard
              className="lg:col-span-2"
              name="Planification"
              Icon={bentoIcon("columns")}
              description="Cinq états, du kanban sur PC à la liste filtrée sur mobile. Glisser-déposer, échéances, sous-tâches, et le mail lié toujours à portée de clic."
              tags={["Kanban", "5 états", "Suggestions"]}
              background={
                <Shot
                  name="pc-planning"
                  ratio="aspect-[16/11]"
                  alt="Planification Lavande sur ordinateur : colonnes kanban avec les tâches issues des mails."
                />
              }
            />
            <BentoCard
              className="lg:col-span-2"
              name="IA"
              Icon={bentoIcon("sparkles")}
              description="Résumés de fil, propositions de réponse et réécriture — correction, concis, formel, chaleureux. Vous branchez l’endpoint compatible OpenAI de votre choix, modèle local compris."
              tags={["Résumés", "Réponses", "Réécriture"]}
              background={
                <Shot
                  name="pc-compose"
                  ratio="aspect-[16/11]"
                  alt="Fenêtre de rédaction Lavande : suggestion de réponse et outils de réécriture assistée."
                />
              }
            />
            <BentoCard
              className="lg:col-span-2"
              name="Sécurité"
              Icon={bentoIcon("shield")}
              description="PGP par compte : signature et chiffrement à l’envoi, vérification à la lecture. Les clés privées et les jetons restent dans le trousseau du système."
              tags={["OpenPGP", "Trousseau", "TLS"]}
              background={
                <div className="relative grid aspect-[16/11] place-items-center overflow-hidden bg-[radial-gradient(60%_60%_at_50%_40%,var(--accent-soft),transparent_72%)]">
                  <div
                    aria-hidden="true"
                    className="absolute inset-0 opacity-40"
                    style={{
                      backgroundImage:
                        "linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px)",
                      backgroundSize: "34px 34px",
                    }}
                  />
                  <span className="relative grid size-16 place-items-center rounded-2xl border border-accent-ring/60 bg-surface/80 text-accent shadow-[0_18px_40px_-24px_var(--glow)] transition-transform duration-500 group-hover:scale-105">
                    <Icon name="lock" className="size-7" />
                  </span>
                </div>
              }
            />
            <BentoCard
              className="sm:col-span-2 lg:col-span-6 lg:flex-row lg:items-stretch"
              backgroundClassName="lg:order-2 lg:w-[46%] lg:shrink-0"
              name="Comptes & sync"
              Icon={bentoIcon("network")}
              description="Plusieurs boîtes et calendriers au même endroit, avec un périmètre de synchronisation par compte. Les tâches et l’agenda se synchronisent chiffrés de bout en bout entre le bureau et le téléphone."
              tags={["Multi-comptes", "Périmètre par compte", "Chiffré de bout en bout"]}
              background={
                <Shot
                  name="pc-settings"
                  ratio="aspect-[16/10] h-full lg:aspect-auto"
                  alt="Réglages Lavande sur ordinateur : comptes, calendriers et options de synchronisation."
                />
              }
            />
          </BentoGrid>
        </Reveal>
      </div>
    </section>
  );
}
