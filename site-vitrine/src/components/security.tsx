import { Icon, type IconName } from "@/components/icons";
import { Reveal } from "@/components/ui/reveal";
import { container, sectionPad } from "@/lib/layout";

const ITEMS: { title: string; copy: string; icon: IconName }[] = [
  {
    title: "PGP par compte",
    copy: "Signature et chiffrement OpenPGP à l’envoi, vérification du signataire à la lecture. Les clés privées ne quittent jamais l’appareil.",
    icon: "key",
  },
  {
    title: "Secrets dans le trousseau système",
    copy: "Mots de passe IMAP/SMTP, jetons OAuth2 et clés PGP dans le trousseau du système — fichier chiffré XChaCha20-Poly1305 sur Android. Jamais en clair dans une configuration.",
    icon: "shield",
  },
  {
    title: "Chiffrement de bout en bout",
    copy: "La planification synchronisée est chiffrée côté client : le serveur ne voit ni les titres, ni les échéances, ni les contenus.",
    icon: "lock",
  },
  {
    title: "Démon en boucle locale",
    copy: "Le moteur mail n’écoute que sur 127.0.0.1 et exige un jeton. Jamais exposé au réseau, même application ouverte.",
    icon: "server",
  },
  {
    title: "IA au choix",
    copy: "L’endpoint compatible OpenAI est le vôtre : auto-hébergé, modèle local ou fournisseur, décidé compte par compte. Aucun intermédiaire imposé.",
    icon: "cpu",
  },
  {
    title: "MCP approuvé",
    copy: "Chaque action MCP sensible demande une approbation explicite ; le journal garde la trace de ce qui a été demandé et exécuté.",
    icon: "network",
  },
  {
    title: "Paquets signés",
    copy: "RPM et AppImage signés GPG, mises à jour minisign vérifiées à l’installation, APK signé. Trois chaînes de confiance indépendantes.",
    icon: "package",
  },
  {
    title: "Contenu assaini",
    copy: "Le HTML des mails est nettoyé à l’arrivée, les images distantes masquées par défaut — aucun pixel de tracking chargé sans votre accord.",
    icon: "mail",
  },
];

export function Security() {
  return (
    <section id="securite" aria-labelledby="security-title" className={`relative ${sectionPad}`}>
      <div className={container}>
        <div className="grid gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
          <Reveal className="lg:sticky lg:top-28 lg:self-start">
            <span className="inline-flex items-center gap-2.5 text-[0.72rem] font-extrabold tracking-[0.14em] text-accent-ink uppercase">
              <span className="font-mono text-[0.8rem] tracking-normal text-accent/70 tabular-nums">06</span>
              <span aria-hidden="true" className="block h-px w-7 bg-accent-ring" />
              Confidentialité & sécurité
            </span>
            <h2 id="security-title" className="mt-4 text-[clamp(1.95rem,4.4vw,3rem)] tracking-[-0.04em] text-ink">
              Rien en clair, rien d’implicite
            </h2>
            <p className="mt-4 text-[1.02rem] leading-relaxed text-ink-soft">
              Vos mails restent sur votre serveur, vos clés sur votre machine. Lavande n’ajoute aucun
              intermédiaire entre vous et eux.
            </p>
            <div className="mt-7 rounded-2xl border border-accent-ring/60 bg-[linear-gradient(160deg,var(--accent-soft),var(--surface)_62%)] p-5">
              <span className="grid size-11 place-items-center rounded-xl border border-accent-ring/60 bg-surface/70 text-accent">
                <Icon name="key" className="size-5" />
              </span>
              <p className="mt-3 text-[0.95rem] leading-relaxed text-ink">
                <strong>OpenPGP est un interrupteur par compte.</strong> Vous choisissez quelles boîtes
                signent et chiffrent — sans automatisme, sans surprise.
              </p>
            </div>
          </Reveal>

          <ul className="divide-y divide-line border-y border-line" role="list">
            {ITEMS.map((item, index) => (
              <Reveal as="li" key={item.title} delay={(index % 2) * 0.05}>
                <div className="group flex gap-4 py-5 transition-colors">
                  <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-surface-2 text-accent-ink transition-colors duration-300 group-hover:border-accent-ring group-hover:text-accent">
                    <Icon name={item.icon} className="size-[1.05rem]" />
                  </span>
                  <div>
                    <h3 className="text-[0.98rem] font-bold text-ink">{item.title}</h3>
                    <p className="mt-1 text-[0.86rem] leading-relaxed text-ink-soft">{item.copy}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
