import { cn } from "@/lib/utils";

const MASK = "linear-gradient(transparent, transparent), linear-gradient(#000, #000)";

export function BorderBeam({ className, duration = 7 }: { className?: string; duration?: number }) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]", className)}
      style={{
        padding: 1.5,
        maskImage: MASK,
        maskClip: "padding-box, border-box",
        maskComposite: "intersect",
        WebkitMaskImage: MASK,
        WebkitMaskClip: "padding-box, border-box",
      }}
    >
      <div
        className="h-full w-full rounded-[inherit]"
        style={{
          background:
            "conic-gradient(from 0deg, transparent 0deg, transparent 290deg, color-mix(in oklab, var(--accent) 45%, white) 335deg, var(--accent) 350deg, transparent 360deg)",
          animation: `spin ${duration}s linear infinite`,
        }}
      />
    </div>
  );
}
