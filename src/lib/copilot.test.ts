import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  copilotConnected,
  copilotModels,
  copilotState,
  refreshCopilotSession,
  subscribeCopilot,
  useCopilotSession,
} from "@/lib/copilot";

const response = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

const START = {
  session: "s-1",
  verification_uri: "https://github.com/login/device",
  user_code: "ABCD-1234",
  interval: 1,
  expires_in: 900,
};

type Route = (url: string, init?: RequestInit) => Response;

function stubFetch(route: Route) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => route(String(input), init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const api = (segments: { start?: () => Response; statuses?: (() => Response)[]; logout?: () => Response }) => {
  let polled = 0;
  return (url: string, init?: RequestInit) => {
    if (url.endsWith("/ai/copilot/start")) return (segments.start ?? (() => response(START, 201)))();
    if (url.includes("/ai/copilot/status")) {
      const list = segments.statuses ?? [() => response({ status: "done", interval: 1 })];
      const next = list[Math.min(polled, list.length - 1)] ?? list[list.length - 1];
      polled += 1;
      return next();
    }
    if (url.endsWith("/ai/copilot/logout") && init?.method === "POST")
      return (segments.logout ?? (() => response({ ok: true })))();
    if (url.endsWith("/ai/copilot/session")) {
      return response({ connected: true, login: "lavande-fan" });
    }
    return response({});
  };
};

beforeEach(async () => {
  vi.stubGlobal("open", vi.fn());
  stubFetch(() => response({ connected: false, login: null }));
  await refreshCopilotSession();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("refreshCopilotSession", () => {
  it("publie la session du démon et prévient les abonnés", async () => {
    stubFetch(api({}));

    const seen = vi.fn();
    const off = subscribeCopilot(seen);
    await refreshCopilotSession();
    off();

    expect(copilotConnected()).toBe(true);
    expect(copilotState()).toEqual({ connected: true, login: "lavande-fan" });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("ne notifie pas quand la session ne change pas", async () => {
    stubFetch(api({}));
    await refreshCopilotSession();

    const seen = vi.fn();
    const off = subscribeCopilot(seen);
    await refreshCopilotSession();
    off();

    expect(seen).not.toHaveBeenCalled();
  });
});

describe("copilotModels", () => {
  it("propose les modèles Copilot connus, la saisie libre restant possible", () => {
    expect(copilotModels()).toEqual(["gpt-4o", "gpt-4.1", "claude-sonnet-4", "o3-mini"]);
  });
});

describe("useCopilotSession", () => {
  it("affiche le code, ouvre la page GitHub et suit l'intervalle rendu", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(
      api({
        statuses: [
          () => response({ status: "pending", interval: 2 }),
          () => response({ status: "pending", interval: 2 }),
          () => response({ status: "done", interval: 2, login: "lavande-fan" }),
        ],
      }),
    );
    const { result } = renderHook(() => useCopilotSession());

    await act(async () => {
      result.current.connect();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.userCode).toBe("ABCD-1234");
    expect(result.current.verificationUri).toBe("https://github.com/login/device");
    expect(window.open).toHaveBeenCalledWith("https://github.com/login/device", "_blank", "noopener,noreferrer");

    const polls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/ai/copilot/status")).length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(polls()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(polls()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(polls()).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });

    expect(result.current.connected).toBe(true);
    expect(result.current.login).toBe("lavande-fan");
    expect(result.current.userCode).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(polls()).toBe(3);
    const start = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/ai/copilot/start"));
    expect(JSON.parse(String((start?.[1] as RequestInit).body))).toEqual({});
  });

  it("transmet le client_id personnalisé quand il est renseigné", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(api({}));
    const { result } = renderHook(() => useCopilotSession("  Iv1.maison  "));

    await act(async () => {
      result.current.connect();
      await vi.advanceTimersByTimeAsync(1_100);
    });

    const start = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/ai/copilot/start"));
    expect(start?.[0]).toBe("/api/ai/copilot/start");
    expect(start?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String((start?.[1] as RequestInit).body))).toEqual({
      client_id: "Iv1.maison",
    });
  });

  it("explique un code expiré", async () => {
    vi.useFakeTimers();
    stubFetch(api({ statuses: [() => response({ status: "expired", interval: 1 })] }));
    const { result } = renderHook(() => useCopilotSession());

    await act(async () => {
      result.current.connect();
      await vi.advanceTimersByTimeAsync(1_100);
    });

    expect(result.current.error).toBe("Code expiré · relance la connexion GitHub");
    expect(result.current.userCode).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(result.current.connected).toBe(false);
  });

  it("relaie l'erreur du démon quand la connexion échoue", async () => {
    vi.useFakeTimers();
    stubFetch(
      api({ statuses: [() => response({ status: "failed", interval: 1, error: "accès refusé" })] }),
    );
    const { result } = renderHook(() => useCopilotSession());

    await act(async () => {
      result.current.connect();
      await vi.advanceTimersByTimeAsync(1_100);
    });

    expect(result.current.error).toBe("accès refusé");
  });

  it("déconnecte le compte GitHub", async () => {
    const fetchMock = stubFetch(api({}));
    await refreshCopilotSession();
    const { result } = renderHook(() => useCopilotSession());
    expect(result.current.connected).toBe(true);

    act(() => {
      result.current.disconnect();
    });
    await waitFor(() => expect(result.current.connected).toBe(false));

    expect(result.current.login).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url).endsWith("/ai/copilot/logout") && init?.method === "POST",
      ),
    ).toBe(true);
  });
});
