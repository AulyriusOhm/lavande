import { describe, expect, it } from "vitest";
import { compareHlc, createClock, decodeHlc, encodeHlc, type ClockState } from "./clock";

function hlc(wallMs: number, counter: number, device = "abc123"): string {
  return encodeHlc({ wallMs, counter }, device);
}

function randomDevice(): string {
  return Math.random().toString(36).slice(2, 8);
}

describe("encodeHlc", () => {
  it("produit un HLC triable sur 28 caractères", () => {
    expect(encodeHlc({ wallMs: 1700000000000, counter: 3 }, "abc123")).toBe("001700000000000-00003-abc123");
  });

  it("ne garde que six caractères alphanumériques du device", () => {
    expect(encodeHlc({ wallMs: 1, counter: 1 }, "ab-cd_ef1234")).toBe("000000000000001-00001-abcdef");
  });

  it("refuse une horloge hors bornes", () => {
    expect(() => encodeHlc({ wallMs: 10 ** 15, counter: 0 }, "abc")).toThrow();
    expect(() => encodeHlc({ wallMs: 0, counter: 100000 }, "abc")).toThrow();
    expect(() => encodeHlc({ wallMs: 1.5, counter: 0 }, "abc")).toThrow();
  });
});

describe("decodeHlc", () => {
  it("inverse encodeHlc", () => {
    for (let i = 0; i < 50; i++) {
      const state: ClockState = {
        wallMs: Math.floor(Math.random() * 10 ** 15),
        counter: Math.floor(Math.random() * 100000),
      };
      const device = randomDevice();
      const decoded = decodeHlc(encodeHlc(state, device));
      expect(decoded.state).toEqual(state);
      expect(decoded.device).toBe(device);
    }
  });

  it("lève sur un format invalide", () => {
    expect(() => decodeHlc("nope")).toThrow();
    expect(() => decodeHlc("001700000000000-0003-abc123")).toThrow();
    expect(() => decodeHlc("001700000000000-00003-abc1234")).toThrow();
  });
});

describe("compareHlc", () => {
  it("renvoie 0 pour deux HLC identiques", () => {
    expect(compareHlc(hlc(5, 2), hlc(5, 2))).toBe(0);
  });

  it("ordonne par wallMs puis counter puis device", () => {
    expect(compareHlc(hlc(1, 9), hlc(2, 0))).toBe(-1);
    expect(compareHlc(hlc(2, 0), hlc(1, 9))).toBe(1);
    expect(compareHlc(hlc(2, 1), hlc(2, 2))).toBe(-1);
    expect(compareHlc(hlc(2, 2, "aaa111"), hlc(2, 2, "zzz999"))).toBe(-1);
    expect(compareHlc(hlc(2, 2, "zzz999"), hlc(2, 2, "aaa111"))).toBe(1);
  });
});

describe("createClock", () => {
  it("reste strictement monotone avec une horloge murale figée", () => {
    const clock = createClock("dev001", () => 1700000000000);
    const ticks = Array.from({ length: 5 }, () => clock.tick());
    for (let i = 1; i < ticks.length; i++) expect(compareHlc(ticks[i], ticks[i - 1])).toBe(1);
    expect(decodeHlc(ticks.at(-1) as string).state).toEqual({ wallMs: 1700000000000, counter: 4 });
  });

  it("résiste au recul de l'horloge murale", () => {
    let wall = 2000;
    const clock = createClock("dev001", () => wall);
    const first = clock.tick();
    wall = 1000;
    const second = clock.tick();
    wall = 1500;
    const third = clock.tick();
    expect(compareHlc(second, first)).toBe(1);
    expect(compareHlc(third, second)).toBe(1);
    expect(decodeHlc(second).state).toEqual({ wallMs: 2000, counter: 1 });
    expect(clock.last).toEqual({ wallMs: 2000, counter: 2 });
  });

  it("avance au-delà d'un HLC reçu", () => {
    const clock = createClock("dev001", () => 1000);
    const remote = encodeHlc({ wallMs: 5000, counter: 7 }, "fff999");
    clock.receive(remote);
    expect(compareHlc(clock.tick(), remote)).toBe(1);
  });

  it("conserve le maximum de plusieurs HLC reçus", () => {
    const clock = createClock("dev001", () => 1000);
    const first = encodeHlc({ wallMs: 3000, counter: 0 }, "aaa111");
    const second = encodeHlc({ wallMs: 3000, counter: 5 }, "bbb222");
    clock.receive(first);
    clock.receive(second);
    expect(compareHlc(clock.tick(), second)).toBe(1);
    expect(clock.last.wallMs).toBe(3000);
  });

  it("reste supérieur à un HLC reçu dans le futur", () => {
    const clock = createClock("dev001", () => 10);
    const remote = encodeHlc({ wallMs: 9000, counter: 12 }, "ccc333");
    clock.receive(remote);
    const next = clock.tick();
    expect(decodeHlc(next).state.wallMs).toBe(9000);
    expect(compareHlc(next, remote)).toBe(1);
  });
});

describe("tri lexicographique", () => {
  it("trie cent horloges aléatoires comme compareHlc", () => {
    const values = Array.from({ length: 100 }, () =>
      encodeHlc(
        { wallMs: Math.floor(Math.random() * 10 ** 9), counter: Math.floor(Math.random() * 100) },
        randomDevice(),
      ),
    );
    const sorted = [...values].sort();
    for (let i = 1; i < sorted.length; i++) {
      expect(compareHlc(sorted[i], sorted[i - 1])).toBeGreaterThanOrEqual(0);
    }
  });
});
