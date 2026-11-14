/**
 * Magic UI — MIT License — https://github.com/magicuidesign/magicui
 * Source : apps/www/registry/magicui/bento-grid.tsx
 * Adapté : plus de `Button`/`@radix-ui/react-icons` (SVG inline), palette Lavande,
 * `tags` ajoutés, survol = lévitation + halo au lieu du glissement du CTA.
 */
import { type ComponentPropsWithoutRef, type ElementType, type ReactNode } from "react";

import { cn } from "@/lib/utils";

interface BentoGridProps extends ComponentPropsWithoutRef<"div"> {
  children: ReactNode;
  className?: string;
}

interface BentoCardProps extends ComponentPropsWithoutRef<"div"> {
  name: string;
  className?: string;
  backgroundClassName?: string;
  background: ReactNode;
  Icon?: ElementType;
  description: string;
  tags?: string[];
  href?: string;
  cta?: string;
}

const BentoGrid = ({ children, className, ...props }: BentoGridProps) => {
  return (
    <div className={cn("grid w-full grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6", className)} {...props}>
      {children}
    </div>
  );
};

const BentoCard = ({
  name,
  className,
  backgroundClassName,
  background,
  Icon,
  description,
  tags = [],
  href,
  cta,
  ...props
}: BentoCardProps) => (
  <article
    className={cn(
      "group relative flex flex-col overflow-hidden rounded-2xl border border-line bg-surface/60",
      "transform-gpu transition-[transform,border-color,box-shadow,background-color] duration-500 ease-out",
      "hover:-translate-y-0.5 hover:border-accent-ring/70 hover:bg-surface hover:shadow-[var(--shadow-soft)]",
      className,
    )}
    {...props}
  >
    <div className={cn("relative overflow-hidden", backgroundClassName)}>{background}</div>
    <div className="relative z-10 flex flex-1 flex-col gap-2 p-5 sm:p-6">
      <div className="flex items-center gap-2.5">
        {Icon ? (
          <span className="grid size-9 place-items-center rounded-xl border border-line bg-surface-2 text-accent-ink transition-colors duration-300 group-hover:border-accent-ring group-hover:text-accent">
            <Icon className="size-[1.15rem]" />
          </span>
        ) : null}
        <h3 className="text-lg font-bold tracking-[-0.02em] text-ink sm:text-xl">{name}</h3>
      </div>
      <p className="max-w-[46ch] text-sm leading-relaxed text-ink-soft">{description}</p>
      {tags.length > 0 ? (
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <li
              key={tag}
              className="rounded-full border border-line bg-surface-2/70 px-2.5 py-0.5 text-[0.7rem] font-semibold tracking-wide text-ink-muted"
            >
              {tag}
            </li>
          ))}
        </ul>
      ) : null}
      {href && cta ? (
        <a
          href={href}
          className="mt-auto inline-flex w-fit items-center gap-1.5 pt-2 text-sm font-bold text-accent-ink underline-offset-4 transition-colors hover:text-accent hover:underline"
        >
          {cta}
          <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
            <path
              d="M5 12h14M12 5l7 7-7 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      ) : null}
    </div>
  </article>
);

export { BentoCard, BentoGrid };
