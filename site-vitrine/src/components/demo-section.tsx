import { DemoStage } from "@/components/demo-stage";
import { Reveal } from "@/components/ui/reveal";
import { SectionHead } from "@/components/ui/section-head";
import type { Theme } from "@/hooks/useTheme";
import { container, sectionPad } from "@/lib/layout";

export function DemoSection({ theme }: { theme: Theme }) {
  return (
    <section
      id="essayer"
      aria-labelledby="essayer-title"
      className={`relative overflow-hidden ${sectionPad}`}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[30rem] opacity-60 [mask-image:radial-gradient(60%_60%_at_50%_0%,#000_0%,transparent_80%)]"
        style={{
          background:
            "radial-gradient(40rem 24rem at 50% 0%, color-mix(in oklab, var(--accent) 20%, transparent), transparent 72%)",
        }}
      />
      <div className={container}>
        <SectionHead
          index="04"
          kicker="Démo interactive"
          title="Prenez les commandes"
          titleId="essayer-title"
          align="center"
          className="mx-auto max-w-[40rem] text-center"
        >
          La vraie application, avec des données d'exemple. Parcourez les dossiers, l'agenda, le kanban —
          sur ordinateur ou téléphone, directement dans votre navigateur.
        </SectionHead>

        <Reveal className="mx-auto mt-12 max-w-[62rem]">
          <DemoStage theme={theme} />
        </Reveal>
      </div>
    </section>
  );
}
