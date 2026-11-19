import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { mailApi } from "@/lib/api";
import { openExternal } from "@/lib/open-external";

/**
 * Session GitHub Copilot telle que le démon l'expose : le front ne voit qu'un
 * drapeau et un login, jamais un jeton.
 */
export type CopilotState = { connected: boolean; login: string | null };

const DISCONNECTED: CopilotState = { connected: false, login: null };

export const NOT_CONNECTED =
  "Copilot n'est pas connecté · connecte ton compte GitHub dans les réglages (section IA)";
const GITHUB_MODELS = ["gpt-4o", "gpt-4.1", "claude-sonnet-4", "o3-mini"];

/** Client ID GitHub de l'application Copilot publiée ; vide côté réglages = cette valeur. */
export const DEFAULT_COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

let state: CopilotState = DISCONNECTED;
const listeners = new Set<() => void>();

export function copilotConnected(): boolean {
  return state.connected;
}

export function copilotState(): CopilotState {
  return state;
}

export function subscribeCopilot(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(next: CopilotState): CopilotState {
  if (next.connected === state.connected && next.login === state.login) return state;
  state = next;
  for (const listener of listeners) listener();
  return state;
}

/** Relit la session côté démon (démarrage, fin du device flow, déconnexion). */
export async function refreshCopilotSession(): Promise<CopilotState> {
  const session = await mailApi.copilotSession();
  return publish({ connected: session.connected, login: session.login });
}

/** Modèles Copilot connus : la saisie libre reste possible. */
export function copilotModels(): string[] {
  return [...GITHUB_MODELS];
}

export type CopilotFlow = {
  connected: boolean;
  login: string | null;
  /** Code à recopier sur la page GitHub pendant le device flow. */
  userCode: string | null;
  verificationUri: string | null;
  busy: boolean;
  error: string | null;
  connect: () => void;
  disconnect: () => void;
};

const reason = (failure: unknown) => (failure instanceof Error ? failure.message : "échec inconnu");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Device flow GitHub Copilot piloté par le démon : le front affiche le code,
 * ouvre la page de vérification et suit l'intervalle rendu par chaque statut
 * (`slow_down` est déjà absorbé côté démon).
 */
export function useCopilotSession(clientId?: string): CopilotFlow {
  const session = useSyncExternalStore(subscribeCopilot, copilotState);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);

  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );

  const connect = useCallback(() => {
    const id = ++run.current;
    const current = () => run.current === id;
    void (async () => {
      setError(null);
      setBusy(true);
      try {
        const started = await mailApi.copilotStart(clientId);
        if (!current()) return;
        setUserCode(started.user_code);
        setVerificationUri(started.verification_uri);
        openExternal(started.verification_uri);
        const deadline = Date.now() + started.expires_in * 1000;
        let interval = started.interval;
        for (;;) {
          await sleep(Math.max(1, interval) * 1000);
          if (!current()) return;
          if (Date.now() > deadline) throw new Error("Délai de connexion GitHub dépassé · relance la connexion");
          const status = await mailApi.copilotStatus(started.session);
          if (!current()) return;
          if (status.interval > 0) interval = status.interval;
          if (status.status === "pending") continue;
          if (status.status === "done") {
            await refreshCopilotSession().catch(() => publish({ connected: true, login: status.login ?? null }));
            if (!current()) return;
            setUserCode(null);
            setVerificationUri(null);
            return;
          }
          if (status.status === "expired") throw new Error("Code expiré · relance la connexion GitHub");
          throw new Error(status.error?.trim() || "Connexion GitHub refusée");
        }
      } catch (failure) {
        if (!current()) return;
        setUserCode(null);
        setVerificationUri(null);
        setError(reason(failure));
      } finally {
        if (current()) setBusy(false);
      }
    })();
  }, [clientId]);

  const disconnect = useCallback(() => {
    run.current += 1;
    setError(null);
    setBusy(true);
    void mailApi
      .copilotLogout()
      .then(() => publish(DISCONNECTED))
      .catch((failure: unknown) => setError(reason(failure)))
      .finally(() => setBusy(false));
  }, []);

  return { ...session, userCode, verificationUri, busy, error, connect, disconnect };
}
