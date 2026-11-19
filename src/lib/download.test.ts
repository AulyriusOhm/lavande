import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveBlob } from "@/lib/download";

const { invokeMock, isNativeShellMock, isTauriShellMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isNativeShellMock: vi.fn(() => false),
  isTauriShellMock: vi.fn(() => false),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/native", () => ({ isNativeShell: isNativeShellMock }));
vi.mock("@/lib/open-external", () => ({ isTauriShell: isTauriShellMock }));

const BYTES = new Uint8Array([104, 101, 108, 108, 111]);
const BASE64 = "aGVsbG8=";

function blob(type = "application/pdf") {
  return new Blob([BYTES], { type });
}

beforeEach(() => {
  invokeMock.mockReset();
  isNativeShellMock.mockReset().mockReturnValue(false);
  isTauriShellMock.mockReset().mockReturnValue(false);
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => "blob:lavande"),
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
});

describe("saveBlob — poste Tauri", () => {
  it("confie les octets à save_attachment et rend le chemin écrit", async () => {
    isTauriShellMock.mockReturnValue(true);
    invokeMock.mockResolvedValue("/home/roman/Téléchargements/facture.pdf");
    const path = await saveBlob(blob(), "facture.pdf");
    expect(invokeMock).toHaveBeenCalledWith("save_attachment", {
      name: "facture.pdf",
      dataBase64: BASE64,
    });
    expect(path).toBe("/home/roman/Téléchargements/facture.pdf");
  });
});

describe("saveBlob — Android", () => {
  it("passe par le plugin natif avec le type MIME et rend le chemin", async () => {
    isTauriShellMock.mockReturnValue(true);
    isNativeShellMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({
      path: "/data/user/0/eu.lanro.lavande/cache/attachments/facture.pdf",
    });
    const path = await saveBlob(blob(), "facture.pdf");
    expect(invokeMock).toHaveBeenCalledWith("plugin:lavandeattachments|open_attachment", {
      name: "facture.pdf",
      mime: "application/pdf",
      dataBase64: BASE64,
    });
    expect(path).toBe("/data/user/0/eu.lanro.lavande/cache/attachments/facture.pdf");
  });
});

describe("saveBlob — navigateur", () => {
  it("garde l'ancre de téléchargement et ne rend aucun chemin", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const path = await saveBlob(blob(), "facture.pdf");
    expect(click).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(path).toBeNull();
  });
});
