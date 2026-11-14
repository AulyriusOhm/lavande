/**
 * Magic UI — MIT License — https://github.com/magicuidesign/magicui
 * Source : apps/www/registry/magicui/shimmer-button.tsx
 * Adapté : `href` pour rendre un lien, styles exotiques (`@container-[size]`, `inset-(--cut)`)
 * en styles inline, `cn` local.
 */
import React, { forwardRef, type ComponentPropsWithoutRef, type CSSProperties, type ElementType } from "react";

import { cn } from "@/lib/utils";

export interface ShimmerButtonProps extends ComponentPropsWithoutRef<"button"> {
  shimmerColor?: string;
  shimmerSize?: string;
  borderRadius?: string;
  shimmerDuration?: string;
  background?: string;
  className?: string;
  children?: React.ReactNode;
  href?: string;
}

export const ShimmerButton = forwardRef<HTMLElement, ShimmerButtonProps>(
  (
    {
      shimmerColor = "#ffffff",
      shimmerSize = "0.05em",
      shimmerDuration = "3s",
      borderRadius = "100px",
      background = "rgba(0, 0, 0, 1)",
      className,
      children,
      href,
      ...props
    },
    ref,
  ) => {
    const Comp = (href ? "a" : "button") as ElementType;

    return (
      <Comp
        ref={ref}
        href={href}
        style={
          {
            "--spread": "90deg",
            "--shimmer-color": shimmerColor,
            "--radius": borderRadius,
            "--speed": shimmerDuration,
            "--cut": shimmerSize,
            "--bg": background,
          } as CSSProperties
        }
        className={cn(
          "group relative z-0 flex cursor-pointer items-center justify-center overflow-hidden rounded-[var(--radius)] border border-white/15 px-6 py-3 whitespace-nowrap text-white [background:var(--bg)]",
          "transform-gpu transition-transform duration-300 ease-in-out hover:-translate-y-0.5 active:translate-y-px",
          "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent",
          className,
        )}
        {...props}
      >
        <div className="-z-30 absolute inset-0 overflow-visible blur-[2px]" style={{ containerType: "size" }}>
          <div className="animate-shimmer-slide absolute inset-0 aspect-square h-full rounded-none">
            <div
              className="animate-spin-around absolute -inset-full w-auto rotate-0"
              style={{
                background:
                  "conic-gradient(from calc(270deg - (var(--spread) * 0.5)), transparent 0, var(--shimmer-color) var(--spread), transparent var(--spread))",
              }}
            />
          </div>
        </div>

        <span className="relative z-10 flex items-center justify-center gap-2">{children}</span>

        <div
          className={cn(
            "absolute inset-0 size-full",
            "rounded-[var(--radius)] px-4 py-1.5",
            "shadow-[inset_0_-8px_10px_#ffffff1f]",
            "transform-gpu transition-all duration-300 ease-in-out",
            "group-hover:shadow-[inset_0_-6px_10px_#ffffff3f]",
            "group-active:shadow-[inset_0_-10px_10px_#ffffff3f]",
          )}
        />

        <div
          className="absolute -z-20 rounded-[var(--radius)] [background:var(--bg)]"
          style={{ inset: "var(--cut)" }}
        />
      </Comp>
    );
  },
);

ShimmerButton.displayName = "ShimmerButton";
