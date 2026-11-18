import { describe, expect, it } from "vitest";
import { decodeModifiedUtf7 } from "@/lib/utf7";

describe("decodeModifiedUtf7", () => {
  it("décode une paire de surrogates en emoji", () => {
    expect(decodeModifiedUtf7("&2Dzf5g-")).toBe("🏦");
    expect(decodeModifiedUtf7("&2Dzf5g- Pro")).toBe("🏦 Pro");
  });

  it("rend « &- » littéral", () => {
    expect(decodeModifiedUtf7("&-")).toBe("&");
    expect(decodeModifiedUtf7("Tom &- Jerry")).toBe("Tom & Jerry");
  });

  it("laisse l'ASCII intact", () => {
    expect(decodeModifiedUtf7("INBOX")).toBe("INBOX");
    expect(decodeModifiedUtf7("[Gmail]/Sent Mail")).toBe("[Gmail]/Sent Mail");
    expect(decodeModifiedUtf7("")).toBe("");
  });

  it("mélange texte et séquences accentuées", () => {
    expect(decodeModifiedUtf7("Envoy&AOk-s")).toBe("Envoyés");
    expect(decodeModifiedUtf7("Re&AOc-us &ANw-")).toBe("Reçus Ü");
  });

  it("lit la virgule comme un slash base64", () => {
    expect(decodeModifiedUtf7("&b,8-")).toBe("\u6fff");
  });

  it("garde telle quelle une séquence illisible", () => {
    expect(decodeModifiedUtf7("&2Dzf5g")).toBe("&2Dzf5g");
    expect(decodeModifiedUtf7("&2Dzf5-")).toBe("&2Dzf5-");
    expect(decodeModifiedUtf7("&!!-")).toBe("&!!-");
    expect(decodeModifiedUtf7("&2AA-")).toBe("&2AA-");
    expect(decodeModifiedUtf7("a&2Dzf5g- &!!- fin")).toBe("a🏦 &!!- fin");
  });
});
