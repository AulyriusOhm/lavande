import { useEffect, useRef } from "react";

type Layer = { run: () => void };

const stack: Layer[] = [];

export function useEscapeLayer(active: boolean, run: () => void) {
  const current = useRef(run);
  current.current = run;

  useEffect(() => {
    if (!active) return;
    const layer: Layer = { run: () => current.current() };
    stack.push(layer);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || stack[stack.length - 1] !== layer) return;
      event.preventDefault();
      layer.run();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const index = stack.indexOf(layer);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [active]);
}
