import type { ReactNode } from "react";

import { Reveal } from "@/components/ui/reveal";
import { cn } from "@/lib/utils";

interface SectionHeadProps {
  kicker: string;
  title: string;
  titleId?: string;
  children?: ReactNode;
  className?: string;
  align?: "left" | "center";
}

export function SectionHead({ kicker, title, titleId, children, className, align = "left" }: SectionHeadProps) {
  return (
    <Reveal className={cn("max-w-[46rem]", align === "center" && "mx-auto text-center", className)}>
      <span className="inline-flex items-center gap-2 rounded-full border border-accent-ring/60 bg-accent-soft px-3 py-1 text-[0.7rem] font-extrabold tracking-[0.09em] text-accent-ink uppercase">
        {kicker}
      </span>
      <h2 id={titleId} className="mt-4 text-[clamp(1.85rem,4.2vw,2.85rem)] text-ink">
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
