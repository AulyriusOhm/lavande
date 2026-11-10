import { cn } from "@/lib/utils";

export function DotPattern({
  className,
  size = 16,
  radius = 1,
}: {
  className?: string;
  size?: number;
  radius?: number;
}) {
  return (
    <svg
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 h-full w-full fill-current text-ink", className)}
    >
      <defs>
        <pattern
          id="dot-pattern"
          width={size}
          height={size}
          patternUnits="userSpaceOnUse"
          patternContentUnits="userSpaceOnUse"
        >
          <circle cx={radius} cy={radius} r={radius} />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#dot-pattern)" />
    </svg>
  );
}

export function MeshGlow({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0", className)}>
      <div className="absolute -left-24 -top-32 h-64 w-64 rounded-full bg-accent opacity-[0.11] blur-[90px]" />
      <div className="absolute -right-20 top-6 h-56 w-56 rounded-full bg-accent opacity-[0.07] blur-[100px]" />
      <div className="absolute -bottom-24 left-1/3 h-64 w-64 rounded-full bg-accent opacity-[0.06] blur-[110px]" />
    </div>
  );
}
