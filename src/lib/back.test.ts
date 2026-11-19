import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { closeTopBackLayer, useBackLayer } from "@/lib/back";

describe("pile du bouton retour", () => {
  it("dépile la dernière couche ouverte, puis la précédente", () => {
    const calls: string[] = [];
    const { rerender, unmount } = renderHook(
      ({ open }: { open: boolean }) => {
        useBackLayer(true, () => calls.push("écran"));
        useBackLayer(open, () => calls.push("modale"));
      },
      { initialProps: { open: true } },
    );

    expect(closeTopBackLayer()).toBe(true);
    expect(calls).toEqual(["modale"]);

    rerender({ open: false });
    expect(closeTopBackLayer()).toBe(true);
    expect(calls).toEqual(["modale", "écran"]);

    unmount();
    expect(closeTopBackLayer()).toBe(false);
  });
});
