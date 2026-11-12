import { describe, expect, it } from "vitest";
import { ACCOUNTS } from "@/lib/accounts";
import { accountLabelInk, contrastRatio } from "@/lib/theme";

const EXTRA = ["#34d399", "#fbbf24", "#c084fc", "#64748b", "#000000", "#ffffff", "#f4f1fa"];
const COLORS = [...ACCOUNTS.map((account) => account.color), ...EXTRA];

const SURFACES = {
  clair: ["#fbfaff", "#ffffff", "#f6f3fd"],
  sombre: ["#0e0c13", "#16131f", "#1d1929"],
};

function tintOver(colour: string, surface: string) {
  const channels = (hex: string) =>
    [1, 3, 5].map((offset) => parseInt(hex.replace("#", "").slice(offset - 1, offset + 1), 16));
  const foreground = channels(colour);
  const under = channels(surface);
  return `#${foreground
    .map((value, index) => Math.round(value * 0.16 + under[index]! * 0.84).toString(16).padStart(2, "0"))
    .join("")}`;
}

describe("encre de l'étiquette de compte", () => {
  for (const [theme, surfaces] of Object.entries(SURFACES)) {
    for (const colour of COLORS) {
      it(`tient 4,5:1 en ${theme} pour ${colour}`, () => {
        const ink = accountLabelInk(colour, theme === "sombre");
        expect(ink).toMatch(/^#[0-9a-f]{6}$/);
        for (const surface of surfaces) {
          expect(contrastRatio(ink, tintOver(colour, surface))).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }

  it("n'est jamais l'ancienne encre figée", () => {
    expect(accountLabelInk("#8b7cf6", false)).not.toBe("#241b3a");
  });
});
