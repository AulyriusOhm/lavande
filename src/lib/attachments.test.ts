import { beforeEach, describe, expect, it, vi } from "vitest";
import { downloadAttachment } from "@/lib/attachments";
import type { Mail, MailAttachment } from "@/lib/mail";

const { attachmentMock, saveBlobMock, isNativeShellMock } = vi.hoisted(() => ({
  attachmentMock: vi.fn(),
  saveBlobMock: vi.fn(),
  isNativeShellMock: vi.fn(() => false),
}));

vi.mock("@/lib/api", () => ({
  mailApi: { attachment: attachmentMock },
  errorText: (error: unknown) => (error instanceof Error ? error.message : "erreur inconnue"),
}));
vi.mock("@/lib/download", () => ({ saveBlob: saveBlobMock }));
vi.mock("@/lib/native", () => ({ isNativeShell: isNativeShellMock }));

const BLOB = new Blob([new Uint8Array([104, 101, 108, 108, 111])], { type: "application/pdf" });
const FILE: MailAttachment = {
  name: "facture.pdf",
  size: "5 o",
  mime: "application/pdf",
  index: 0,
};
const MAIL = {
  id: "perso:INBOX:12",
  account: "perso",
  folder: "inbox",
  source: { accountId: "perso", folderPath: "INBOX", uid: 12 },
  attachments: [FILE],
} as unknown as Mail;

beforeEach(() => {
  attachmentMock.mockReset().mockResolvedValue(BLOB);
  saveBlobMock.mockReset();
  isNativeShellMock.mockReset().mockReturnValue(false);
});

describe("downloadAttachment", () => {
  it("rend le chemin réel du fichier enregistré sur le poste", async () => {
    saveBlobMock.mockResolvedValue("/home/roman/Téléchargements/facture.pdf");
    expect(await downloadAttachment(MAIL, FILE)).toEqual({
      message: "« facture.pdf » enregistré dans /home/roman/Téléchargements/facture.pdf",
      path: "/home/roman/Téléchargements/facture.pdf",
    });
    expect(attachmentMock).toHaveBeenCalledWith("perso", "INBOX", 12, 0);
    expect(saveBlobMock).toHaveBeenCalledWith(BLOB, "facture.pdf");
  });

  it("annonce l'ouverture sur Android", async () => {
    isNativeShellMock.mockReturnValue(true);
    saveBlobMock.mockResolvedValue("/data/user/0/eu.lanro.lavande/cache/attachments/facture.pdf");
    expect(await downloadAttachment(MAIL, FILE)).toEqual({
      message: "Ouverture de « facture.pdf »",
      path: "/data/user/0/eu.lanro.lavande/cache/attachments/facture.pdf",
    });
  });

  it("garde « téléchargé » dans le navigateur, sans chemin", async () => {
    saveBlobMock.mockResolvedValue(null);
    expect(await downloadAttachment(MAIL, FILE)).toEqual({
      message: "« facture.pdf » téléchargé",
      path: null,
    });
  });

  it("garde « téléchargé » quand l'enregistrement ne rend rien", async () => {
    saveBlobMock.mockResolvedValue(undefined);
    expect(await downloadAttachment(MAIL, FILE)).toEqual({
      message: "« facture.pdf » téléchargé",
      path: null,
    });
  });

  it("signale l'échec du démon", async () => {
    attachmentMock.mockRejectedValue(new Error("démon injoignable"));
    expect(await downloadAttachment(MAIL, FILE)).toEqual({
      message: "Téléchargement impossible · démon injoignable",
      path: null,
    });
  });

  it("ne télécharge rien pour un mail de la maquette", async () => {
    const draft = { ...MAIL, source: undefined } as unknown as Mail;
    const result = await downloadAttachment(draft, FILE);
    expect(result.message).toContain("vient de la maquette");
    expect(result.path).toBeNull();
    expect(attachmentMock).not.toHaveBeenCalled();
  });
});
