import { motion } from "motion/react";

import { Icon } from "@/components/icons";
import { PhoneShell } from "@/components/ui/phone-shell";
import { SectionHead } from "@/components/ui/section-head";
import { stagger, staggerItem } from "@/components/ui/reveal";
import { ThemeShot } from "@/components/ui/theme-shot";
import { container, sectionPad } from "@/lib/layout";

const PHONES = [
  {
    name: "mobile-inbox",
    alt: "Boîte de réception Lavande sur Android : filtres Tous, Non lus, Étoilés et Chiffrés, avec le résumé du midi.",
    label: "Boîte",
    tilt: "-3.5deg",
  },
  {
    name: "mobile-agenda",
    alt: "Agenda Lavande sur Android : vue du jour avec les rendez-vous issus des mails.",
    label: "Agenda",
    tilt: "0deg",
  },
  {
    name: "mobile-settings",
    alt: "Réglages Lavande sur Android : comptes, calendriers, sécurité et apparence.",
    label: "Réglages",
    tilt: "3.5deg",
  },
];

export function MobileSection() {
  return (
    <section id="mobile" aria-labelledby="mobile-title" className={`relative overflow-hidden ${sectionPad}`}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-1/4 -z-10 mx-auto h-[26rem] w-[70rem] max-w-full rounded-full bg-[radial-gradient(circle,var(--glow),transparent_70%)] opacity-70 blur-[80px]"
      />
      <div className={container}>
        <SectionHead index="03" kicker="Android" title="Dans votre poche" titleId="mobile-title" align="center">
          La même interface, en plein écran, avec le moteur mail embarqué. L’APK se réinstalle à la
          main à chaque version.
        </SectionHead>

        <motion.ul
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-15% 0px -10% 0px" }}
          className="mt-12 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3"
        >
          {PHONES.map((phone, index) => (
            <motion.li
              key={phone.name}
              variants={staggerItem}
              className={`group flex flex-col items-center gap-4 ${index === 2 ? "sm:col-span-2 lg:col-span-1" : ""}`}
            >
              <motion.div
                whileHover={{ scale: 1.02, y: -2 }}
                transition={{ type: "spring", stiffness: 260, damping: 24 }}
                className="w-[min(100%,16.5rem)]"
              >
                <PhoneShell>
                  <ThemeShot
                    name={phone.name}
                    alt={phone.alt}
                    width={780}
                    height={1688}
                    wrapperClassName="block w-full"
                    className="block aspect-[390/844] w-full object-cover object-top"
                  />
                </PhoneShell>
              </motion.div>
              <span className="text-[0.74rem] font-bold tracking-[0.14em] text-ink-muted uppercase">
                {phone.label}
              </span>
            </motion.li>
          ))}
        </motion.ul>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <a
            href="/updates/Lavande.apk"
            className="group inline-flex items-center gap-2 rounded-full border border-accent-ring/60 bg-accent-soft px-5 py-3 text-[0.9rem] font-bold text-accent-ink transition-all duration-300 hover:-translate-y-0.5 hover:border-accent-ring hover:text-accent"
          >
            <Icon name="download" className="size-4" />
            Télécharger l’APK (arm64)
            <Icon name="arrowRight" className="size-4 transition-transform duration-300 group-hover:translate-x-1" />
          </a>
          <span className="text-[0.78rem] font-semibold text-ink-muted">APK signé · Android 8+</span>
        </div>
      </div>
    </section>
  );
}
