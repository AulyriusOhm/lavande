import { chromium } from "playwright-core";
import { createServer } from "vite";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";

process.env.VITE_MAIL_BACKEND = "demo";
delete process.env.VITE_DISTRIBUTION;

const FFMPEG = "/home/roman/.local/bin/ffmpeg";
const RAW_DIR = "artifacts/vitrine-shots";
const OUT_DIR = "site-vitrine/assets/img/shots";
const PORT = 1426;
const CACHE_DIR = "/tmp/lavande-vite-capture";
const BASE = `http://127.0.0.1:${PORT}`;
const SETTLE = 400;
const QUALITIES = [90, 85, 80, 75, 70];

mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });
rmSync(CACHE_DIR, { recursive: true, force: true });

const results = [];
const THEMES = ["dark", "light"];

const PC = { viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5, width: 1600, maxKb: 250 };
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, width: 780, maxKb: 120 };

function encode(rawPath, outPath, width, maxKb) {
  let size = 0;
  let quality = QUALITIES[0];
  for (const attempt of QUALITIES) {
    quality = attempt;
    execFileSync(FFMPEG, [
      "-y",
      "-loglevel",
      "error",
      "-i",
      rawPath,
      "-vf",
      `scale=${width}:-2:flags=lanczos`,
      "-c:v",
      "libwebp",
      "-preset",
      "text",
      "-q:v",
      String(attempt),
      outPath,
    ]);
    size = statSync(outPath).size;
    if (size / 1024 <= maxKb) break;
  }
  return { kb: Math.round(size / 1024), quality, ok: size / 1024 <= maxKb };
}

const images = [];

async function capture(context, name, theme, spec, ready, act) {
  const url = spec === PC ? `${BASE}/?desktop` : BASE;
  const raw = `${RAW_DIR}/${name}-${theme}.png`;
  const out = `${OUT_DIR}/${name}-${theme}.webp`;
  let lastError = "";

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
      await page.waitForSelector(ready, { timeout: 20_000 });
      if (await page.locator("vite-error-overlay").count()) throw new Error("overlay d'erreur Vite");
      if (act) await act(page);
      await page.waitForTimeout(SETTLE);
      if (await page.locator("vite-error-overlay").count()) throw new Error("overlay d'erreur Vite");
      if ((await page.evaluate(() => document.body.innerText.length)) < 200) throw new Error("page vide");
      await page.screenshot({ path: raw });
      const encoded = encode(raw, out, spec.width, spec.maxKb);
      images.push({ file: out, ...encoded });
      const detail = `q${encoded.quality}${attempt > 1 ? ` · essai ${attempt}` : ""}${errors.length ? ` · erreurs JS : ${errors[0]}` : ""}`;
      results.push(`${encoded.ok && errors.length === 0 ? "PASS" : "FAIL"} · ${name}-${theme} · ${encoded.kb} Ko · ${detail}`);
      return;
    } catch (error) {
      lastError = String(error).split("\n")[0];
      await page.waitForTimeout(1000);
    } finally {
      await page.close();
    }
  }
  results.push(`FAIL · ${name}-${theme} · ${lastError}`);
}

async function clickUntil(page, act, selector, attempts = 3) {
  let missing = "";
  for (let index = 0; index < attempts; index += 1) {
    await act();
    try {
      await page.waitForSelector(selector, { timeout: 4000 });
      return;
    } catch (error) {
      missing = String(error).split("\n")[0];
      await page.waitForTimeout(600);
    }
  }
  throw new Error(`${selector} jamais affiché · ${missing}`);
}

const openMail = async (page) => {
  await page
    .locator('[data-mail-row][aria-label*="Maquettes mobiles"]')
    .first()
    .click({ timeout: 15_000 });
  await page.waitForSelector('[aria-label="Panneau de lecture"] h1', { timeout: 15_000 });
};

const PC_SHOTS = [
  {
    name: "pc-inbox",
    ready: '[data-mail-row], [aria-label="Panneau de lecture"]',
    act: openMail,
  },
  {
    name: "pc-agenda",
    ready: '[data-desktop] button[aria-current]',
    act: async (page) => {
      await clickUntil(
        page,
        () => page.getByRole("button", { name: "Agenda", exact: true }).click(),
        '[data-testid="view-week"]',
      );
      await page.getByTestId("view-week").click();
      await page.waitForTimeout(SETTLE);
    },
  },
  {
    name: "pc-planning",
    ready: '[data-desktop] button[aria-current]',
    act: async (page) => {
      await clickUntil(
        page,
        () => page.getByRole("button", { name: "Planification", exact: true }).click(),
        '[data-testid="column-doing"]',
      );
    },
  },
  {
    name: "pc-settings",
    ready: '[data-desktop] button[aria-current]',
    act: async (page) => {
      await clickUntil(
        page,
        () => page.getByRole("button", { name: "Réglages", exact: true }).click(),
        "#reglages-comptes",
      );
      await page.locator("#reglages-comptes").scrollIntoViewIfNeeded();
    },
  },
  {
    name: "pc-compose",
    ready: '[data-desktop] button[aria-current]',
    act: async (page) => {
      await page.getByRole("button", { name: "Nouveau message" }).click();
      await page.waitForSelector('[data-testid="desktop-compose"]', { timeout: 15_000 });
      await page.locator("#compose-to").fill("camille@studio-lilas.fr");
      await page.locator('input[placeholder="Objet du message"]').fill("Planning phase 2 — accès serveur");
      const body = page.locator('[data-testid="desktop-compose"] .ProseMirror');
      await body.click();
      await page.keyboard.insertText(
        "Salut Camille,\n\nMerci pour l'avenant signé. Je démarre la phase 2 lundi : je t'envoie le planning détaillé et les accès serveur dans la journée.\n\nÀ lundi,\nRoman",
      );
    },
  },
];

const MOBILE_SHOTS = [
  { name: "mobile-inbox", ready: "[data-mail-row]" },
  {
    name: "mobile-agenda",
    ready: "[data-mail-row]",
    act: async (page) => {
      await clickUntil(
        page,
        () => page.getByRole("button", { name: "Agenda" }).click(),
        '[aria-label="Mois suivant"]',
      );
    },
  },
  {
    name: "mobile-settings",
    ready: "[data-mail-row]",
    act: async (page) => {
      await clickUntil(
        page,
        () => page.getByRole("button", { name: "Réglages" }).click(),
        "text=Réglages",
        2,
      );
      await clickUntil(
        page,
        () => page.getByRole("button", { name: /^Comptes/ }).click(),
        '[aria-label="Retour aux réglages"]',
      );
    },
  },
];

const server = await createServer({
  configFile: "vite.config.ts",
  root: process.cwd(),
  cacheDir: CACHE_DIR,
  server: { host: "127.0.0.1", port: PORT, strictPort: true },
});
await server.listen();

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome`,
  env: {
    ...process.env,
    LD_LIBRARY_PATH: "/tmp/chromedeps/root/usr/lib/x86_64-linux-gnu",
    FONTCONFIG_FILE: "/tmp/chromedeps/fonts.conf",
  },
});

try {
  for (const theme of THEMES) {
    const init = (mode) => {
      try {
        window.localStorage.setItem("lavande.theme", JSON.stringify({ mode }));
      } catch {
        // stockage indisponible : thème par défaut
      }
    };

    const pc = await browser.newContext({ ...PC, reducedMotion: "reduce", colorScheme: theme });
    await pc.addInitScript(init, theme);
    for (const shot of PC_SHOTS) await capture(pc, shot.name, theme, PC, shot.ready, shot.act);
    await pc.close();

    const mobile = await browser.newContext({ ...MOBILE, reducedMotion: "reduce", colorScheme: theme });
    await mobile.addInitScript(init, theme);
    for (const shot of MOBILE_SHOTS) await capture(mobile, shot.name, theme, MOBILE, shot.ready, shot.act);
    await mobile.close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(
  images
    .map((image) => `${image.file} · ${image.kb} Ko · q${image.quality}${image.ok ? "" : " · TROP LOURD"}`)
    .join("\n"),
);
console.log("");
console.log(results.join("\n"));
process.exit(results.some((line) => line.startsWith("FAIL")) ? 1 : 0);
