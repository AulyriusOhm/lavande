#!/usr/bin/env node
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import path from "node:path";

const CHROMIUM =
  process.env.CHROMIUM_PATH ??
  path.join(process.env.HOME ?? "", ".cache/ms-playwright/chromium-1254/chrome-linux64/chrome");
const URL =
  process.env.PREVIEW_URL ?? "http://127.0.0.1:1420/scripts/mail-mobile-preview.html";

const root = path.resolve(import.meta.dirname, "..");
const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });

const failures = [];
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label} — ${detail}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${label} — ${detail}`);
};

const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(URL, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === 5, undefined, { timeout: 20_000 });
  await page.evaluate(() => new Promise((done) => setTimeout(done, 300)));

  const measurements = await page.evaluate(() => window.__measurements);
  for (const m of measurements) {
    console.log(
      `MEASURE ${m.id}: clientWidth=${m.clientWidth} scrollWidth avant=${m.before} après=${m.after} débordement avant=${m.overflowBefore} après=${m.overflowAfter} body=${m.bodyWidth} html=${m.rootWidth} cellule=${m.cellWidth} table=${m.tableWidth} td[width]=${m.tdWidthAttribute} préheader=${m.preheaderWidth}/${m.preheaderMinWidth} bouton=${m.buttonBackground} lien=${m.linkColor} titre=${m.titleFont}`,
    );
  }

  const mobile = measurements.find((m) => m.id === "mobile");
  const nofit = measurements.find((m) => m.id === "mobile-nofit");
  const desktop = measurements.find((m) => m.id === "desktop");
  const desktopLegacy = measurements.find((m) => m.id === "desktop-legacy");
  const legacy = measurements.find((m) => m.id === "legacy");

  check(
    "défaut reproduit par l'ancienne feuille",
    legacy.overflowBefore > 0,
    `débordement=${legacy.overflowBefore}px (scrollWidth=${legacy.before} > clientWidth=${legacy.clientWidth})`,
  );
  check(
    "défaut reproduit par une largeur inline !important (feuille mobile seule)",
    nofit.overflowAfter > 0,
    `débordement=${nofit.overflowAfter}px (préheader=${nofit.preheaderWidth}/${nofit.preheaderMinWidth})`,
  );
  check(
    "mobile: aucun débordement horizontal",
    mobile.after <= mobile.clientWidth,
    `scrollWidth=${mobile.after} <= clientWidth=${mobile.clientWidth} (sans correctif : ${nofit.after})`,
  );
  check(
    "mobile: contraintes du mail neutralisées",
    mobile.tdWidthAttribute === "100%" &&
      mobile.tableWidth === `${mobile.clientWidth}px` &&
      mobile.preheaderMinWidth === "0px" &&
      Number.parseFloat(mobile.preheaderWidth) <= mobile.clientWidth,
    `td[width]=${mobile.tdWidthAttribute} table=${mobile.tableWidth} préheader=${mobile.preheaderWidth}/${mobile.preheaderMinWidth}`,
  );
  check(
    "mobile: identité du mail conservée",
    mobile.buttonBackground === "rgb(225, 48, 108)" &&
      mobile.linkColor === "rgb(225, 48, 108)" &&
      mobile.titleFont.startsWith("Georgia"),
    `bouton=${mobile.buttonBackground} lien=${mobile.linkColor} titre=${mobile.titleFont}`,
  );
  const layout = ["bodyWidth", "rootWidth", "tableWidth", "cellWidth", "preheaderWidth", "preheaderMinWidth"];
  check(
    "desktop: mise en page d'origine intacte",
    desktop.bodyWidth === "600px" &&
      desktop.tdWidthAttribute === "600" &&
      desktop.overflowAfter === 0 &&
      layout.every((key) => desktop[key] === desktopLegacy[key]),
    `body=${desktop.bodyWidth} table=${desktop.tableWidth} cellule=${desktop.cellWidth} td[width]=${desktop.tdWidthAttribute} préheader=${desktop.preheaderWidth} débordement=${desktop.overflowAfter} — identique à l'ancienne feuille : ${layout.every((key) => desktop[key] === desktopLegacy[key])}`,
  );

  const componentState = () =>
    page.evaluate(() => {
      const frame = document.querySelector("#component iframe");
      const doc = frame?.contentDocument;
      if (!frame || !doc?.body) return null;
      const cell = doc.querySelector("td[width]");
      return {
        clientWidth: frame.clientWidth,
        scrollWidth: doc.documentElement.scrollWidth,
        bodyWidth: getComputedStyle(doc.body).width,
        tdWidth: cell?.getAttribute("width") ?? null,
      };
    });
  const fitted = () =>
    document.querySelector("#component iframe")?.contentDocument?.querySelector("td[width]")?.getAttribute("width") === "100%";
  await page.waitForFunction(fitted, undefined, { timeout: 20_000 });
  const narrow = await componentState();
  check(
    "composant MailBody: cadre étroit sans débordement",
    narrow.scrollWidth <= narrow.clientWidth,
    `scrollWidth=${narrow.scrollWidth} <= clientWidth=${narrow.clientWidth}`,
  );
  await page.evaluate(() => {
    document.getElementById("component").style.width = "900px";
  });
  await page.waitForFunction(
    () => {
      const doc = document.querySelector("#component iframe")?.contentDocument;
      return doc?.body ? getComputedStyle(doc.body).width === "600px" : false;
    },
    undefined,
    { timeout: 20_000 },
  );
  const wide = await componentState();
  check(
    "composant MailBody: repasse >720px, mise en page d'origine restaurée",
    wide.bodyWidth === "600px" && wide.tdWidth === "600" && wide.scrollWidth <= wide.clientWidth,
    `body=${wide.bodyWidth} td[width]=${wide.tdWidth} débordement=${wide.scrollWidth - wide.clientWidth}`,
  );
  await page.evaluate(() => {
    document.getElementById("component").style.width = "360px";
  });
  await page.waitForFunction(fitted, undefined, { timeout: 20_000 });
  const narrowAgain = await componentState();
  check(
    "composant MailBody: retour étroit, re-neutralisation sans débordement",
    narrowAgain.scrollWidth <= narrowAgain.clientWidth,
    `scrollWidth=${narrowAgain.scrollWidth} <= clientWidth=${narrowAgain.clientWidth}`,
  );

  await page.locator("#mobile").screenshot({ path: path.join(artifacts, "mail-mobile-after.png") });
  await page.locator("#desktop").screenshot({ path: path.join(artifacts, "mail-desktop-after.png") });
  await page.locator("#legacy").screenshot({ path: path.join(artifacts, "mail-mobile-before.png") });

  check("page sans erreur console", errors.length === 0, errors.join(" | ") || "aucune");
} finally {
  await browser.close();
}

console.log(
  `\n${failures.length === 0 ? "PASS" : "FAIL"} ${
    failures.length === 0 ? "tout est vert" : `${failures.length} échec(s)`
  }`,
);
for (const failure of failures) console.log(`  - ${failure}`);
if (failures.length > 0) process.exitCode = 1;
