/**
 * Magic UI — MIT License — https://github.com/magicuidesign/magicui
 * Source : apps/www/registry/magicui/aurora-text.tsx
 * Adapté : `bg-size-[200%_auto]` remplacé par un style inline, couleurs de la marque par défaut.
 */
"use client";

import React, { memo } from "react";

interface AuroraTextProps {
  children: React.ReactNode;
  className?: string;
  colors?: string[];
  speed?: number;
}

export const AuroraText = memo(
  ({
    children,
    className = "",
    colors = ["#8b7cf6", "#bda9ff", "#6247dd", "#38bdf8"],
    speed = 1,
  }: AuroraTextProps) => {
    const gradientStyle: React.CSSProperties = {
      backgroundImage: `linear-gradient(135deg, ${colors.join(", ")}, ${colors[0]})`,
      backgroundSize: "200% auto",
      WebkitBackgroundClip: "text",
      backgroundClip: "text",
      WebkitTextFillColor: "transparent",
      color: "transparent",
      animationDuration: `${10 / speed}s`,
    };

    return (
      <span className={`relative inline-block ${className}`}>
        <span className="sr-only">{children}</span>
        <span className="animate-aurora relative bg-clip-text text-transparent" style={gradientStyle} aria-hidden="true">
          {children}
        </span>
      </span>
    );
  },
);

AuroraText.displayName = "AuroraText";
