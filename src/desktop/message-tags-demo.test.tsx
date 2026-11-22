import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Démo vitrine : le drapeau est posé avant l'évaluation des modules.
vi.hoisted(() => {
  vi.stubEnv("VITE_MAIL_BACKEND", "demo");
  vi.stubEnv("VITE_DEMO_READONLY", "1");
});

import { MessageTags } from "@/components/message-tags";

beforeEach(() => {
  window.localStorage.clear();
});

describe("lecteur · étiquettes Zimbra en démo", () => {
  it("n'affiche ni pastille ni action, et n'appelle rien", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<MessageTags source={{ accountId: "perso", folderPath: "INBOX", uid: 12 }} />);

    expect(screen.queryByTestId("message-tags")).toBeNull();
    expect(screen.queryByRole("button", { name: "Étiqueter le message" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
