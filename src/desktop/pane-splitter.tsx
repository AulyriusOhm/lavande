import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Pas des flèches du clavier, en pixels. */
const KEY_STEP = 16;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

type PaneSplitterProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
  onReset: () => void;
  onDraggingChange?: (dragging: boolean) => void;
};

/** Poignée verticale entre deux colonnes : glisser, flèches, double-clic pour revenir au défaut. */
export function PaneSplitter({
  label,
  value,
  min,
  max,
  onChange,
  onCommit,
  onReset,
  onDraggingChange,
}: PaneSplitterProps) {
  const origin = useRef<{ x: number; value: number } | null>(null);
  const latest = useRef(value);
  const [dragging, setDragging] = useState(false);

  const emit = (next: number) => {
    latest.current = clamp(next, min, max);
    onChange(latest.current);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    origin.current = { x: event.clientX, value };
    latest.current = value;
    setDragging(true);
    onDraggingChange?.(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const from = origin.current;
    if (!from) return;
    emit(from.value + event.clientX - from.x);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const from = origin.current;
    if (!from) return;
    origin.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDragging(false);
    onDraggingChange?.(false);
    if (latest.current !== from.value) onCommit(latest.current);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowLeft" ? -KEY_STEP : event.key === "ArrowRight" ? KEY_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    emit(value + step);
    onCommit(latest.current);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${Math.round(value)} pixels`}
      tabIndex={0}
      data-splitter={label}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      className="focus-ring group relative flex cursor-col-resize touch-none items-center justify-center"
    >
      <span
        aria-hidden
        className={cn(
          "h-full w-px bg-line transition-colors duration-150 group-hover:bg-accent-ring group-focus-visible:bg-accent",
          dragging && "bg-accent",
        )}
      />
      <span
        aria-hidden
        className={cn(
          "absolute top-1/2 h-8 w-[3px] -translate-y-1/2 rounded-full bg-transparent transition-colors duration-150 group-hover:bg-accent group-focus-visible:bg-accent",
          dragging && "bg-accent",
        )}
      />
    </div>
  );
}
