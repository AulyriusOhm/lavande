import { useRef } from "react";
import { motion, useScroll, useTransform, type MotionValue } from "motion/react";

const SENTENCE = "Vos mails restent chez vous. Votre agenda aussi. Votre plan aussi.";

export function Manifesto() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 0.85", "end 0.6"] });
  const words = SENTENCE.split(" ");

  return (
    <div ref={ref} className="relative mx-auto max-w-[52rem] px-6 py-[16vh] text-center">
      <p className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-[clamp(1.6rem,4.5vw,3rem)] font-extrabold tracking-[-0.03em] leading-[1.15]">
        {words.map((word, i) => (
          <Word key={i} progress={scrollYProgress} range={[i / words.length, (i + 1) / words.length]}>
            {word}
          </Word>
        ))}
      </p>
    </div>
  );
}

function Word({
  children,
  progress,
  range,
}: {
  children: string;
  progress: MotionValue<number>;
  range: [number, number];
}) {
  const opacity = useTransform(progress, range, [0.16, 1]);
  const color = useTransform(progress, range, ["var(--ink-muted)", "var(--ink)"]);
  return (
    <motion.span style={{ opacity, color }} className="relative">
      {children}
    </motion.span>
  );
}
