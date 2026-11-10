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
  const from = useRef(value);

  useEffect(() => {
    const start = performance.now();
    const origin = from.current;
    const delta = value - origin;
    if (delta === 0) return;

    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(origin + delta * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
      else from.current = value;
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  return <span className={cn("tabular-nums", className)}>{display}</span>;
}
