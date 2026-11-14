import { motion } from "motion/react";

import { Icon, type IconName } from "@/components/icons";
import { Reveal } from "@/components/ui/reveal";
import { SectionHead } from "@/components/ui/section-head";
import { container, sectionPad } from "@/lib/layout";

const STEPS: { title: string; copy: string; meta: string; icon: IconName }[] = [
  {
    title: "Le message arrive",
    copy: "La boîte unifie vos comptes. Les messages chiffrés ou signés affichent leur état avant la lecture, pas après.",
    meta: "Camille Roux · v3 avant la démo",
    icon: "mail",
  },
  {
    title: "La suggestion apparaît",
    copy: "L’assistant propose une tâche ou un rendez-vous, avec l’échéance déduite du texte. Un clic sur le + et c’est planifié.",
    meta: "Tâche « Valider la v3 » · vendredi",
    icon: "sparkles",
  },
  {
    title: "La planification suit",
    copy: "La tâche rejoint le kanban, garde le lien vers son mail et se synchronise chiffrée de bout en bout entre vos appareils.",
    meta: "À faire · En cours · Fait",
    icon: "columns",
  },
];

export function Flow() {
  return (
    <section id="flux" aria-labelledby="flow-title" className={`relative ${sectionPad}`}>
      <div className={container}>
        <SectionHead kicker="Du mail à la tâche" title="Un message suffit à faire avancer la journée" titleId="flow-title">
          La suggestion n’est pas une notification de plus : elle porte l’objet du mail, l’échéance
          déduite et le lien vers la conversation.
        </SectionHead>

        <div className="relative mt-12">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-[13%] top-[3.45rem] hidden h-px overflow-hidden md:block"
            style={{
              backgroundImage:
                "linear-gradient(90deg, transparent, color-mix(in oklab, var(--accent) 55%, transparent), transparent)",
            }}
          >
            <motion.span
              className="absolute top-1/2 block h-1.5 w-16 -translate-y-1/2 rounded-full bg-accent/80 blur-[3px]"
              initial={{ left: "0%" }}
              whileInView={{ left: ["0%", "100%"] }}
              viewport={{ once: false, margin: "-15% 0px" }}
              transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
            />
          </div>

          <ol className="relative grid gap-6 md:grid-cols-3 md:gap-5" role="list">
            {STEPS.map((step, index) => (
              <Reveal as="li" key={step.title} delay={index * 0.1} className="relative">
                <div className="group h-full rounded-2xl border border-line bg-surface/55 p-6 transition-all duration-500 hover:-translate-y-1 hover:border-accent-ring/70 hover:bg-surface hover:shadow-[var(--shadow-soft)]">
                  <div className="flex items-center gap-3">
                    <span className="grid size-11 place-items-center rounded-xl border border-accent-ring/50 bg-accent-soft text-accent-ink transition-colors group-hover:text-accent">
                      <Icon name={step.icon} className="size-5" />
                    </span>
                    <span className="text-[0.72rem] font-extrabold tracking-[0.16em] text-ink-muted uppercase">
                      Étape {index + 1}
                    </span>
                  </div>
                  <h3 className="mt-4 text-xl text-ink">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-soft">{step.copy}</p>
                  <span className="mt-4 inline-flex rounded-full border border-line bg-surface-2/70 px-3 py-1 text-[0.72rem] font-semibold text-ink-muted">
                    {step.meta}
                  </span>
                </div>
              </Reveal>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
