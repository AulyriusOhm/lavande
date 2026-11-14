import { useRef } from "react";

import { Icon, type IconName } from "@/components/icons";
import { AnimatedBeam } from "@/components/magicui/animated-beam";
import { Reveal } from "@/components/ui/reveal";
import { SectionHead } from "@/components/ui/section-head";
import { container, sectionPad } from "@/lib/layout";

const STEPS: { title: string; copy: string; meta: string; icon: IconName }[] = [
  {
    title: "Le message arrive",
    copy: "La boîte unifie vos comptes. Signé ou chiffré : l’état PGP s’affiche avant la lecture, pas après.",
    meta: "Camille Roux · v3 avant la démo",
    icon: "mail",
  },
  {
    title: "La suggestion apparaît",
    copy: "L’assistant propose une tâche ou un rendez-vous, échéance déduite du texte. Un clic sur le + et c’est planifié.",
    meta: "Tâche « Valider la v3 » · vendredi",
    icon: "sparkles",
  },
  {
    title: "La planification suit",
    copy: "La tâche rejoint le kanban, garde le lien vers son mail et se synchronise chiffrée entre vos appareils.",
    meta: "À faire · En cours · Fait",
    icon: "columns",
  },
];

export function Flow() {
  const containerRef = useRef<HTMLDivElement>(null);
  const step1 = useRef<HTMLSpanElement>(null);
  const step2 = useRef<HTMLSpanElement>(null);
  const step3 = useRef<HTMLSpanElement>(null);
  const refs = [step1, step2, step3];

  return (
    <section id="flux" aria-labelledby="flow-title" className={`relative ${sectionPad}`}>
      <div className={container}>
        <SectionHead index="02" kicker="Du mail à la tâche" title="Un message fait avancer la journée" titleId="flow-title">
          La suggestion n’est pas une notification de plus : elle porte l’objet du mail, l’échéance
          déduite et le lien vers la conversation.
        </SectionHead>

        <div ref={containerRef} className="relative mt-12">
          <AnimatedBeam
            containerRef={containerRef}
            fromRef={step1}
            toRef={step2}
            curvature={-40}
            duration={4}
            pathColor="var(--line-strong)"
            pathOpacity={0.5}
            gradientStartColor="var(--accent-bright)"
            gradientStopColor="#e879f9"
            className="hidden md:block"
          />
          <AnimatedBeam
            containerRef={containerRef}
            fromRef={step2}
            toRef={step3}
            curvature={-40}
            duration={4}
            delay={1.2}
            pathColor="var(--line-strong)"
            pathOpacity={0.5}
            gradientStartColor="#e879f9"
            gradientStopColor="var(--accent-bright)"
            className="hidden md:block"
          />

          <ol className="relative grid gap-6 md:grid-cols-3 md:gap-5" role="list">
            {STEPS.map((step, index) => (
              <Reveal as="li" key={step.title} delay={index * 0.1} className="relative">
                <div className="group h-full rounded-2xl border border-line bg-surface/55 p-6 transition-all duration-500 hover:-translate-y-1 hover:border-accent-ring/70 hover:bg-surface hover:shadow-[var(--shadow-soft)]">
                  <div className="flex items-center gap-3">
                    <span
                      ref={refs[index]}
                      className="relative z-10 grid size-11 place-items-center rounded-xl border border-accent-ring/50 bg-accent-soft text-accent-ink transition-colors group-hover:text-accent"
                    >
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
