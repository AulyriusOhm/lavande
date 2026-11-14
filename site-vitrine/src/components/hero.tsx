import { motion } from "motion/react";

import { DemoStage } from "@/components/demo-stage";
import { Icon } from "@/components/icons";
import { AnimatedShinyText } from "@/components/magicui/animated-shiny-text";
import { AuroraText } from "@/components/magicui/aurora-text";
import { DotPattern } from "@/components/magicui/dot-pattern";
import { Marquee } from "@/components/magicui/marquee";
import { ShimmerButton } from "@/components/magicui/shimmer-button";
import { stagger, staggerItem } from "@/components/ui/reveal";
import type { Theme } from "@/hooks/useTheme";
import { container, sectionPad } from "@/lib/layout";

const PROTOCOLS = [
  "IMAP",
  "SMTP",
  "OAuth2",
  "CalDAV",
  "Google Agenda",
  "ICS",
  "PGP",
  "MCP",
  "IA locale",
];

const META = ["Linux · Windows · macOS", "Android", "Auto-hébergé"];

const AURORA_DARK = ["#bda9ff", "#8b7cf6", "#c3b6fb", "#8b7cf6"];
const AURORA_LIGHT = ["#6247dd", "#7457ea", "#8b7cf6", "#4f46e5"];

export function Hero({ theme }: { theme: Theme }) {
  return (
    <section id="demo" aria-labelledby="hero-title" className={`relative overflow-hidden ${sectionPad} pt-28`}>
      <DotPattern
        className="text-ink/25 [mask-image:radial-gradient(64%_58%_at_50%_0%,#000_0%,transparent_78%)]"
        width={26}
        height={26}
        cr={1}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 right-[-8%] -z-10 h-[34rem] w-[34rem] rounded-full bg-[radial-gradient(circle,var(--glow),transparent_68%)] blur-[70px]"
      />

      <div className={`relative ${container}`}>
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-14">
          <motion.div initial="hidden" animate="visible" variants={stagger} className="max-w-[34rem]">
            <motion.p variants={staggerItem}>
              <span className="inline-flex items-center gap-2 rounded-full border border-accent-ring/70 bg-accent-soft px-3 py-1.5 text-[0.7rem] font-extrabold tracking-[0.09em] text-accent-ink uppercase">
                <span
                  aria-hidden="true"
                  className="block size-1.5 rounded-full bg-accent shadow-[0_0_0_4px_color-mix(in_oklab,var(--accent)_22%,transparent)]"
                />
                <AnimatedShinyText shimmerWidth={90}>Mail · Agenda · Planification</AnimatedShinyText>
              </span>
            </motion.p>

            <motion.h1
              variants={staggerItem}
              id="hero-title"
              className="mt-4 bg-[linear-gradient(118deg,var(--ink)_26%,color-mix(in_oklab,var(--accent)_78%,var(--ink))_72%,var(--accent)_100%)] bg-clip-text text-[clamp(3.2rem,9vw,5.6rem)] leading-[0.92] tracking-[-0.055em] text-transparent"
            >
              Lavande
            </motion.h1>

            <motion.p
              variants={staggerItem}
              className="mt-4 max-w-[30ch] text-[clamp(1.05rem,1.7vw,1.22rem)] leading-relaxed text-ink-soft"
            >
              Le mail, l’agenda et la planification{" "}
              <AuroraText colors={theme === "light" ? AURORA_LIGHT : AURORA_DARK}>réunis</AuroraText> dans
              une seule application. Chiffré par compte, assisté par l’IA que vous choisissez.
            </motion.p>

            <motion.p variants={staggerItem} className="mt-4 max-w-[38ch] text-[0.94rem] leading-relaxed text-ink-muted">
              Vos messages deviennent des tâches et des rendez-vous sans quitter la boîte. Aucun
              service tiers ne voit passer vos données.
            </motion.p>

            <motion.div variants={staggerItem} className="mt-8 flex flex-wrap items-center gap-3">
              <ShimmerButton
                href="#telecharger"
                background="linear-gradient(135deg,var(--accent-strong),var(--accent-deep))"
                shimmerColor="#ffffff"
                borderRadius="999px"
                className="px-6 py-3 text-[0.92rem] font-bold shadow-[0_18px_40px_-20px_var(--glow)]"
              >
                <Icon name="download" className="size-4" />
                Télécharger
              </ShimmerButton>
              <a
                href="#fonctionnalites"
                className="group inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface/70 px-5 py-3 text-[0.92rem] font-bold text-ink transition-all duration-300 hover:-translate-y-0.5 hover:border-accent-ring hover:bg-surface-2"
              >
                Fonctionnalités
                <Icon
                  name="arrowRight"
                  className="size-4 text-accent transition-transform duration-300 group-hover:translate-x-1"
                />
              </a>
            </motion.div>

            <motion.ul variants={staggerItem} className="mt-7 flex flex-wrap gap-x-5 gap-y-2 text-[0.78rem] font-semibold text-ink-muted">
              {META.map((item) => (
                <li key={item} className="inline-flex items-center gap-1.5">
                  <Icon name="check" className="size-3.5 text-accent" strokeWidth={2.8} />
                  {item}
                </li>
              ))}
            </motion.ul>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 26, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.8, ease: "easeOut", delay: 0.15 }}
            className="relative min-w-0"
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-[-10%_-6%] -z-10 rounded-[3rem] bg-[radial-gradient(58%_58%_at_60%_34%,var(--glow),transparent_72%)] blur-[42px]"
            />
            <DemoStage theme={theme} />
          </motion.div>
        </div>

        <div className="relative mt-14 overflow-hidden rounded-2xl border border-line/80 bg-surface/40 py-3">
          <Marquee pauseOnHover className="[--duration:38s]">
            {PROTOCOLS.map((protocol) => (
              <span
                key={protocol}
                className="mx-3 inline-flex items-center gap-2 text-[0.82rem] font-semibold tracking-wide text-ink-muted"
              >
                <span aria-hidden="true" className="block size-1.5 rounded-full bg-accent/60" />
                {protocol}
              </span>
            ))}
          </Marquee>
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-canvas to-transparent" />
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-canvas to-transparent" />
        </div>
      </div>
    </section>
  );
}
