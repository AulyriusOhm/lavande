import { mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const PORT = Number(process.env.UI_CHECK_PORT ?? 1421);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "artifacts");

const candidates = [
  process.env.CHROMIUM_BIN,
  path.join(os.homedir(), ".cache/ms-playwright/chromium-1254/chrome-linux64/chrome"),
  path.join(os.homedir(), ".cache/ms-playwright/chromium-1254/chrome-linux/chrome"),
  path.join(os.homedir(), ".cache/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell"),
].filter(Boolean);

const executablePath = candidates.find((entry) => existsSync(entry));
if (!executablePath) {
  console.error("FAIL: aucun binaire chromium trouvé", candidates);
  process.exit(1);
}

const libDirs = [
  process.env.PLAYWRIGHT_LD_PATH,
  "/tmp/lav/root/usr/lib/x86_64-linux-gnu",
  "/tmp/chr-root/usr/lib/x86_64-linux-gnu",
].filter((entry) => entry && existsSync(path.join(entry, "libatk-1.0.so.0")));
const fontConfig = ["/tmp/fonts/fonts.conf", process.env.FONTCONFIG_FILE].find(
  (entry) => entry && existsSync(entry),
);
const browserEnv = {
  ...process.env,
  LD_LIBRARY_PATH: [...libDirs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
  ...(fontConfig ? { FONTCONFIG_FILE: fontConfig } : {}),
};

mkdirSync(OUT, { recursive: true });

async function startDevServer() {
  process.env.VITE_MAIL_BACKEND = "demo";
  const server = await createServer({
    configFile: path.join(ROOT, "vite.config.ts"),
    root: ROOT,
    cacheDir: path.join(os.tmpdir(), "lavande-ui-check-vite-cache"),
    server: { host: "127.0.0.1", port: PORT, strictPort: true },
  });
  await server.listen();
  return server;
}

const simulateLongLabels = () => {
  const chip = document.querySelector("[data-account-chip]");
  const textColumn = chip?.parentElement?.nextElementSibling;
  if (!chip || !textColumn) return null;
  const textLeft = textColumn.getBoundingClientRect().left;
  const tiers = [
    { label: "POLARIS", fontSize: "9.5px", letterSpacing: "0.05em" },
    { label: "POLARIS07", fontSize: "8.5px", letterSpacing: "0.03em" },
    { label: "POLARIS07-MARKETING", fontSize: "8px", letterSpacing: "0.01em" },
  ];
  const originalText = chip.textContent;
  const results = tiers.map((tier) => {
    chip.textContent = tier.label;
    chip.style.fontSize = tier.fontSize;
    chip.style.letterSpacing = tier.letterSpacing;
    const box = chip.getBoundingClientRect();
    return {
      label: tier.label,
      font: getComputedStyle(chip).fontSize,
      tracking: getComputedStyle(chip).letterSpacing,
      width: Math.round(box.width * 100) / 100,
      right: Math.round(box.right * 100) / 100,
      textColumnLeft: Math.round(textLeft * 100) / 100,
      truncated: chip.scrollWidth > chip.clientWidth + 1,
      overlaps: box.right > textLeft,
    };
  });
  chip.textContent = originalText;
  chip.style.removeProperty("font-size");
  chip.style.removeProperty("letter-spacing");
  return results;
};

const measure = () =>
  Array.from(document.querySelectorAll("[data-account-chip]")).map((chip) => {
    const column = chip.parentElement;
    const textColumn = column?.nextElementSibling;
    const chipBox = chip.getBoundingClientRect();
    const textBox = textColumn?.getBoundingClientRect();
    const style = getComputedStyle(chip);
    return {
      account: chip.getAttribute("data-account-chip"),
      label: chip.textContent?.trim() ?? "",
      title: chip.getAttribute("title"),
      chipRight: Math.round(chipBox.right * 100) / 100,
      chipWidth: Math.round(chipBox.width * 100) / 100,
      textColumnLeft: textBox ? Math.round(textBox.left * 100) / 100 : null,
      columnWidth: column ? Math.round(column.getBoundingClientRect().width * 100) / 100 : null,
      fontSize: style.fontSize,
      letterSpacing: style.letterSpacing,
      marginLeft: style.marginLeft,
      maxWidth: style.maxWidth,
      textOverflow: style.textOverflow,
      truncated: chip.scrollWidth > chip.clientWidth + 1,
    };
  });

const fabProbe = () => {
  const fab = document.querySelector('[aria-label="Nouveau message"]');
  if (!fab) return null;
  const box = fab.getBoundingClientRect();
  const style = getComputedStyle(fab);
  const animated = Array.from(fab.querySelectorAll("*")).filter(
    (el) => getComputedStyle(el).animationName !== "none",
  ).length;
  return {
    buttonClipPath: style.clipPath,
    boxShadow: style.boxShadow,
    animatedDescendants: animated,
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
  };
};

let server = null;
let failed = false;

try {
  server = await startDevServer();

  const browser = await chromium.launch({ executablePath, headless: true, env: browserEnv });
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  if ((await page.locator("[data-account-chip]").count()) === 0) {
    const switcher = page.getByRole("button", { name: "Changer de compte" });
    if (await switcher.count()) {
      await switcher.first().click();
      await page.getByRole("button", { name: /Tous les comptes/ }).first().click();
      await page.waitForTimeout(800);
    }
  }

  await page.locator("[data-account-chip]").first().waitFor({ state: "visible", timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  const chips = await page.evaluate(measure);

  console.log(`\n${chips.length} étiquettes de compte mesurées (viewport 412x915)\n`);
  for (const chip of chips) {
    const clear = chip.textColumnLeft !== null && chip.chipRight <= chip.textColumnLeft && chip.textOverflow === "clip";
    if (!clear) failed = true;
    console.log(
      [
        `${clear ? "ok  " : "FAIL"} ${chip.account.padEnd(7)} « ${chip.label} »`,
        `largeur=${chip.chipWidth}px`,
        `droite=${chip.chipRight}px`,
        `colonne-texte=${chip.textColumnLeft}px`,
        `colonne=${chip.columnWidth}px`,
        `police=${chip.fontSize}`,
        `tracking=${chip.letterSpacing}`,
        `max-width=${chip.maxWidth}`,
        `marge-gauche=${chip.marginLeft}`,
        `text-overflow=${chip.textOverflow}`,
        `tronquée=${chip.truncated}`,
        `title="${chip.title}"`,
      ].join(" | "),
    );
  }

  const simulated = await page.evaluate(simulateLongLabels);
  if (simulated) {
    console.log("\nsimulation de libellés longs (métriques réelles du palier, données démo intactes):");
    for (const item of simulated) {
      if (item.overlaps) failed = true;
      console.log(
        `${item.overlaps ? "FAIL" : "ok  "} « ${item.label} » | largeur=${item.width}px | droite=${item.right}px | colonne-texte=${item.textColumnLeft}px | police=${item.font} | tracking=${item.tracking} | tronquée=${item.truncated}`,
      );
    }
  }

  const fab = await page.evaluate(fabProbe);
  if (!fab) {
    console.log("FAIL: FAB introuvable");
    failed = true;
  } else {
    console.log(
      `\nFAB: animations-descendantes=${fab.animatedDescendants} | clip-bouton=${fab.buttonClipPath} | halo=${fab.boxShadow} | ${Math.round(fab.box.width)}x${Math.round(fab.box.height)}`,
    );
    if (fab.animatedDescendants !== 0) {
      console.log("FAIL: une animation subsiste dans le FAB (clip arrondi WebView → halo carré)");
      failed = true;
    }
    if (fab.boxShadow === "none") {
      console.log("FAIL: le halo du FAB a disparu");
      failed = true;
    }
  }

  await page.screenshot({ path: path.join(OUT, "ui-mobile-list.png") });

  if (fab) {
    const pad = 16;
    await page.screenshot({
      path: path.join(OUT, "ui-mobile-dock.png"),
      clip: {
        x: Math.max(0, fab.box.x - pad),
        y: Math.max(0, fab.box.y - pad),
        width: fab.box.width + pad * 2,
        height: fab.box.height + pad * 2,
      },
    });
  }

  if (errors.length) {
    console.log(`\nErreurs console (${errors.length}):`);
    for (const error of errors.slice(0, 5)) console.log(`  ${error}`);
  }

  await context.close();
  await browser.close();

  console.log(`\ncaptures : artifacts/ui-mobile-list.png, artifacts/ui-mobile-dock.png`);
  console.log(failed ? "\nFAIL" : "\nPASS");
} catch (error) {
  console.error("FAIL:", error?.message ?? error);
  process.exitCode = 1;
} finally {
  await server?.close();
}

if (failed) process.exitCode = 1;
