import { cn } from "@/lib/utils";

export function AnimatedGradientText({
  children,
  className,
  duration = 6,
}: {
  children: React.ReactNode;
  className?: string;
  duration?: number;
}) {
  return (
    <span
      className={cn(
        "inline-block bg-clip-text text-transparent",
        "bg-[linear-gradient(110deg,var(--accent),45%,color-mix(in_oklab,var(--accent)_40%,white),55%,var(--accent))] bg-[length:200%_auto]",
        className,
      )}
      style={{ animation: `gradient-pan ${duration}s ease-in-out infinite` }}
    >
      {children}
    </span>
  );
}

export function ShinyText({
  children,
  className,
  duration = 5,
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  duration?: number;
  delay?: number;
}) {
  return (
    <span
      className={cn(
        "inline-block bg-clip-text text-transparent",
        "bg-[linear-gradient(110deg,var(--ink-soft)_18%,var(--accent-ink)_50%,var(--ink-soft)_82%)] bg-[length:200%_100%] bg-no-repeat",
        className,
      )}
      style={{ animation: `shiny-text ${duration}s ease-in-out infinite ${delay}s` }}
    >
      {children}
    </span>
  );
}
