import { useCallback, useEffect, useRef, useState } from "react";
import { AppWindow } from "lucide-react";
import { useMailStore } from "@/lib/store";
import { ComposeScreen } from "@/screens/compose-screen";
import { DIconButton } from "@/desktop/ui";
import { loadPersistedCompose, openComposeBus } from "@/lib/compose-bus";
import type { ComposeBus, ComposeState } from "@/lib/compose-bus";
import { isTauriShell } from "@/lib/open-external";
import { mailApi, errorText } from "@/lib/api";
import { sendInputOf } from "@/lib/mail-backend";
import type { ComposeDraft } from "@/lib/draft";

export function DesktopComposePage() {
  const { mode, phase } = useMailStore();
  const [state, setState] = useState<ComposeState>(() => {
    const persisted = loadPersistedCompose();
    return {
      draft: persisted?.draft ?? null,
      title: persisted?.title ?? "Nouveau message",
      detached: true,
    };
  });
  const [orphan, setOrphan] = useState(() => typeof BroadcastChannel === "undefined");
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const busRef = useRef<ComposeBus | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const closingRef = useRef(false);

  const closeSelf = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    busRef.current?.post({ kind: "closed" });
    if (isTauriShell()) {
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().close())
        .catch(() => {});
    } else {
      window.close();
    }
  }, []);

  useEffect(() => {
    let helloTimer = 0;
    const bus = openComposeBus((message) => {
      switch (message.kind) {
        case "state": {
          window.clearTimeout(helloTimer);
          if (!message.state.draft) {
            closeSelf();
            return;
          }
          if (JSON.stringify(message.state) !== JSON.stringify(stateRef.current)) {
            setState(message.state);
          }
          break;
        }
        case "sent":
          setSent(true);
          window.setTimeout(closeSelf, 700);
          break;
        case "send-failed":
          setSendError(message.message);
          break;
        case "focus":
          if (isTauriShell()) {
            void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
              getCurrentWindow().setFocus(),
            );
          } else {
            window.focus();
          }
          break;
      }
    });
    busRef.current = bus;
    bus?.post({ kind: "hello" });
    if (bus) helloTimer = window.setTimeout(() => setOrphan(true), 1500);

    const onPageHide = () => bus?.post({ kind: "closed" });
    window.addEventListener("pagehide", onPageHide);
    let unlisten: (() => void) | undefined;
    if (isTauriShell()) {
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) =>
          getCurrentWindow().onCloseRequested(() => {
            bus?.post({ kind: "closed" });
          }),
        )
        .then((fn) => {
          unlisten = fn;
        });
    }
    return () => {
      window.clearTimeout(helloTimer);
      window.removeEventListener("pagehide", onPageHide);
      unlisten?.();
      bus?.close();
      busRef.current = null;
    };
  }, [closeSelf]);

  useEffect(() => {
    const title = `${state.draft?.subject.trim() || state.title} — Lavande`;
    document.title = title;
    if (isTauriShell()) {
      void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
        getCurrentWindow().setTitle(title),
      );
    }
  }, [state.title, state.draft?.subject]);

  const onDraftChange = (draft: ComposeDraft) => {
    setState((current) => ({ ...current, draft }));
    setSendError(null);
    busRef.current?.post({ kind: "edit", draft });
  };

  const onSend = (draft: ComposeDraft) => {
    setSendError(null);
    if (orphan || !busRef.current) {
      if (mode === "api") {
        mailApi
          .send(draft.account, sendInputOf(draft))
          .then(() => {
            setSent(true);
            window.setTimeout(closeSelf, 700);
          })
          .catch((error: unknown) => setSendError(`Envoi impossible · ${errorText(error)}`));
      } else {
        closeSelf();
      }
      return;
    }
    busRef.current.post({ kind: "send", draft });
  };

  const dock = () => {
    busRef.current?.post({ kind: "dock" });
    closeSelf();
  };

  if (!state.draft) {
    return (
      <div className="grid h-full w-full place-items-center bg-canvas text-[13px] font-semibold text-ink-muted">
        Brouillon fermé.
      </div>
    );
  }

  if (mode === "api" && phase === "loading") {
    return (
      <div className="grid h-full w-full place-items-center bg-canvas text-[13px] font-semibold text-ink-muted">
        Chargement du compte…
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-canvas" data-testid="compose-page">
      <ComposeScreen
        title={state.title}
        draft={state.draft}
        onDraftChange={onDraftChange}
        onSend={onSend}
        onClose={closeSelf}
        sent={sent}
        sendError={sendError}
        headerActions={
          <DIconButton label="Rattacher à la fenêtre principale" onClick={dock} className="size-8">
            <AppWindow className="size-4" />
          </DIconButton>
        }
      />
    </div>
  );
}
