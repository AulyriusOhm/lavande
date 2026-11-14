import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

interface ScaledFrameProps {
  width: number;
  height: number;
  src: string;
  title: string;
  onLoad?: () => void;
  overlay?: ReactNode;
  className?: string;
  frameKey?: string;
}

export function ScaledFrame({
  width,
  height,
  src,
  title,
  onLoad,
  overlay,
  className,
  frameKey,
}: ScaledFrameProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setScale(host.clientWidth / width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [width]);

  return (
    <div
      ref={hostRef}
      className={cn("relative w-full overflow-hidden bg-canvas", className)}
      style={{ aspectRatio: `${width} / ${height}` }}
    >
      <iframe
        key={frameKey}
        src={src}
        title={title}
        onLoad={onLoad}
        scrolling="no"
        className="absolute top-0 left-0 border-0"
        style={{
          width,
          height,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          visibility: scale > 0 ? "visible" : "hidden",
        }}
      />
      {overlay}
    </div>
  );
}
