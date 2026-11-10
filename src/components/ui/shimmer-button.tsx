import { cn } from "@/lib/utils";

type ShimmerButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  shimmerDuration?: number;
  size?: "sm" | "md" | "lg";
};

const SIZES = {
  sm: "h-9 px-4 text-[13px]",
  md: "h-11 px-5 text-sm",
  lg: "h-13 px-7 text-[15px]",
};

export function ShimmerButton({
  children,
  className,
  shimmerDuration = 3,
  size = "md",
  ...props
}: ShimmerButtonProps) {
  return (
    <button
      {...props}
      className={cn(
        "group relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-full font-semibold",
        "bg-accent text-white shadow-[0_10px_30px_-12px_var(--accent)]",
        "transition-[transform,box-shadow] duration-200 active:scale-[0.97]",
        "disabled:pointer-events-none disabled:opacity-50",
        SIZES[size],
        className,
      )}
    >
      <span
        className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/35 to-transparent"
        style={{ animation: `shimmer-sweep ${shimmerDuration}s ease-in-out infinite` }}
      />
      <span className="relative z-10 inline-flex items-center gap-2">{children}</span>
    </button>
  );
}
