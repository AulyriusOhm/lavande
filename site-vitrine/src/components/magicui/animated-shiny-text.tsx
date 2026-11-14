/**
 * Magic UI — MIT License — https://github.com/magicuidesign/magicui
 * Source : apps/www/registry/magicui/animated-shiny-text.tsx
 * Adapté : imports `cn` local, dégradé en styles inline (utilitaires `bg-size-*` absents de Tailwind v4).
 */
import { type ComponentPropsWithoutRef, type CSSProperties, type FC } from "react";

import { cn } from "@/lib/utils";

export interface AnimatedShinyTextProps extends ComponentPropsWithoutRef<"span"> {
  shimmerWidth?: number;
}

export const AnimatedShinyText: FC<AnimatedShinyTextProps> = ({
  children,
  className,
  shimmerWidth = 100,
  ...props
}) => {
  return (
    <span className={cn("relative inline-block", className)} {...props}>
      <span className="relative z-10">{children}</span>
      <span
        aria-hidden="true"
        className="animate-shiny-text absolute inset-0 z-20 bg-clip-text text-transparent"
        style={
          {
            "--shiny-width": `${shimmerWidth}px`,
            backgroundImage:
              "linear-gradient(to right, transparent 0%, rgba(255,255,255,0.85) 50%, transparent 100%)",
            backgroundSize: `${shimmerWidth}px 100%`,
            backgroundRepeat: "no-repeat",
          } as CSSProperties
        }
      >
        {children}
      </span>
    </span>
  );
};
