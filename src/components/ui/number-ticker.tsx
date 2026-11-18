import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export function NumberTicker({
  value,
  className,
  duration = 900,
}: {
  value: number;
  className?: string;
  duration?: number;
}) {
  const [display, setDisplay] = useState(value);
  const origin = useRef(value);
  origin.current = display;

  useEffect(() => {
    const start = performance.now();
    const from = origin.current;
    const delta = value - from;
    if (delta === 0) return;

    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(from + delta * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  return <span className={cn("tabular-nums", className)}>{display}</span>;
}
