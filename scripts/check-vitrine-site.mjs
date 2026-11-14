// Audit du site vitrine (site-vitrine/dist) : requêtes same-origin, console propre,
// thème persisté + synchro de la démo, bascule PC/téléphone, ancres, responsive,
// liens de téléchargement. Usage : node scripts/check-vitrine-site.mjs
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const PORT = 4180;
const base = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` · ${detail}` : ""}`);
  return ok;
};

mkdirSync("artifacts", { recursive: true });

const server = spawn(
  "python3",
  ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", "site-vitrine/dist"],
  { stdio: "ignore" },
);

const waitServer = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/`);
      if (response.ok) return;
    } catch {
      /* pas encore prêt */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("serveur local indisponible");
};
await waitServer();

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome`,
  env: {
    ...process.env,
    LD_LIBRARY_PATH: "/tmp/chromedeps/root/usr/lib/x86_64-linux-gnu",
    FONTCONFIG_FILE: "/tmp/chromedeps/fonts.conf",
  },
});

const requests = [];
const consoleErrors = [];
const hosts = new Set();

async function demoFrame(page, query) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const frame = page.frames().find((f) => f.url().includes("/demo/") && f.url().includes(query));
    if (frame) {
      const count = await frame
        .locator("[data-demo-readonly]")
        .count()
        .catch(() => 0);
      if (count === 1) return frame;
    }
    await page.waitForTimeout(100);
  }
  return null;
}

const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on("request", (request) => {
  const url = request.url();
  requests.push(url);
  try {
    hosts.add(new URL(url).host);
  } catch {
    hosts.add("(non-URL)");
  }
});
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

await page.goto(`${base}/`, { waitUntil: "load" });

const darkFrame = await demoFrame(page, "?desktop");
check("démo PC chargée (section essayer)", darkFrame !== null, darkFrame ? darkFrame.url() : "absente");

const themeState = await page.evaluate(() => ({
  theme: document.documentElement.getAttribute("data-theme"),
  site: localStorage.getItem("lavande.site.theme"),
  demo: localStorage.getItem("lavande.theme"),
}));
check("thème sombre par défaut", themeState.theme === "dark", `data-theme=${themeState.theme}`);
check(
  "clé démo synchronisée au chargement",
  themeState.demo !== null && JSON.parse(themeState.demo).mode === "dark",
  themeState.demo ?? "absente",
);

const shotState = await page.evaluate(() => {
  const dark = document.querySelector(".shot-dark");
  const light = document.querySelector(".shot-light");
  return {
    dark: dark ? getComputedStyle(dark).display : "absent",
    light: light ? getComputedStyle(light).display : "absent",
  };
});
check("captures desktop visibles en sombre", shotState.dark !== "none" && shotState.light === "none", JSON.stringify(shotState));

const iframeDark = await darkFrame.evaluate(() => document.documentElement.classList.contains("dark"));
check("iframe en thème sombre", iframeDark === true, `class dark=${iframeDark}`);

await page.getByRole("button", { name: /Passer en thème clair/i }).click();
await page.waitForTimeout(600);

const lightFrame = await demoFrame(page, "?desktop");
const afterLight = await page.evaluate(() => ({
  theme: document.documentElement.getAttribute("data-theme"),
  site: localStorage.getItem("lavande.site.theme"),
  demo: localStorage.getItem("lavande.theme"),
  shotDark: getComputedStyle(document.querySelector(".shot-dark")).display,
  shotLight: getComputedStyle(document.querySelector(".shot-light")).display,
  meta: document.querySelector('meta[name="theme-color"]').getAttribute("content"),
}));
check("bascule en thème clair", afterLight.theme === "light", `data-theme=${afterLight.theme}`);
check("thème clair persisté (site)", afterLight.site === "light", `lavande.site.theme=${afterLight.site}`);
check(
  "clé démo mise à jour",
  JSON.parse(afterLight.demo).mode === "light",
  afterLight.demo,
);
check(
  "captures basculent en clair",
  afterLight.shotDark === "none" && afterLight.shotLight !== "none",
  JSON.stringify({ dark: afterLight.shotDark, light: afterLight.shotLight }),
);
check("meta theme-color clair", afterLight.meta === "#fbfaff", afterLight.meta);
const iframeLight = lightFrame ? await lightFrame.evaluate(() => document.documentElement.classList.contains("dark")) : null;
check("iframe rechargée en clair", iframeLight === false, `class dark=${iframeLight}`);

await page.reload({ waitUntil: "load" });
const persisted = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
check("thème clair conservé après rechargement", persisted === "light", `data-theme=${persisted}`);
const reloadedFrame = await demoFrame(page, "?desktop");
const reloadedIframeLight = reloadedFrame
  ? await reloadedFrame.evaluate(() => document.documentElement.classList.contains("dark"))
  : null;
check("iframe claire après rechargement", reloadedIframeLight === false, `class dark=${reloadedIframeLight}`);

await page.getByRole("button", { name: /Passer en thème sombre/i }).click();
await page.waitForTimeout(600);
const backDark = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
check("retour au thème sombre", backDark === "dark", `data-theme=${backDark}`);

await page.locator("#essayer").getByRole("button", { name: /Téléphone/i }).click();
await page.waitForTimeout(700);
const phoneFrame = await demoFrame(page, "?app");
const phoneSrc = await page.evaluate(() => document.querySelector("iframe").getAttribute("src"));
check("bascule téléphone : src de l'iframe", phoneSrc === "/demo/index.html?app", phoneSrc ?? "absente");
check("démo téléphone chargée + bandeau", phoneFrame !== null, phoneFrame ? phoneFrame.url() : "absente");
const phoneBanner = phoneFrame
  ? (await phoneFrame.locator("[data-demo-readonly]").innerText()).replace(/\s+/g, " ").trim()
  : "";
check("bandeau lecture seule (téléphone)", phoneBanner.length > 0, phoneBanner);

await page.locator("#essayer").getByRole("button", { name: /Ordinateur/i }).click();
await page.waitForTimeout(700);
const desktopAgain = await demoFrame(page, "?desktop");
const desktopSrc = await page.evaluate(() => document.querySelector("iframe").getAttribute("src"));
check("retour PC : src de l'iframe", desktopSrc === "/demo/index.html?desktop", desktopSrc ?? "absente");
const desktopBanner = desktopAgain
  ? (await desktopAgain.locator("[data-demo-readonly]").innerText()).replace(/\s+/g, " ").trim()
  : "";
check("bandeau lecture seule (PC)", desktopBanner.length > 0, desktopBanner);

const frameTitle = await page.evaluate(() => document.querySelector("iframe").getAttribute("title"));
check("iframe titrée", frameTitle === "Lavande — démo", frameTitle ?? "absente");

const links = await page.evaluate(() =>
  Array.from(document.querySelectorAll("a[href^='/updates/']")).map((a) => a.getAttribute("href")),
);
const expected = [
  "/updates/Lavande_0.2.4_amd64.AppImage.tar.gz",
  "/updates/Lavande-0.2.4-1.x86_64.rpm",
  "/updates/Lavande_0.2.4_amd64.deb",
  "/updates/Lavande_0.2.4_x64-setup.exe",
  "/updates/Lavande.apk",
  "/updates/latest.json",
  "/updates/lavande-release.asc",
];
const missing = expected.filter((href) => !links.includes(href));
check("liens de téléchargement présents", missing.length === 0, missing.length === 0 ? `${links.length} liens` : `manquants: ${missing.join(", ")}`);

const settle = async () => {
  let previous = -1;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await page.evaluate(() => window.scrollY);
    if (current === previous) return current;
    previous = current;
    await page.waitForTimeout(120);
  }
  return previous;
};

const anchors = [
  ["Fonctionnalités", "fonctionnalites", "features-title"],
  ["Démo", "essayer", "essayer-title"],
  ["Mobile", "mobile", "mobile-title"],
  ["Télécharger", "telecharger", "download-title"],
  ["Sécurité", "securite", "security-title"],
];
for (const [label, id, titleId] of anchors) {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(200);
  await page.locator(`header nav a[href="#${id}"]`).click();
  await settle();
  await page.waitForTimeout(200);
  const metrics = await page.evaluate(
    ({ sectionId, headingId }) => {
      const header = document.querySelector("header");
      const section = document.getElementById(sectionId);
      const heading = document.getElementById(headingId);
      return {
        headerBottom: header.getBoundingClientRect().bottom,
        sectionTop: section.getBoundingClientRect().top,
        headingTop: heading.getBoundingClientRect().top,
        scrollY: window.scrollY,
      };
    },
    { sectionId: id, headingId: titleId },
  );
  const atTop = metrics.scrollY <= 1;
  const landsUnder = atTop
    ? metrics.headingTop >= metrics.headerBottom - 4
    : metrics.sectionTop >= metrics.headerBottom - 4 && metrics.sectionTop <= metrics.headerBottom + 110;
  check(
    `ancre #${id} : la section atterrit sous le header`,
    landsUnder,
    `bas header=${metrics.headerBottom.toFixed(1)} haut section=${metrics.sectionTop.toFixed(1)} haut titre=${metrics.headingTop.toFixed(1)} scrollY=${metrics.scrollY.toFixed(0)}`,
  );
}

const navState = await page.evaluate(() => {
  const current = document.querySelector('header nav a[aria-current="true"]');
  return current ? current.getAttribute("href") : null;
});
check("section active suivie", navState !== null, navState ?? "aucune");

const scrollThrough = async () => {
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.7;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo({ top: y, behavior: "instant" });
      await new Promise((resolve) => setTimeout(resolve, 110));
    }
    window.scrollTo({ top: 0, behavior: "instant" });
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
};

await scrollThrough();
await page.waitForTimeout(500);
await page.screenshot({ path: "artifacts/vitrine-site-dark.png", fullPage: true });

await page.getByRole("button", { name: /Passer en thème clair/i }).click();
await scrollThrough();
await page.waitForTimeout(500);
await page.screenshot({ path: "artifacts/vitrine-site-light.png", fullPage: true });

await page.getByRole("button", { name: /Passer en thème sombre/i }).click();
await page.waitForTimeout(400);

const viewports = [
  { width: 390, height: 844, name: "mobile" },
  { width: 768, height: 1024, name: "tablette" },
  { width: 1440, height: 1000, name: "desktop" },
];

for (const viewport of viewports) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(900);
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  check(
    `pas de débordement horizontal ${viewport.name} (${viewport.width})`,
    overflow.scrollWidth <= viewport.width + 1 && overflow.bodyWidth <= viewport.width + 1,
    JSON.stringify(overflow),
  );
  if (viewport.name === "mobile") {
    const mobileSrc = await page.evaluate(() => document.querySelector("iframe").getAttribute("src"));
    check("démo en mode téléphone par défaut sur mobile", mobileSrc === "/demo/index.html?app", mobileSrc ?? "absente");
    await scrollThrough();
    await page.waitForTimeout(400);
    await page.screenshot({ path: "artifacts/vitrine-site-mobile.png", fullPage: true });
    const menuButton = page.getByRole("button", { name: /Ouvrir le menu/i });
    await menuButton.click();
    await page.waitForTimeout(500);
    const menuVisible = await page.locator("#menu-mobile").isVisible();
    check("menu mobile s'ouvre", menuVisible === true);
    await page.locator('#menu-mobile a[href="#securite"]').click();
    await page.waitForTimeout(800);
    const closed = await page.locator("#menu-mobile").count();
    check("menu mobile se referme au clic d'un lien", closed === 0, `restants=${closed}`);
  }
}

const outside = requests.filter((url) => !url.startsWith(base) && !url.startsWith("data:"));
check("aucune requête hors origine", outside.length === 0, outside.slice(0, 5).join(" | "));
check("aucune erreur console", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") || "0");

const hostList = [...hosts].join(", ");
const uniqueRequests = new Set(requests);
const localRequests = [...uniqueRequests].filter((url) => url.startsWith(base));

console.log(results.join("\n"));
console.log(`\n--- hôtes contactés (${hosts.size}) ---\n${hostList}`);
console.log(`--- requêtes (${requests.length}, ${uniqueRequests.size} uniques, ${localRequests.length} locales uniques) ---`);
console.log(localRequests.map((url) => url.replace(base, "")).sort().join("\n"));

await browser.close();
server.kill();

const failures = results.filter((line) => line.startsWith("FAIL"));
if (failures.length > 0) {
  console.log(`\n${failures.length} échec(s)`);
  process.exitCode = 1;
} else {
  console.log(`\n${results.length} vérifications vertes`);
}
