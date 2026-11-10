import { motion, useReducedMotion } from "motion/react";
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

  return (
    <motion.div
      initial={{ opacity: 0, y: yOffset, filter: "blur(8px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ delay, duration, ease: [0.22, 1, 0.36, 1] }}
      className={cn(className)}
    >
      {children}
    </motion.div>
  );
}
