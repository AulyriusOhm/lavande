import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANALYSE_CACHE_KEY,
  analyseCacheKey,
  analyseMail,
  computeConflicts,
  freeSlots,
  parseAnalyseTasks,
  readAnalyseCache,
  writeAnalyseCache,
  type AnalyseResult,
} from "@/lib/analyse";
import type { CalendarEvent } from "@/lib/calendar";
import type { SummaryEvent } from "@/lib/summary";

const LLM = { endpoint: "https://llm.example/v1", apiKey: "sk-test", model: "modele" };
const EMPTY_LLM = { endpoint: "", apiKey: "", model: "" };

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const entries = new Map<string, string>(Object.entries(initial));
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

const dayOffset = (offset: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
};

const DAY = dayOffset(3);

const calendarEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "e1",
  date: DAY,
  start: "10:00",
  end: "11:00",
  title: "Point équipe",
  ...overrides,
});

const proposed = (overrides: Partial<SummaryEvent> = {}): SummaryEvent => ({
  title: "Point maquettes",
  date: DAY,
  start: "10:00",
  end: "10:30",
  from: "Camille",
  mailId: "m1",
  ...overrides,
});

const EXTRACTION = JSON.stringify({
  taches: [
    { titre: "Envoyer le devis", echeance: "2026-03-02", de: "Camille", mailId: "autre-mail", assigne: "Stéphane" },
    { titre: "", echeance: "", de: "Camille", mailId: "m1", assigne: "" },
  ],
  evenements: [
    { titre: "Point maquettes", date: DAY, debut: "10:00", fin: "10:30", lieu: "Visio", de: "Camille", mailId: "m1" },
    { titre: "Réunion ailleurs", date: DAY, debut: "14:00", fin: "15:00", de: "Camille", mailId: "autre-mail" },
  ],
});

const MAIL = {
  mailId: "m1",
  from: "Camille <camille@example.com>",
  subject: "Point maquettes",
  body: "On se voit jeudi 10 h pour valider la v3 ?",
  conversation: "",
};

type Call = { system: string; user: string };

function stubFetch(replies: string[]) {
  const calls: Call[] = [];
  const mock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
    calls.push({
      system: body.messages.find((message) => message.role === "system")?.content ?? "",
      user: body.messages.find((message) => message.role === "user")?.content ?? "",
    });
    const content = replies[Math.min(calls.length - 1, replies.length - 1)] ?? "";
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => "",
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", mock);
  return { mock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("analyse · extraction validée", () => {
  it("assainit les tâches et force le mailId sur le mail analysé", () => {
    const tasks = parseAnalyseTasks(EXTRACTION, "m1");

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: "Envoyer le devis",
      due: "2026-03-02",
      from: "Camille",
      mailId: "m1",
      assignee: "Stéphane",
    });
  });

  it("ignore une tâche sans titre et un mailId venu d'ailleurs", () => {
    const tasks = parseAnalyseTasks(EXTRACTION, "m1");
    expect(tasks.some((task) => task.mailId !== "m1")).toBe(false);
    expect(tasks.map((task) => task.title)).toEqual(["Envoyer le devis"]);
  });

  it("borne l'extraction à 8 tâches et 8 rendez-vous", async () => {
    const many = JSON.stringify({
      taches: Array.from({ length: 20 }, (_entry, index) => ({ titre: `Tâche ${index}`, echeance: "aucune", de: "Camille" })),
      evenements: Array.from({ length: 20 }, (_entry, index) => ({
        titre: `Rendez-vous ${index}`,
        date: DAY,
        debut: "10:00",
        fin: "10:30",
      })),
    });
    stubFetch([many]);

    const result = await analyseMail(LLM, MAIL, []);

    expect(result.tasks).toHaveLength(8);
    expect(result.events).toHaveLength(8);
  });

  it("retombe en local quand le modèle ne rend pas un JSON exploitable", async () => {
    stubFetch(["je ne peux pas répondre"]);

    const result = await analyseMail(LLM, MAIL, []);

    expect(result.source).toBe("local");
    expect(result.tasks).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("n'appelle aucun modèle sans configuration", async () => {
    const { mock } = stubFetch([EXTRACTION]);

    const result = await analyseMail(EMPTY_LLM, MAIL, []);

    expect(mock).not.toHaveBeenCalled();
    expect(result).toEqual({
      mailId: "m1",
      tasks: [],
      events: [],
      conflicts: [],
      slots: [],
      generatedAt: expect.any(Number),
      source: "local",
    });
  });
});

describe("analyse · conflits déterministes", () => {
  it("signale un chevauchement réel", () => {
    const conflicts = computeConflicts([proposed({ start: "10:30", end: "11:00" })], [calendarEvent()]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].event.id).toBe("e1");
    expect(conflicts[0].proposed.start).toBe("10:30");
  });

  it("ne signale rien pour des créneaux jointifs, un autre jour ou un titre voisin", () => {
    expect(computeConflicts([proposed({ start: "11:00", end: "11:30" })], [calendarEvent()])).toEqual([]);
    expect(computeConflicts([proposed()], [calendarEvent({ date: dayOffset(4) })])).toEqual([]);
    expect(computeConflicts([proposed({ start: "14:00", end: "15:00" })], [calendarEvent()])).toEqual([]);
  });

  it("donne une heure de fin à un rendez-vous proposé qui n'en a pas", () => {
    const conflicts = computeConflicts([proposed({ start: "10:30", end: "" })], [calendarEvent()]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].proposed.end).toBe("11:30");
  });

  it("donne une heure de fin à un événement d'agenda qui n'en a pas", () => {
    const conflicts = computeConflicts([proposed({ start: "10:30", end: "11:00" })], [calendarEvent({ end: "" })]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].event.end).toBe("11:00");
  });

  it("rend toujours le même résultat", () => {
    const first = computeConflicts([proposed(), proposed({ start: "10:45", end: "11:15" })], [calendarEvent()]);
    const second = computeConflicts([proposed(), proposed({ start: "10:45", end: "11:15" })], [calendarEvent()]);

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
  });
});

describe("analyse · créneaux libres", () => {
  it("rend la journée entière quand l'agenda est vide", () => {
    expect(freeSlots([], DAY)).toEqual([{ date: DAY, start: "08:00", end: "19:00" }]);
  });

  it("retire les occupations de la journée", () => {
    expect(freeSlots([calendarEvent()], DAY)).toEqual([
      { date: DAY, start: "08:00", end: "10:00" },
      { date: DAY, start: "11:00", end: "19:00" },
    ]);
  });

  it("ignore les trous de moins de 30 minutes", () => {
    const events = [
      calendarEvent({ id: "a", start: "08:00", end: "10:00" }),
      calendarEvent({ id: "b", start: "10:20", end: "12:00" }),
      calendarEvent({ id: "c", start: "18:50", end: "19:00" }),
    ];

    expect(freeSlots(events, DAY)).toEqual([{ date: DAY, start: "12:00", end: "18:50" }]);
  });

  it("plafonne à quatre créneaux, du plus tôt au plus tard", () => {
    const events = ["09:00", "11:00", "13:00", "15:00", "17:00"].map((start, index) =>
      calendarEvent({
        id: `e${index}`,
        start,
        end: `${String(Number(start.slice(0, 2)) + 1).padStart(2, "0")}:00`,
      }),
    );

    expect(freeSlots(events, DAY)).toEqual([
      { date: DAY, start: "08:00", end: "09:00" },
      { date: DAY, start: "10:00", end: "11:00" },
      { date: DAY, start: "12:00", end: "13:00" },
      { date: DAY, start: "14:00", end: "15:00" },
    ]);
  });

  it("ignore les autres jours", () => {
    expect(freeSlots([calendarEvent({ date: dayOffset(5) })], DAY)).toEqual([{ date: DAY, start: "08:00", end: "19:00" }]);
  });
});

describe("analyse · cache", () => {
  const RESULT: AnalyseResult = {
    mailId: "m1",
    tasks: [],
    events: [],
    conflicts: [],
    slots: [],
    generatedAt: 1_700_000_000_000,
    source: "llm",
  };

  it("relit ce qu'il a écrit", () => {
    const storage = memoryStorage();
    writeAnalyseCache(storage, "m1:abc", RESULT);

    expect(readAnalyseCache(storage, "m1:abc")).toEqual(RESULT);
    expect(readAnalyseCache(storage, "m1:autre")).toBeNull();
  });

  it("tolère un stockage corrompu", () => {
    const storage = memoryStorage({ [ANALYSE_CACHE_KEY]: "pas du json" });

    expect(readAnalyseCache(storage, "m1:abc")).toBeNull();
    expect(() => writeAnalyseCache(storage, "m1:abc", RESULT)).not.toThrow();
    expect(readAnalyseCache(storage, "m1:abc")).toEqual(RESULT);
    expect(readAnalyseCache(null, "m1:abc")).toBeNull();
  });

  it("ne relance pas le modèle sur une entrée connue", async () => {
    const storage = memoryStorage();
    const { mock } = stubFetch([EXTRACTION]);

    const first = await analyseMail(LLM, MAIL, [], { storage });
    const second = await analyseMail(LLM, MAIL, [], { storage });

    expect(mock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("relance le modèle quand l'analyse est forcée", async () => {
    const storage = memoryStorage();
    const { mock } = stubFetch([EXTRACTION]);

    await analyseMail(LLM, MAIL, [], { storage });
    await analyseMail(LLM, MAIL, [], { storage, force: true });

    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("change de clé quand le contexte ou le style change", () => {
    const base = analyseCacheKey("m1", "corps", "fil", ["2026-01-05 10:00-10:30 Point"], "Équipe", "Style");

    expect(analyseCacheKey("m1", "corps", "fil", ["2026-01-05 10:00-10:30 Point"], "Équipe", "Style")).toBe(base);
    expect(analyseCacheKey("m1", "corps", "fil", ["2026-01-05 10:00-10:30 Point"], "Autre", "Style")).not.toBe(base);
    expect(analyseCacheKey("m1", "corps", "fil", ["2026-01-05 10:00-10:30 Point"], "Équipe", "Autre")).not.toBe(base);
    expect(analyseCacheKey("m2", "corps", "fil", ["2026-01-05 10:00-10:30 Point"], "Équipe", "Style")).not.toBe(base);
  });
});

describe("analyse · brouillon de réponse", () => {
  it("ne demande de réponse que lorsqu'il y a un conflit", async () => {
    const { mock, calls } = stubFetch([EXTRACTION]);

    const result = await analyseMail(LLM, MAIL, [calendarEvent()]);

    expect(result.conflicts).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(result.reply).toBe(EXTRACTION);
    expect(calls[1].user).toContain("<<<MAIL>>>");
    expect(calls[1].user).toContain("Point équipe");
  });

  it("s'arrête à l'extraction sans conflit", async () => {
    const { mock } = stubFetch([EXTRACTION]);

    const result = await analyseMail(LLM, MAIL, [calendarEvent({ date: dayOffset(9) })]);

    expect(result.conflicts).toEqual([]);
    expect(result.reply).toBeUndefined();
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("propose les créneaux libres du jour du rendez-vous", async () => {
    stubFetch([EXTRACTION]);

    const result = await analyseMail(LLM, MAIL, [calendarEvent()]);

    expect(result.slots).toEqual([
      { date: DAY, start: "08:00", end: "10:00" },
      { date: DAY, start: "11:00", end: "19:00" },
    ]);
  });
});

describe("analyse · contexte fiable", () => {
  it("place le contexte d'équipe et le style dans le prompt système", async () => {
    const { calls } = stubFetch([EXTRACTION]);
    const team = "CONTEXTE UTILISATEUR (fiable, fourni par l'utilisateur)\nIdentité : Roman";
    const style = "STYLE D'ÉCRITURE À IMITER (fiable) : tutoiement, phrases courtes";

    await analyseMail(LLM, MAIL, [], { team, style });

    expect(calls[0].system).toContain(team);
    expect(calls[0].system).toContain(style);
    expect(calls[0].user).toContain("<<<MAIL>>>");
    expect(calls[0].user).toContain("<<<FIN_MAIL>>>");
    expect(calls[0].user).toContain("<<<CONVERSATION>>>");
    expect(calls[0].user).toContain("<<<AGENDA>>>");
    expect(calls[0].system).not.toContain(MAIL.body);
  });

  it("n'ajoute aucune section quand le contexte est vide", async () => {
    const { calls } = stubFetch([EXTRACTION]);

    await analyseMail(LLM, MAIL, []);

    expect(calls[0].system).not.toContain("CONTEXTE UTILISATEUR");
    expect(calls[0].system).not.toContain("STYLE D'ÉCRITURE");
  });

  it("met l'agenda des 14 prochains jours sous marqueurs", async () => {
    const { calls } = stubFetch([EXTRACTION]);

    await analyseMail(LLM, MAIL, [calendarEvent(), calendarEvent({ id: "loin", date: dayOffset(40), title: "Point lointain" })]);

    expect(calls[0].user).toContain(`<<<AGENDA>>>\n${DAY} 10:00-11:00 Point équipe`);
    expect(calls[0].user).not.toContain("Point lointain");
  });
});
