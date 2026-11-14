import type { ReactNode } from "react";

import { BorderBeam } from "@/components/magicui/border-beam";
import { cn } from "@/lib/utils";

interface PhoneShellProps {
  children: ReactNode;
  className?: string;
  beam?: boolean;
  screenClassName?: string;
}

export function PhoneShell({ children, className, beam = false, screenClassName }: PhoneShellProps) {
  return (
    <div
      className={cn(
        "relative rounded-[2.6rem] border border-line-strong bg-[linear-gradient(160deg,color-mix(in_oklab,var(--surface-2)_92%,var(--accent))_0%,var(--surface)_46%,color-mix(in_oklab,var(--canvas)_86%,var(--accent))_100%)] px-[0.4rem] pt-[0.8rem] pb-[0.4rem]",
        "shadow-[0_34px_70px_-34px_rgba(10,8,16,0.85),inset_0_1px_0_rgba(255,255,255,0.08)]",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="absolute top-[0.24rem] left-1/2 z-20 h-[0.4rem] w-[3.1rem] -translate-x-1/2 rounded-full bg-[#08060c]/85"
      />
      <div className={cn("relative overflow-hidden rounded-[2.05rem] bg-canvas", screenClassName)}>
        {children}
      </div>
      {beam ? (
        <BorderBeam
          size={110}
          duration={9}
          borderWidth={1.5}
          colorFrom="var(--accent-bright)"
          colorTo="var(--accent-deep)"
        />
      ) : null}
    </div>
  );
}
