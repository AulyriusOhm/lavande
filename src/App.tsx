import { lazy, Suspense } from "react";
import { MotionConfig } from "motion/react";
import { BatteryFull, Signal, Wifi } from "lucide-react";
import { ThemeProvider, useTheme } from "@/lib/theme";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { TotpPopup } from "@/components/totp-popup";
import { ReauthPopup } from "@/components/reauth-popup";
import { DotPattern, MeshGlow } from "@/components/ui/backdrops";
import { shellLayout } from "@/lib/native";
import { UpdatePopup } from "@/components/update-popup";
import { useExternalLinks } from "@/lib/open-external";

const DesktopShell = lazy(() =>
  import("@/desktop/desktop-shell").then((module) => ({ default: module.DesktopApp })),
);

const PhoneApp = lazy(() =>
  import("@/mobile/phone-app").then((module) => ({ default: module.PhoneApp })),
);

function ReauthHost() {
  const { reauthAlert, dismissReauthAlert, reconnectAccount } = useMailStore();
  return (
    <ReauthPopup
      alert={reauthAlert}
      onDismiss={dismissReauthAlert}
      onReconnect={(accountId) => {
        if (!reauthAlert) return;
        void reconnectAccount({ id: accountId, label: reauthAlert.label });
      }}
    />
  );
}

function TotpHost() {
  const { totpAlert, dismissTotpAlert, mails, openMessage, mailAction, inboxActive } = useMailStore();
  if (inboxActive) return null;
  return (
    <TotpPopup
      alert={totpAlert}
      onDismiss={dismissTotpAlert}
      onOpenMail={(mailId) => {
        const target = mails.find((entry) => entry.id === mailId);
        openMessage(target ?? mailId);
      }}
      onMarkRead={(mailId) => {
        const target = mails.find((entry) => entry.id === mailId);
        if (target?.unread) mailAction("read", target);
      }}
    />
  );
}

export default function App() {
  const layout = shellLayout();

  useExternalLinks();

  return (
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <PrefsProvider>
          <PlanningProvider>
            <MailStoreProvider>
              <Suspense fallback={<div className="h-full w-full bg-canvas" />}>
                {layout === "desktop" ? (
                  <DesktopShell />
                ) : layout === "native" ? (
                  <NativeShell />
                ) : (
                  <Stage />
                )}
              </Suspense>
              <ReauthHost />
              <TotpHost />
              <UpdatePopup />
            </MailStoreProvider>
          </PlanningProvider>
        </PrefsProvider>
      </ThemeProvider>
    </MotionConfig>
  );
}

function NativeShell() {
  return (
    <div className="relative h-full w-full overflow-hidden bg-canvas native-shell">
      <div className="native-sheet relative h-full w-full overflow-hidden">
        <Suspense fallback={<div className="h-full w-full bg-canvas" />}>
          <PhoneApp native />
        </Suspense>
      </div>
    </div>
  );
}

function Stage() {
  const { brand } = useTheme();

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-3 overflow-hidden bg-canvas">
      <div className="absolute inset-0 hidden sm:block">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,var(--accent-soft),transparent_60%)]" />
        <MeshGlow />
        <DotPattern className="text-accent opacity-[0.07]" size={22} radius={1} />
      </div>

      <div className="relative h-full w-full overflow-hidden bg-canvas sm:h-[838px] sm:max-h-[84vh] sm:w-[392px] sm:rounded-[46px] sm:border-[9px] sm:border-[#191322] sm:shadow-[0_40px_100px_-30px_var(--accent),0_0_0_1px_rgba(0,0,0,0.05)]">
        <StatusBar />
        <Suspense fallback={<div className="h-full w-full bg-canvas" />}>
          <PhoneApp />
        </Suspense>
      </div>

      {import.meta.env.VITE_DISTRIBUTION === "1" ? null : (
        <p className="pointer-events-none hidden shrink-0 text-[11.5px] font-semibold tracking-wide text-ink-muted sm:block">
          {brand} · maquette mobile · glisse horizontalement
        </p>
      )}
    </div>
  );
}

function StatusBar() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-50 hidden items-center justify-between px-7 pt-2.5 text-ink sm:flex">
      <span className="text-[11.5px] font-bold tracking-tight">09:41</span>
      <div className="flex items-center gap-1.5">
        <Signal className="size-3.5" strokeWidth={2.6} />
        <Wifi className="size-3.5" strokeWidth={2.6} />
        <BatteryFull className="size-4" strokeWidth={2.2} />
      </div>
    </div>
  );
}
