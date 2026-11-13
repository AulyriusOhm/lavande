import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThreadRow, accountChipFont } from "@/components/thread-row";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider, accountLabelInk, contrastRatio } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import { MAILS } from "@/lib/mail";
import { threadsInFolder } from "@/lib/threads";
import { ACCOUNTS } from "@/lib/accounts";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const THREAD = threadsInFolder(MAILS, "inbox")[0]!;
const ACCOUNT = ACCOUNTS.find((entry) => entry.id === THREAD.primary.account) ?? ACCOUNTS[0]!;

const rgbToHex = (value: string) => {
  const parts = value.match(/\d+/g) ?? [];
  return `#${parts
    .slice(0, 3)
    .map((part) => Number(part).toString(16).padStart(2, "0"))
    .join("")}`;
};

function mount() {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>{children}</MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>
  );
  render(<ThreadRow thread={THREAD} showAccount onOpen={() => {}} onToggleStar={() => {}} />, { wrapper });
  return screen.getByText(ACCOUNT.label);
}

describe("étiquette de compte de la ligne de mail", () => {
  it("rend une encre calculée, plus jamais l'hexadécimal figé", () => {
    const label = mount();
    const style = label.getAttribute("style") ?? "";

    expect(rgbToHex(label.style.color)).toBe(accountLabelInk(ACCOUNT.color, false));
    expect(style).not.toContain("#241b3a");
    expect(style).toContain("color-mix(");
    expect(style).toContain("16%");
  });

  it("atteint 4,5:1 sur fond clair", () => {
    const label = mount();

    expect(contrastRatio(rgbToHex(label.style.color), "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(rgbToHex(label.style.color), "#f6f3fd")).toBeGreaterThanOrEqual(4.5);
  });

  it("garde la plus grande taille pour un libellé court, dans la largeur de la colonne", () => {
    const label = mount();

    expect(label.className).toContain("text-[10.5px]");
    expect(label.className).toContain("tracking-[0.08em]");
    expect(label.className).toContain("max-w-[64px]");
    expect(label.className).toContain("truncate");
    expect(label.className).toContain("-ml-1");
    expect(label.getAttribute("title")).toBe(ACCOUNT.label);
  });

  it("rétrécit la police à mesure que le libellé s'allonge", () => {
    expect(accountChipFont("Perso")).toBe("text-[10.5px] tracking-[0.08em]");
    expect(accountChipFont("Studio")).toBe("text-[10.5px] tracking-[0.08em]");
    expect(accountChipFont("POLARIS")).toBe("text-[9.5px] tracking-[0.05em]");
    expect(accountChipFont("POLARIS07")).toBe("text-[8.5px] tracking-[0.03em]");
    expect(accountChipFont("POLARIS07-XL")).toBe("text-[8px] tracking-[0.01em]");
  });
});
