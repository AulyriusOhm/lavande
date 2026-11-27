import { motion, useReducedMotion } from "motion/react";
import { isNativeShell } from "@/lib/native";
import { cn } from "@/lib/utils";

type BlurFadeProps = {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  duration?: number;
  yOffset?: number;
  once?: boolean;
};

export function BlurFade({
  children,
  className,
  delay = 0,
  duration = 0.45,
  yOffset = 10,
}: BlurFadeProps) {
  const reduce = useReducedMotion();

  if (reduce) return <div className={cn(className)}>{children}</div>;

  const native = isNativeShell();

  return (
    <motion.div
      initial={native ? { opacity: 0, y: yOffset } : { opacity: 0, y: yOffset, filter: "blur(8px)" }}
      animate={
        native
          ? { opacity: 1, y: 0 }
          : { opacity: 1, y: 0, filter: "blur(0px)", transitionEnd: { filter: "none" } }
      }
      transition={{ delay, duration: native ? Math.min(duration, 0.28) : duration, ease: [0.22, 1, 0.36, 1] }}
      className={cn(className)}
    >
      {children}
    </motion.div>
  );
}
