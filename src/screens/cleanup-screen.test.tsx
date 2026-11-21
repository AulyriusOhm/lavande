import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_DECISION_THRESHOLDS, type MailDecision } from "@/lib/decision";
import { createMemoryDecisionDb } from "@/lib/decision-db";
import type { Mail } from "@/lib/mail";
import { CleanupScreen } from "@/screens/cleanup-screen";

const NOW = Date.now();

function makeMail(overrides: Partial<Mail> = {}): Mail {
  const id = overrides.id ?? "m1";
  return {
    id,
    account: "perso",
    folder: "inbox",
    name: "Boutique X",
    email: "news@boutique-x.fr",
    subject: `Offre ${id}`,
    preview: `Aperçu du message ${id}`,
    body: [`Corps du message ${id}`],
    time: "10:15",
    timestamp: NOW - 48 * 3_600_000,
    unread: true,
    starred: false,
    pgp: "none",
    tone: 0,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<MailDecision> = {}): MailDecision {
  return {
    accountId: "perso",
    folderPath: "INBOX",
    uid: 1,
    contentHash: "h1",
    schemaVersion: 1,
    model: "mammoth-1",
    category: "promo",
    categoryConf: 0.94,
    categoryProbs: { promo: 0.94 },
    urgency: 0.1,
    needsReply: 0.01,
    hasTask: 0.0,
    hasEvent: 0.0,
    security: "safe",
    securityConf: 0.99,
    cleanupScore: 0.92,
    decidedAt: NOW,
    source: "local",
    ...overrides,
  };
}

describe("CleanupScreen", () => {
  it("ne déclenche aucune suppression ni revue automatique au montage", async () => {
    const db = createMemoryDecisionDb();
    const putSpy = vi.spyOn(db, "putCleanupReview");
    const onTrash = vi.fn();
    const onArchive = vi.fn();
    const onRestore = vi.fn();

    const m1 = makeMail({ id: "m1" });
    render(
      <CleanupScreen
        mails={[m1]}
        decisions={{ m1: makeDecision() }}
        thresholds={DEFAULT_DECISION_THRESHOLDS}
        onTrash={onTrash}
        onArchive={onArchive}
        onRestore={onRestore}
        onClose={vi.fn()}
        db={db}
      />,
    );

    expect(screen.getByText("Offre m1")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Publicité · 94 %/)).toBeTruthy());

    expect(onTrash).not.toHaveBeenCalled();
    expect(onArchive).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("gère les boutons Corbeille, Archiver, Garder et le Undo complet", async () => {
    const db = createMemoryDecisionDb();
    const onTrash = vi.fn();
    const onArchive = vi.fn();
    const onRestore = vi.fn();

    const m1 = makeMail({ id: "m1", subject: "Pub 1" });
    const m2 = makeMail({ id: "m2", subject: "Notif 2", email: "alert@cloud.fr" });
    const m3 = makeMail({ id: "m3", subject: "Vieux TOTP 3", email: "auth@bank.fr" });

    render(
      <CleanupScreen
        mails={[m1, m2, m3]}
        decisions={{
          m1: makeDecision({ category: "promo", categoryConf: 0.94 }),
          m2: makeDecision({ category: "notification", categoryConf: 0.89 }),
          m3: makeDecision({ category: "auth_totp", categoryConf: 0.97 }),
        }}
        thresholds={DEFAULT_DECISION_THRESHOLDS}
        onTrash={onTrash}
        onArchive={onArchive}
        onRestore={onRestore}
        onClose={vi.fn()}
        db={db}
      />,
    );

    // 1. Corbeille sur m1
    fireEvent.click(screen.getByRole("button", { name: /Corbeille/i }));
    await waitFor(() => expect(onTrash).toHaveBeenCalledWith([m1]));
    expect((await db.getCleanupReview("m1"))?.action).toBe("trashed");
    await waitFor(() => expect(screen.getByText("Notif 2")).toBeTruthy());
    expect(screen.getByText("1 traité")).toBeTruthy();

    // 2. Archiver sur m2
    fireEvent.click(screen.getByRole("button", { name: /Archiver/i }));
    await waitFor(() => expect(onArchive).toHaveBeenCalledWith([m2]));
    expect((await db.getCleanupReview("m2"))?.action).toBe("archived");
    await waitFor(() => expect(screen.getByText("Vieux TOTP 3")).toBeTruthy());
    expect(screen.getByText("2 traités")).toBeTruthy();

    // 3. Garder sur m3 -> vide la pile
    fireEvent.click(screen.getByRole("button", { name: /Garder/i }));
    await waitFor(async () => {
      expect((await db.getCleanupReview("m3"))?.action).toBe("kept");
    });
    expect(screen.getByText("Tout est propre !")).toBeTruthy();
    expect(onTrash).toHaveBeenCalledTimes(1);
    expect(onArchive).toHaveBeenCalledTimes(1);

    // 4. Undo sur m3 (kept -> ne rappelle pas onRestore)
    fireEvent.click(screen.getByRole("button", { name: /Annuler la dernière action/i }));
    await waitFor(() => expect(screen.getByText("Vieux TOTP 3")).toBeTruthy());
    expect(await db.getCleanupReview("m3")).toBeNull();
    expect(onRestore).not.toHaveBeenCalled();

    // 5. Undo sur m2 (archived -> appelle onRestore([m2]))
    fireEvent.click(screen.getByRole("button", { name: /Annuler la dernière action/i }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith([m2]));
    await waitFor(() => expect(screen.getByText("Notif 2")).toBeTruthy());
    expect(await db.getCleanupReview("m2")).toBeNull();
  });

  it("prend en charge les raccourcis clavier ArrowLeft, ArrowRight, ArrowUp et z", async () => {
    const db = createMemoryDecisionDb();
    const onTrash = vi.fn();
    const onArchive = vi.fn();
    const onRestore = vi.fn();

    const m1 = makeMail({ id: "m1", subject: "Carte clavier 1" });
    const m2 = makeMail({ id: "m2", subject: "Carte clavier 2" });
    const m3 = makeMail({ id: "m3", subject: "Carte clavier 3" });

    render(
      <CleanupScreen
        mails={[m1, m2, m3]}
        decisions={{
          m1: makeDecision({ category: "promo" }),
          m2: makeDecision({ category: "promo" }),
          m3: makeDecision({ category: "promo" }),
        }}
        thresholds={DEFAULT_DECISION_THRESHOLDS}
        onTrash={onTrash}
        onArchive={onArchive}
        onRestore={onRestore}
        onClose={vi.fn()}
        db={db}
      />,
    );

    // ArrowLeft -> Corbeille
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() => expect(onTrash).toHaveBeenCalledWith([m1]));
    await waitFor(() => expect(screen.getByText("Carte clavier 2")).toBeTruthy());

    // z -> Undo Corbeille
    fireEvent.keyDown(window, { key: "z" });
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith([m1]));
    await waitFor(() => expect(screen.getByText("Carte clavier 1")).toBeTruthy());

    // ArrowUp -> Archiver
    fireEvent.keyDown(window, { key: "ArrowUp" });
    await waitFor(() => expect(onArchive).toHaveBeenCalledWith([m1]));
    await waitFor(() => expect(screen.getByText("Carte clavier 2")).toBeTruthy());

    // ArrowRight -> Garder
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(async () => {
      expect((await db.getCleanupReview("m2"))?.action).toBe("kept");
    });
    expect(screen.getByText("Carte clavier 3")).toBeTruthy();
  });

  it("bascule en mode groupé par expéditeur et permet de protéger ou tout jeter", async () => {
    const db = createMemoryDecisionDb();
    const onTrash = vi.fn();
    const onArchive = vi.fn();

    const b1 = makeMail({ id: "b1", name: "Boutique X", email: "news@boutique-x.fr", subject: "Promo 1" });
    const b2 = makeMail({ id: "b2", name: "Boutique X", email: "news@boutique-x.fr", subject: "Promo 2" });
    const b3 = makeMail({ id: "b3", name: "Boutique X", email: "news@boutique-x.fr", subject: "Promo 3" });
    const s1 = makeMail({ id: "s1", name: "Service Y", email: "hello@service-y.fr", subject: "Alerte 1" });

    render(
      <CleanupScreen
        mails={[s1, b1, b2, b3]}
        decisions={{
          b1: makeDecision({ category: "promo" }),
          b2: makeDecision({ category: "promo" }),
          b3: makeDecision({ category: "promo" }),
          s1: makeDecision({ category: "notification" }),
        }}
        thresholds={DEFAULT_DECISION_THRESHOLDS}
        onTrash={onTrash}
        onArchive={onArchive}
        onClose={vi.fn()}
        db={db}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Par expéditeur/i }));
    expect(screen.getByText("3 pubs de Boutique X")).toBeTruthy();

    // Garder le groupe Boutique X -> propose de protéger l'expéditeur
    fireEvent.click(screen.getByRole("button", { name: /Garder/i }));
    await waitFor(() => expect(screen.getByText("1 notification de Service Y")).toBeTruthy());
    expect(screen.getByText(/Protéger l'expéditeur/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Protéger l'expéditeur/i }));
    await waitFor(async () => {
      expect(await db.isSenderProtected("news@boutique-x.fr")).toBe(true);
    });

    // Corbeille sur le groupe restant (Service Y)
    fireEvent.click(screen.getByRole("button", { name: /Corbeille/i }));
    await waitFor(() => expect(onTrash).toHaveBeenCalledWith([s1]));
    expect(screen.getByText("Tout est propre !")).toBeTruthy();
  });

  it("filtre par puces et propose l'analyse manuelle de 50 mails plus anciens", async () => {
    const db = createMemoryDecisionDb();
    const onScanMore = vi.fn();
    const onClose = vi.fn();
    const onOpenMail = vi.fn();

    const promo = makeMail({ id: "p1", subject: "Promo unique" });
    const totp = makeMail({
      id: "t1",
      subject: "Code 2FA expiré",
      timestamp: NOW - 3 * 24 * 3_600_000,
    });

    render(
      <CleanupScreen
        mails={[promo, totp]}
        decisions={{
          p1: makeDecision({ category: "promo" }),
          t1: makeDecision({ category: "auth_totp" }),
        }}
        thresholds={DEFAULT_DECISION_THRESHOLDS}
        onTrash={vi.fn()}
        onArchive={vi.fn()}
        onOpenMail={onOpenMail}
        onScanMore={onScanMore}
        onClose={onClose}
        db={db}
      />,
    );

    await waitFor(() => expect(screen.getByText("Promo unique")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Ouvrir le mail/i }));
    expect(onOpenMail).toHaveBeenCalledWith(promo);

    // Filtre Vieux TOTP
    fireEvent.click(screen.getByRole("button", { name: /Vieux TOTP/i }));
    expect(screen.getByText("Code 2FA expiré")).toBeTruthy();

    // Filtre Notifications (vide ici) -> état vide avec bouton Analyser 50 mails plus anciens
    fireEvent.click(screen.getByRole("button", { name: /Notifications/i }));
    expect(screen.getByText("Tout est propre !")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Analyser 50 mails plus anciens/i }));
    expect(onScanMore).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Retour à la boîte/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
