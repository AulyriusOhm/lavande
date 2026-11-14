import { MotionConfig } from "motion/react";

import { DemoSection } from "@/components/demo-section";
import { LightboxProvider } from "@/components/ui/lightbox";
import { Download } from "@/components/download";
import { Features } from "@/components/features";
import { Flow } from "@/components/flow";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { Hero } from "@/components/hero";
import { Manifesto } from "@/components/manifesto";
import { MobileSection } from "@/components/mobile-section";
import { Security } from "@/components/security";
import { useTheme } from "@/hooks/useTheme";

export function App() {
  const { theme, toggle } = useTheme();

  return (
    <MotionConfig reducedMotion="user">
      <LightboxProvider>
      <a
        href="#contenu"
        className="sr-only rounded-b-xl bg-accent-strong px-4 py-2.5 text-sm font-bold text-white no-underline focus:not-sr-only focus:fixed focus:top-0 focus:left-1/2 focus:z-[70] focus:-translate-x-1/2"
      >
        Aller au contenu
      </a>
      <Header theme={theme} onToggleTheme={toggle} />
      <main id="contenu">
        <span id="top" aria-hidden="true" />
        <Hero theme={theme} />
        <Features />
        <Flow />
        <MobileSection />
        <Manifesto />
        <DemoSection theme={theme} />
        <Download />
        <Security />
      </main>
      <Footer />
      </LightboxProvider>
    </MotionConfig>
  );
}
