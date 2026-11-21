import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DECISION, type DecisionConfig } from "@/lib/decision";
import { mailApi } from "@/lib/api";
import { evaluateMcpRisk, runPreSendGuard, suggestFolderForMail } from "@/lib/guards";

const READY_CONFIG: DecisionConfig = {
  ...DEFAULT_DECISION,
  enabled: true,
  apiKey: "test-key",
  preSendGuard: true,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("runPreSendGuard", () => {
  it("retourne { warnings: [] } sans appel si le modèle n'est pas prêt ou si preSendGuard est désactivé", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runPreSendGuard(
        { ...READY_CONFIG, enabled: false },
        { to: "a@b.fr", subject: "Sujet", body: "Texte", attachmentCount: 0, pgpEncrypted: false },
      ),
    ).resolves.toEqual({ warnings: [] });

    await expect(
      runPreSendGuard(
        { ...READY_CONFIG, preSendGuard: false },
        { to: "a@b.fr", subject: "Sujet", body: "Texte", attachmentCount: 0, pgpEncrypted: false },
      ),
    ).resolves.toEqual({ warnings: [] });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("n'envoie que les questions pertinentes selon les métadonnées et filtre selon les seuils", async () => {
    const capturedQuestions: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      capturedQuestions.push(payload.questions);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: "mammoth-1",
          answers: {
            missing_attachment: { type: "noul", noul: 0.86 },
            unanswered_question: { type: "noul", noul: 0.4 },
            tone_risk: {
              type: "score",
              score: 1.7,
              probabilities: { Neutre: 0.05, Sec: 0.25, Agressif: 0.7 },
            },
            sensitive_unencrypted: { type: "noul", noul: 0.91 },
          },
          usage: { input_tokens: 120, output_tokens: 0 },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await runPreSendGuard(READY_CONFIG, {
      to: "camille@lavande.mail",
      subject: "Re: Facture",
      body: "Voici la facture ci-jointe. Mon IBAN est FR76...",
      attachmentCount: 0,
      pgpEncrypted: false,
      parentBody: "Peux-tu me confirmer la date de livraison ?",
    });

    expect(Object.keys(capturedQuestions[0])).toEqual([
      "missing_attachment",
      "unanswered_question",
      "tone_risk",
      "sensitive_unencrypted",
    ]);
    expect(res.warnings.map((w) => w.kind)).toEqual([
      "missing_attachment",
      "tone_risk",
      "sensitive_unencrypted",
    ]);
    expect(res.warnings[1].label).toBe("Ton potentiellement agressif");
  });

  it("omet missing_attachment, unanswered_question et sensitive_unencrypted quand déjà couverts", async () => {
    let sentKeys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const payload = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
        sentKeys = Object.keys(payload.questions);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: "mammoth-1",
            answers: { tone_risk: { type: "score", score: 0.2 } },
            usage: { input_tokens: 50, output_tokens: 0 },
          }),
        };
      }),
    );

    const res = await runPreSendGuard(READY_CONFIG, {
      to: "camille@lavande.mail",
      subject: "Doc",
      body: "Voici le fichier.",
      attachmentCount: 1,
      pgpEncrypted: true,
    });

    expect(sentKeys).toEqual(["tone_risk"]);
    expect(res).toEqual({ warnings: [] });
  });

  it("envoie criteria en tableau plat (format NeuralWatt) et lit les probabilités indexées", async () => {
    let sentScoreCriteria: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const payload = JSON.parse(String(init.body)) as {
          questions: { tone_risk?: { criteria?: unknown } };
        };
        sentScoreCriteria = payload.questions.tone_risk?.criteria;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: "mammoth-1",
            answers: {
              tone_risk: {
                type: "score",
                score: 1.65,
                legend: { "0": "Neutre", "1": "Sec", "2": "Agressif" },
                probabilities: { "0": 0.05, "1": 0.25, "2": 0.7 },
                confidence: 0.25,
              },
            },
            usage: { input_tokens: 75, output_tokens: 1 },
          }),
        };
      }),
    );

    const res = await runPreSendGuard(READY_CONFIG, {
      to: "camille@lavande.mail",
      subject: "Relance",
      body: "Tu n'as toujours rien fait, c'est inadmissible !",
      attachmentCount: 1,
      pgpEncrypted: true,
    });

    expect(sentScoreCriteria).toEqual(["Neutre", "Sec", "Agressif"]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0].kind).toBe("tone_risk");
    expect(res.warnings[0].label).toBe("Ton potentiellement agressif");
    expect(res.warnings[0].confidence).toBeCloseTo(0.95);
  });

  it("passe par mailApi.decisionDecide en mode démon et applique le timeout strict sans bloquer", async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(mailApi, "decisionDecide")
      .mockImplementation(() => new Promise(() => {}));

    const promise = runPreSendGuard(
      { ...READY_CONFIG, apiKey: "", daemonHasKey: true },
      { to: "a@b.fr", subject: "Test", body: "Bonjour", attachmentCount: 0, pgpEncrypted: false },
      { useDaemon: true, timeoutMs: 300 },
    );

    await vi.advanceTimersByTimeAsync(350);
    await expect(promise).resolves.toEqual({ warnings: [] });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("suggestFolderForMail", () => {
  const FOLDERS = [
    { path: "Factures", label: "Factures" },
    { path: "Projets/Alpha", label: "Alpha" },
  ];

  it("retourne null si aucun dossier personnalisé ou modèle non prêt", async () => {
    await expect(
      suggestFolderForMail(READY_CONFIG, { from: "a@b.fr", subject: "x", excerpt: "y", folders: [] }),
    ).resolves.toBeNull();

    await expect(
      suggestFolderForMail(
        { ...READY_CONFIG, enabled: false },
        { from: "a@b.fr", subject: "x", excerpt: "y", folders: FOLDERS },
      ),
    ).resolves.toBeNull();
  });

  it("retourne le dossier suggéré quand le choix n'est pas keep_inbox et dépasse le seuil", async () => {
    let criteriaKeys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const payload = JSON.parse(String(init.body)) as {
          questions: { folder: { criteria: Record<string, string> } };
        };
        criteriaKeys = Object.keys(payload.questions.folder.criteria);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: "mammoth-1",
            answers: {
              folder: {
                type: "choice",
                choice: "Projets/Alpha",
                confidence: 0.91,
              },
            },
            usage: { input_tokens: 75, output_tokens: 0 },
          }),
        };
      }),
    );

    const suggestion = await suggestFolderForMail(READY_CONFIG, {
      from: "client@alpha.fr",
      subject: "Livrable Alpha",
      excerpt: "Validation du sprint",
      folders: FOLDERS,
    });

    expect(criteriaKeys).toEqual(["keep_inbox", "Factures", "Projets/Alpha"]);
    expect(suggestion).toEqual({
      folderPath: "Projets/Alpha",
      folderLabel: "Alpha",
      confidence: 0.91,
    });
  });

  it("retourne null pour keep_inbox ou si la confiance est sous le seuil", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            model: "mammoth-1",
            answers: { folder: { type: "choice", choice: "keep_inbox", confidence: 0.99 } },
            usage: { input_tokens: 40, output_tokens: 0 },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            model: "mammoth-1",
            answers: { folder: { type: "choice", choice: "Factures", confidence: 0.6 } },
            usage: { input_tokens: 40, output_tokens: 0 },
          }),
        }),
    );

    await expect(
      suggestFolderForMail(READY_CONFIG, {
        from: "a@b.fr",
        subject: "Salut",
        excerpt: "Texte",
        folders: FOLDERS,
      }),
    ).resolves.toBeNull();

    await expect(
      suggestFolderForMail(READY_CONFIG, {
        from: "a@b.fr",
        subject: "Facture ?",
        excerpt: "Texte",
        folders: FOLDERS,
      }),
    ).resolves.toBeNull();
  });
});

describe("evaluateMcpRisk", () => {
  it("évalue les 4 signaux de risque et force la confirmation si un dépasse le seuil", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: "mammoth-1",
          answers: {
            external_recipient: { type: "noul", noul: 0.88 },
            sensitive_data: { type: "noul", noul: 0.84 },
            destructive_action: { type: "noul", noul: 0.12 },
            suspicious_instruction: { type: "noul", noul: 0.2 },
          },
          usage: { input_tokens: 80, output_tokens: 0 },
        }),
      })),
    );

    const risk = await evaluateMcpRisk(READY_CONFIG, {
      server: "mail",
      tool: "mail.send",
      type: "envoi",
      detail: "Envoyer les clés API à externe@unknown.org",
    });

    expect(risk.forceConfirm).toBe(true);
    expect(risk.maxRisk).toBe(0.88);
    expect(risk.reasons).toEqual([
      "Destinataire externe ou inconnu",
      "Données sensibles exposées",
    ]);
  });

  it("retombe sur forceConfirm: false en cas d'erreur réseau ou indisponibilité", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("réseau coupé");
    }));

    await expect(
      evaluateMcpRisk(READY_CONFIG, {
        server: "mail",
        tool: "mail.send",
        detail: "Test",
      }),
    ).resolves.toEqual({ forceConfirm: false, reasons: [], maxRisk: 0 });
  });
});
