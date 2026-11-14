// Audit « démo lecture seule » : la coquille embarquée sur le site vitrine.
// Aucune requête hors des assets same-origin, aucune mutation ne prend, le
// bandeau est visible, les boutons de création ont disparu.
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { mkdirSync } from "node:fs";

process.env.VITE_MAIL_BACKEND = "demo";
process.env.VITE_DEMO_READONLY = "1";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` · ${detail}` : ""}`);
  return ok;
};

const FABS = ["Nouveau message", "Nouvelle tâche", "Nouveau rendez-vous"];

mkdirSync("artifacts", { recursive: true });

const server = await createServer({
  configFile: "vite.config.ts",
  root: process.cwd(),
  cacheDir: "/tmp/lavande-vite-demo-readonly",
  server: { host: "127.0.0.1", port: 1429, strictPort: true },
});
await server.listen();
const base = "http://127.0.0.1:1429";

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome`,
  env: {
    ...process.env,
    LD_LIBRARY_PATH: "/tmp/chromedeps/root/usr/lib/x86_64-linux-gnu",
    FONTCONFIG_FILE: "/tmp/chromedeps/fonts.conf",
  },
});

const outsideOf = (requests) =>
  requests.filter((url) => {
    const parsed = new URL(url);
    return parsed.origin !== base || parsed.pathname.startsWith("/api");
  });

const runLayout = async ({ label, url, viewport, isMobile = false, tabs, inboxTab, inboxFolder, archives }) => {
  const context = await browser.newContext({ viewport, isMobile, hasTouch: isMobile, deviceScaleFactor: isMobile ? 2 : 1 });
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(url, { waitUntil: "networkidle" });

  const banner = page.locator("[data-demo-readonly]");
  const bannerCount = await banner.count();
  check(`${label} · bandeau « Démo · lecture seule »`, bannerCount === 1,
    bannerCount === 1 ? (await banner.innerText()).replace(/\s+/g, " ").trim() : "absent");

  const fabs = await Promise.all(FABS.map((name) => page.getByRole("button", { name, exact: true }).count()));
  check(`${label} · aucun bouton de création`, fabs.every((count) => count === 0), `trouvés : ${fabs.join("/")}`);

  const rows = page.locator("[data-mail-row]");
  await rows.first().waitFor();
  const inboxCount = await rows.count();
  const ids = await rows.evaluateAll((nodes) => nodes.map((node) => node.dataset.mailRow));

  if (isMobile) {
    await page.getByRole("button", { name: "Ouvrir les dossiers" }).first().click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /^Archives/ }).first().click();
    await page.waitForTimeout(400);
    const archiveCount = await rows.count();
    await page.getByRole("button", { name: "Ouvrir les dossiers" }).first().click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /^Boîte de réception/ }).first().click();
    await page.waitForTimeout(400);
    check(`${label} · navigation par dossier`, archiveCount > 0 && (await rows.count()) === inboxCount,
      `archives=${archiveCount} boîte=${await rows.count()}`);
  } else {
    await page.getByRole("button", { name: archives }).first().click();
    await page.waitForTimeout(300);
    const archiveCount = await rows.count();
    await page.getByRole("button", { name: inboxFolder }).first().click();
    await page.waitForTimeout(300);
    check(`${label} · navigation par dossier`, archiveCount > 0 && (await rows.count()) === inboxCount,
      `archives=${archiveCount} boîte=${await rows.count()}`);
  }

  for (const tab of tabs) {
    await page.getByRole("button", { name: tab, exact: true }).first().click();
    await page.waitForTimeout(300);
    check(`${label} · onglet ${tab} navigable`, (await page.locator("[data-demo-readonly]").count()) === 1);
  }
  await page.getByRole("button", { name: inboxTab }).first().click();
  await page.waitForTimeout(400);

  await rows.first().click();
  await page.waitForTimeout(400);
  const replies = await page.getByRole("button", { name: "Répondre", exact: true }).count();
  const note = await page.getByText("Démo · lecture seule").count();
  check(`${label} · lecteur sans « Répondre » mais avec la mention`,
    replies === 0 && note > 0, `boutons=${replies} mentions=${note}`);

  await page.keyboard.press("Delete");
  await page.waitForTimeout(400);
  await page.keyboard.press("e");
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(300);
  const after = await rows.evaluateAll((nodes) => nodes.map((node) => node.dataset.mailRow));
  check(`${label} · Suppr / archive / étoile ne changent rien`,
    JSON.stringify(after) === JSON.stringify(ids), `${ids.length} → ${after.length}`);

  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const outside = outsideOf(requests);
  check(`${label} · aucune requête hors assets same-origin`, outside.length === 0,
    outside.length === 0 ? `${requests.length} requêtes, toutes locales` : outside.slice(0, 4).join(" | "));
  check(`${label} · aucune erreur JS`, errors.length === 0, errors.slice(0, 3).join(" | "));

  await page.screenshot({ path: `artifacts/demo-readonly-${label}.png` });
  await context.close();
  return requests.length;
};

const counts = {};
try {
  counts.pc = await runLayout({
    label: "pc",
    url: `${base}/?desktop`,
    viewport: { width: 1440, height: 940 },
    tabs: ["Agenda", "Planification", "Réglages"],
    inboxTab: /^Boîte\b/,
    inboxFolder: /^Boîte de réception/,
    archives: /^Archives/,
  });
  counts.mobile = await runLayout({
    label: "mobile",
    url: `${base}/?app`,
    viewport: { width: 412, height: 940 },
    isMobile: true,
    tabs: ["Agenda", "Planif.", "Réglages"],
    inboxTab: /^Boîte\b/,
    inboxFolder: /^Boîte de réception/,
    archives: /^Archives/,
  });
  check("audit réseau complet", counts.pc > 0 && counts.mobile > 0,
    `pc ${counts.pc} requêtes · mobile ${counts.mobile} requêtes · hors origine 0`);
} finally {
  await browser.close();
  await server.close();
}

console.log(results.join("\n"));
process.exit(results.some((line) => line.startsWith("FAIL")) ? 1 : 0);
