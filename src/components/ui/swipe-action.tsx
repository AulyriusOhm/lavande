import { useState } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type SwipeActionDef = {
  label: string;
  icon: LucideIcon;
  tone: "danger" | "accent" | "neutral";
  run: () => void;
};

const TONE: Record<SwipeActionDef["tone"], string> = {
  danger: "bg-red-500/15 text-red-700 dark:text-red-300",
  accent: "bg-accent-soft text-accent-ink",
  neutral: "bg-surface-2 text-ink-soft",
};

const THRESHOLD = 64;

export function SwipeAction({
  children,
  leading,
  trailing,
  className,
}: {
  children: React.ReactNode;
  leading?: SwipeActionDef | null;
  trailing?: SwipeActionDef | null;
  className?: string;
}) {
  const x = useMotionValue(0);
  const reduce = useReducedMotion();
  const [armed, setArmed] = useState<"leading" | "trailing" | null>(null);

  const leadingOpacity = useTransform(x, [8, 56], [0, 1]);
  const trailingOpacity = useTransform(x, [-56, -8], [1, 0]);
  const leadingScale = useTransform(x, [8, 56], [0.85, 1]);
  const trailingScale = useTransform(x, [-56, -8], [1, 0.85]);

  const reset = () => {
    if (reduce) x.set(0);
    else animate(x, 0, { type: "spring", stiffness: 420, damping: 32 });
    setArmed(null);
  };

  return (
    <div className={cn("relative overflow-hidden rounded-[22px]", className)}>
      {leading ? (
        <motion.div
          style={{ opacity: leadingOpacity, scale: leadingScale }}
          className={cn(
            "pointer-events-none absolute inset-y-0 left-0 flex items-center gap-1.5 px-4",
            TONE[leading.tone],
          )}
        >
          <leading.icon className="size-4" strokeWidth={2.4} />
          <span className="text-[11px] font-extrabold">{leading.label}</span>
        </motion.div>
      ) : null}

      {trailing ? (
        <motion.div
          style={{ opacity: trailingOpacity, scale: trailingScale }}
          className={cn(
            "pointer-events-none absolute inset-y-0 right-0 flex items-center gap-1.5 px-4",
            TONE[trailing.tone],
          )}
        >
          <span className="text-[11px] font-extrabold">{trailing.label}</span>
          <trailing.icon className="size-4" strokeWidth={2.4} />
        </motion.div>
      ) : null}

      <motion.div
        data-swipe="true"
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.4}
        dragMomentum={false}
        style={{ x }}
        onDrag={(_, info) => {
          if (info.offset.x > 24 && leading) setArmed("leading");
          else if (info.offset.x < -24 && trailing) setArmed("trailing");
          else setArmed(null);
        }}
        onDragEnd={(_, info) => {
          const offset = info.offset.x;
          const fired =
            (offset > THRESHOLD && leading) || (offset < -THRESHOLD && trailing) ? true : false;
          if (fired) {
            if (offset > 0) leading?.run();
            else trailing?.run();
          }
          reset();
        }}
        className={cn(
          "relative touch-pan-y bg-canvas",
          armed === "leading" && leading ? "ring-1 ring-inset" : "",
        )}
      >
        {children}
      </motion.div>
    </div>
  );
}
