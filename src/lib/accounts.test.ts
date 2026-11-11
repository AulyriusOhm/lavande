import { describe, expect, it } from "vitest";
import { ACCOUNTS, sourceAccountLabel } from "@/lib/accounts";

describe("sourceAccountLabel", () => {
  it("rend le libellé du compte réel", () => {
    expect(sourceAccountLabel(ACCOUNTS, "pro")).toBe("Studio");
    expect(sourceAccountLabel([...ACCOUNTS, { ...ACCOUNTS[0], id: "alpha", label: "Alpha" }], "alpha")).toBe("Alpha");
  });

  it("retombe sur l'identifiant inconnu puis sur « Boîte »", () => {
    expect(sourceAccountLabel(ACCOUNTS, "inconnu")).toBe("inconnu");
    expect(sourceAccountLabel(ACCOUNTS, "")).toBe("Boîte");
    expect(sourceAccountLabel(ACCOUNTS, undefined)).toBe("Boîte");
  });
});
