import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Démo vitrine : le drapeau est posé avant l'évaluation des modules.
vi.hoisted(() => {
  vi.stubEnv("VITE_MAIL_BACKEND", "demo");
  vi.stubEnv("VITE_DEMO_READONLY", "1");
});

import { GuestFreeBusy } from "@/components/guest-free-busy";

beforeEach(() => {
  window.localStorage.clear();
});

describe("agenda · disponibilités en démo", () => {
  it("ne rend rien et n'appelle personne", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <GuestFreeBusy accountId="perso" attendees={["camille@exemple.tld"]} date="2026-03-15" start="14:00" end="15:00" />,
    );

    expect(screen.queryByTestId("guest-free-busy")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
