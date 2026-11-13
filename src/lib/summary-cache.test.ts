import { describe, expect, it } from "vitest";
import {
  SUMMARY_CACHE_KEY,
  currentPeriod,
  fallbackSummary,
  readSummaryCache,
  summaryScope,
  summarySignature,
  writeSummaryCache,
  type SummaryMailInput,
  type SummaryResult,
} from "@/lib/summary";

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => void entries.delete(key),
    setItem: (key: string, value: string) => void entries.set(key, value),
  } as Storage;
}

const mail = (id: string, timestamp = 1_700_000_000_000): SummaryMailInput => ({
  id,
  from: "Camille",
  subject: `Objet ${id}`,
  snippet: `Aperçu ${id}`,
  timestamp,
});

const RESULT: SummaryResult = {
  period: { id: "morning", label: "Résumé du matin" },
  text: "Trois mails, dont un de Camille.",
  tasks: [{ title: "Répondre à Camille", due: "vendredi", from: "Camille", mailId: "1" }],
  mailCount: 2,
  generatedAt: 1_700_000_000_000,
  source: "llm",
  mailIds: ["1", "2"],
};

describe("résumé · portée et signature", () => {
  it("range « tous les comptes » sous la portée all", () => {
    expect(summaryScope(null)).toBe("all");
    expect(summaryScope(undefined)).toBe("all");
    expect(summaryScope("")).toBe("all");
    expect(summaryScope("alpha")).toBe("alpha");
  });

  it("garde la même empreinte quel que soit l'ordre des mails", () => {
    const first = summarySignature([mail("a"), mail("b")]);
    const second = summarySignature([mail("b"), mail("a")]);

    expect(first).toBe(second);
    expect(first).not.toBe(summarySignature([mail("a")]));
    expect(first).not.toBe(summarySignature([mail("a"), mail("b", 1)]));
  });
});

describe("résumé · cache sur le poste", () => {
  it("relit le résultat pour la même portée, la même plage et le même jeu de mails", () => {
    const storage = memoryStorage();
    const signature = summarySignature([mail("1"), mail("2")]);

    writeSummaryCache(storage, "all", "morning", signature, RESULT);

    expect(readSummaryCache(storage, "all", "morning", signature)).toEqual(RESULT);
  });

  it("ignore une empreinte, une plage ou une portée différentes", () => {
    const storage = memoryStorage();
    const signature = summarySignature([mail("1"), mail("2")]);
    writeSummaryCache(storage, "all", "morning", signature, RESULT);

    expect(readSummaryCache(storage, "all", "morning", summarySignature([mail("1")]))).toBeNull();
    expect(readSummaryCache(storage, "all", "midday", signature)).toBeNull();
    expect(readSummaryCache(storage, "alpha", "morning", signature)).toBeNull();
  });

  it("conserve une entrée par portée", () => {
    const storage = memoryStorage();
    const signature = summarySignature([mail("1"), mail("2")]);
    const other: SummaryResult = { ...RESULT, text: "Résumé de la boîte alpha", mailCount: 1, mailIds: ["1"] };

    writeSummaryCache(storage, "all", "morning", signature, RESULT);
    writeSummaryCache(storage, "alpha", "morning", signature, other);

    expect(readSummaryCache(storage, "all", "morning", signature)?.text).toBe(RESULT.text);
    expect(readSummaryCache(storage, "alpha", "morning", signature)?.text).toBe(other.text);
    expect(Object.keys(JSON.parse(storage.getItem(SUMMARY_CACHE_KEY) ?? "{}"))).toEqual([
      `all:morning:${signature}`,
      `alpha:morning:${signature}`,
    ]);
  });

  it("borne le nombre d'entrées conservées", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 12; index += 1) {
      const signature = summarySignature([mail(`m${index}`)]);
      writeSummaryCache(storage, "all", "morning", signature, { ...RESULT, generatedAt: 1_700_000_000_000 + index });
    }

    const entries = Object.values(
      JSON.parse(storage.getItem(SUMMARY_CACHE_KEY) ?? "{}") as Record<string, { result: SummaryResult }>,
    );
    expect(entries.length).toBeLessThanOrEqual(8);
    expect(entries.some((entry) => entry.result.generatedAt === 1_700_000_000_011)).toBe(true);
  });

  it("résiste à un stockage absent ou corrompu", () => {
    const storage = memoryStorage();
    const signature = summarySignature([mail("1")]);

    expect(readSummaryCache(null, "all", "morning", signature)).toBeNull();
    storage.setItem(SUMMARY_CACHE_KEY, "{pas du json");
    expect(readSummaryCache(storage, "all", "morning", signature)).toBeNull();
    storage.setItem(SUMMARY_CACHE_KEY, JSON.stringify({ "all:morning": { signature, result: { text: 3 } } }));
    expect(readSummaryCache(storage, "all", "morning", signature)).toBeNull();
    expect(() => writeSummaryCache(null, "all", "morning", signature, RESULT)).not.toThrow();
  });
});

describe("résumé · mails analysés", () => {
  it("expose les ids analysés pour retrouver leurs pièces jointes", () => {
    const mails = [mail("1"), mail("2")];
    const result = fallbackSummary(mails, currentPeriod({ enabled: true, llmConsent: false, morningStart: 6, middayStart: 12, eveningStart: 18, lookbackHours: 24 }));

    expect(result.mailIds).toEqual(["1", "2"]);
    expect(result.mailCount).toBe(2);
  });
});
