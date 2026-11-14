import { motion, type Variants } from "motion/react";
import type { ReactNode } from "react";

const TAGS = {
  div: "div",
  section: "section",
  li: "li",
  article: "article",
  header: "header",
  ul: "ul",
} as const;

interface RevealProps {
  children: ReactNode;
  delay?: number;
  className?: string;
  as?: keyof typeof TAGS;
}

export function Reveal({ children, className, as = "div" }: RevealProps) {
  const Component = TAGS[as];
  return <Component className={className}>{children}</Component>;
}

export const stagger: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
};

export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.55, ease: "easeOut" } },
};

export const heroMotion = motion;
