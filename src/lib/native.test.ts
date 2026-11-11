import { describe, expect, it } from "vitest";
import { resolveShell } from "@/lib/native";

const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/156.0 Safari/537.36";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/156.0 Mobile Safari/537.36";

describe("coquille affichée", () => {
  it("navigateur sans paramètre : maquette mobile encadrée", () => {
    expect(resolveShell({ search: "", tauri: false, userAgent: DESKTOP_UA })).toBe("stage");
  });

  it("navigateur avec ?desktop : vue PC", () => {
    expect(resolveShell({ search: "?desktop", tauri: false, userAgent: DESKTOP_UA })).toBe("desktop");
  });

  it("navigateur avec ?app : plein écran mobile", () => {
    expect(resolveShell({ search: "?app", tauri: false, userAgent: DESKTOP_UA })).toBe("native");
  });

  it("app packagée de bureau : vue PC par défaut", () => {
    expect(resolveShell({ search: "", tauri: true, userAgent: DESKTOP_UA })).toBe("desktop");
  });

  it("app packagée Android : plein écran mobile", () => {
    expect(resolveShell({ search: "", tauri: true, userAgent: ANDROID_UA })).toBe("native");
  });

  it("?desktop force la vue PC même dans la coquille Android", () => {
    expect(resolveShell({ search: "?desktop", tauri: true, userAgent: ANDROID_UA })).toBe("desktop");
  });
});
