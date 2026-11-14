import { Icon, type IconName } from "@/components/icons";
import { Reveal } from "@/components/ui/reveal";
import { SectionHead } from "@/components/ui/section-head";
import { container, sectionPad } from "@/lib/layout";

const ITEMS: { title: string; copy: string; icon: IconName }[] = [
  {
    title: "Chiffrement de bout en bout",
    copy: "La planification synchronisée est chiffrée côté client : le serveur ne voit ni les titres, ni les échéances, ni les contenus.",
    icon: "lock",
  },
  {
    title: "PGP par compte",
    copy: "Signature et chiffrement OpenPGP à l’envoi, vérification du signataire à la lecture. Les clés privées ne quittent jamais l’appareil.",
    icon: "key",
  },
  {
    title: "Secrets dans le trousseau système",
    copy: "Mots de passe IMAP et SMTP, jetons OAuth2 et clés PGP dans le trousseau du système — fichier chiffré XChaCha20-Poly1305 sur Android. Jamais en clair dans un fichier de configuration.",
    icon: "shield",
  },
  {
    title: "Démon en boucle locale",
    copy: "Le moteur mail n’écoute que sur 127.0.0.1 et exige un jeton. Il n’est jamais exposé au réseau, même quand l’application est ouverte.",
    icon: "server",
  },
  {
    title: "IA au choix",
    copy: "L’endpoint compatible OpenAI est le vôtre : service auto-hébergé, modèle local ou fournisseur, décidé compte par compte. Aucun intermédiaire imposé.",
    icon: "cpu",
  },
  {
    title: "MCP approuvé",
    copy: "Chaque action MCP sensible demande une approbation explicite, et le journal garde la trace de ce qui a été demandé et exécuté.",
    icon: "network",
  },
  {
    title: "Paquets signés",
    copy: "RPM et AppImage signés GPG, mises à jour signées minisign et version vérifiée à l’installation, APK signé. Trois chaînes de confiance indépendantes.",
    icon: "package",
  },
  {
    title: "Contenu assaini",
    copy: "Le HTML des mails est nettoyé à l’arrivée, les images distantes restent masquées par défaut — aucun pixel de tracking n’est chargé sans votre accord.",
    icon: "mail",
  },
];

export function Security() {
  return (
    <section id="securite" aria-labelledby="security-title" className={`relative ${sectionPad}`}>
      <div className={container}>
        <SectionHead kicker="Confidentialité et sécurité" title="Rien en clair, rien d’implicite" titleId="security-title">
          Vos mails restent sur votre serveur, vos clés sur votre machine. Lavande n’ajoute aucun
          intermédiaire entre vous et eux.
        </SectionHead>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ITEMS.map((item, index) => (
            <Reveal key={item.title} delay={(index % 4) * 0.06}>
              <article className="group h-full rounded-2xl border border-line bg-surface/50 p-5 transition-all duration-500 hover:-translate-y-1 hover:border-accent-ring/60 hover:bg-surface hover:shadow-[var(--shadow-soft)]">
                <span className="grid size-10 place-items-center rounded-xl border border-line bg-surface-2 text-accent-ink transition-colors duration-300 group-hover:border-accent-ring group-hover:text-accent">
                  <Icon name={item.icon} className="size-[1.2rem]" />
                </span>
                <h3 className="mt-3.5 text-base font-bold text-ink">{item.title}</h3>
                <p className="mt-1.5 text-[0.84rem] leading-relaxed text-ink-soft">{item.copy}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
