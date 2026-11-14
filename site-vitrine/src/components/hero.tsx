import { motion } from "motion/react";

import { Brand } from "@/components/brand";
import { DemoStage } from "@/components/demo-stage";
import { Icon } from "@/components/icons";
import { AnimatedShinyText } from "@/components/magicui/animated-shiny-text";
import { AuroraText } from "@/components/magicui/aurora-text";
import { Marquee } from "@/components/magicui/marquee";
import { ShimmerButton } from "@/components/magicui/shimmer-button";
import { stagger, staggerItem } from "@/components/ui/reveal";
import type { Theme } from "@/hooks/useTheme";
import { container, sectionPad } from "@/lib/layout";

const PROTOCOLS = ["IMAP", "SMTP", "OAuth2", "CalDAV", "Google Agenda", "ICS", "OpenPGP", "MCP", "IA locale"];

const AURORA_DARK = ["#bda9ff", "#8b7cf6", "#e879f9", "#8b7cf6"];
const AURORA_LIGHT = ["#6247dd", "#7457ea", "#c026d3", "#4f46e5"];

export function Hero({ theme }: { theme: Theme }) {
  return (
    <section id="demo" aria-labelledby="hero-title" className={`relative overflow-hidden ${sectionPad} pt-28 lg:pt-32`}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-40 -z-10 h-[46rem] opacity-70 [mask-image:radial-gradient(70%_60%_at_50%_30%,#000_0%,transparent_80%)]"
        style={{
          background:
            "radial-gradient(38rem 26rem at 18% 20%, color-mix(in oklab, #8b7cf6 26%, transparent), transparent 70%), radial-gradient(34rem 24rem at 82% 12%, color-mix(in oklab, #e879f9 16%, transparent), transparent 72%), radial-gradient(40rem 28rem at 60% 70%, color-mix(in oklab, #38bdf8 12%, transparent), transparent 74%)",
        }}
      />

      <div className={`relative ${container}`}>
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] lg:gap-12">
          <motion.div initial="hidden" animate="visible" variants={stagger} className="max-w-[32rem]">
            <motion.p variants={staggerItem}>
              <span className="inline-flex items-center gap-2 rounded-full border border-accent-ring/70 bg-accent-soft px-3 py-1.5 text-[0.7rem] font-extrabold tracking-[0.09em] text-accent-ink uppercase">
                <span
                  aria-hidden="true"
                  className="block size-1.5 rounded-full bg-accent shadow-[0_0_0_4px_color-mix(in_oklab,var(--accent)_22%,transparent)]"
                />
                <AnimatedShinyText shimmerWidth={90}>Auto-hébergé · chiffré · sans tracking</AnimatedShinyText>
              </span>
            </motion.p>

            <motion.h1
              variants={staggerItem}
              id="hero-title"
              className="mt-5 bg-[linear-gradient(118deg,var(--ink)_26%,color-mix(in_oklab,var(--accent)_78%,var(--ink))_72%,var(--accent)_100%)] bg-clip-text text-[clamp(3.4rem,9vw,6rem)] leading-[0.9] tracking-[-0.06em] text-transparent"
            >
              Lavande
            </motion.h1>

            <motion.p
              variants={staggerItem}
              className="mt-5 max-w-[28ch] text-[clamp(1.1rem,1.8vw,1.35rem)] leading-snug font-semibold text-ink"
            >
              Mail, agenda, planification.{" "}
              <AuroraText colors={theme === "light" ? AURORA_LIGHT : AURORA_DARK}>Une seule app</AuroraText>, sur vos
              machines.
            </motion.p>

            <motion.p variants={staggerItem} className="mt-4 max-w-[36ch] text-[0.96rem] leading-relaxed text-ink-soft">
              Vos messages deviennent des tâches et des rendez-vous sans quitter la boîte. PGP par compte, IA au
              choix — rien ne sort de chez vous.
            </motion.p>

            <motion.div variants={staggerItem} className="mt-8 flex flex-wrap items-center gap-3">
              <ShimmerButton
                href="#essayer"
                background="linear-gradient(135deg,var(--accent-strong),var(--accent-deep))"
                shimmerColor="#ffffff"
                borderRadius="999px"
                className="px-6 py-3 text-[0.92rem] font-bold shadow-[0_18px_40px_-20px_var(--glow)]"
              >
                <Icon name="sparkles" className="size-4" />
                Essayer la démo
              </ShimmerButton>
              <a
                href="#telecharger"
                className="group inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface/70 px-5 py-3 text-[0.92rem] font-bold text-ink transition-all duration-300 hover:-translate-y-0.5 hover:border-accent-ring hover:bg-surface-2"
              >
                Télécharger
                <Icon
                  name="arrowRight"
                  className="size-4 text-accent transition-transform duration-300 group-hover:translate-x-1"
                />
              </a>
            </motion.div>

            <motion.ul variants={staggerItem} className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3 text-[0.8rem] font-semibold text-ink-muted">
              <li className="inline-flex items-center gap-2">
                <span className="flex items-center gap-2.5 text-ink-soft">
                  <Brand name="linux" className="size-4" />
                  <Brand name="windows" className="size-3.5" />
                  <Brand name="apple" className="size-4" />
                  <Brand name="android" className="size-4" />
                </span>
                Linux · Windows · macOS · Android
              </li>
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
