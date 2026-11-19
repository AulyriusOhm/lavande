import { useEffect, useRef } from "react";

type Layer = { run: () => void };

const stack: Layer[] = [];

export function useBackLayer(active: boolean, run: () => void) {
  const current = useRef(run);
  current.current = run;

  useEffect(() => {
    if (!active) return;
    const layer: Layer = { run: () => current.current() };
    stack.push(layer);
    return () => {
      const index = stack.indexOf(layer);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [active]);
}

export function closeTopBackLayer(): boolean {
  const layer = stack[stack.length - 1];
  if (!layer) return false;
  layer.run();
  return true;
}

const noop = () => {};

export function onAndroidBack(handle: () => void): () => void {
  if (!("__TAURI_INTERNALS__" in window)) return noop;

  let cancelled = false;
  let unregister: (() => void) | null = null;

  void import("@tauri-apps/api/app")
    .then(({ onBackButtonPress }) => onBackButtonPress(handle))
    .then((listener) => {
      if (cancelled) {
        void listener.unregister();
        return;
      }
      unregister = () => void listener.unregister();
    })
    .catch(() => {});

  return () => {
    cancelled = true;
    unregister?.();
  };
}
