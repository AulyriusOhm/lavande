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
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-x-clip", className)}>
      <div
        className="absolute -left-24 -top-32 h-[340px] w-[340px] rounded-full"
        style={{
          background:
            "radial-gradient(closest-side, color-mix(in oklab, var(--accent) 12%, transparent), color-mix(in oklab, var(--accent) 4%, transparent) 48%, transparent 100%)",
        }}
      />
      <div
        className="absolute -right-20 top-2 h-[300px] w-[300px] rounded-full"
        style={{
          background:
            "radial-gradient(closest-side, color-mix(in oklab, var(--accent) 8%, transparent), color-mix(in oklab, var(--accent) 2.5%, transparent) 48%, transparent 100%)",
        }}
      />
      <div
        className="absolute -bottom-16 left-1/4 h-[280px] w-[280px] rounded-full"
        style={{
          background:
            "radial-gradient(closest-side, color-mix(in oklab, var(--accent) 6%, transparent), color-mix(in oklab, var(--accent) 1.5%, transparent) 48%, transparent 100%)",
        }}
      />
    </div>
  );
}
