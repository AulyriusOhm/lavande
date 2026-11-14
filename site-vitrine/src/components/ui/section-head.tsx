import type { ReactNode } from "react";

import { Reveal } from "@/components/ui/reveal";
import { cn } from "@/lib/utils";

interface SectionHeadProps {
  kicker: string;
  title: string;
  titleId?: string;
  index?: string;
  children?: ReactNode;
  className?: string;
  align?: "left" | "center";
}

export function SectionHead({ kicker, title, titleId, index, children, className, align = "left" }: SectionHeadProps) {
  return (
    <Reveal className={cn("max-w-[46rem]", align === "center" && "mx-auto text-center", className)}>
      <span className="inline-flex items-center gap-2.5 text-[0.72rem] font-extrabold tracking-[0.14em] text-accent-ink uppercase">
        {index ? (
          <span className="font-mono text-[0.8rem] tracking-normal text-accent/70 tabular-nums">{index}</span>
        ) : null}
        <span aria-hidden="true" className="block h-px w-7 bg-accent-ring" />
        {kicker}
      </span>
      <h2 id={titleId} className="mt-4 text-[clamp(1.95rem,4.4vw,3rem)] tracking-[-0.04em] text-ink">
        {title}
      </h2>
      {children ? (
        <p className={cn("mt-3 text-[1.02rem] leading-relaxed text-ink-soft", align === "center" && "mx-auto")}>
          {children}
        </p>
      ) : null}
    </Reveal>
  );
}
