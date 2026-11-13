import { chromium } from "playwright-core";
import { createServer } from "vite";
import { mkdirSync } from "node:fs";

process.env.VITE_MAIL_BACKEND = "demo";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` · ${detail}` : ""}`);
  return ok;
};

mkdirSync("artifacts", { recursive: true });

const server = await createServer({
  configFile: "vite.config.ts",
  root: process.cwd(),
  cacheDir: "/tmp/lavande-vite-11",
  server: { host: "127.0.0.1", port: 1425, strictPort: true },
});
await server.listen();
const base = "http://127.0.0.1:1425";

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome`,
  env: {
    ...process.env,
    LD_LIBRARY_PATH: "/tmp/chromedeps/root/usr/lib/x86_64-linux-gnu",
    FONTCONFIG_FILE: "/tmp/chromedeps/fonts.conf",
  },
});

const seed = async (page) => {
  await page.evaluate(() => {
    window.localStorage.setItem(
      "lavande.calendars.v1",
      JSON.stringify([
        { id: "pro", name: "Pro", tone: 0 },
        { id: "perso", name: "Perso", tone: 2 },
        { id: "travail", name: "Travail", tone: 1, source: { kind: "caldav", sourceId: "travail" } },
        { id: "exemple-tld", name: "exemple.tld", tone: 3, source: { kind: "ics", url: "https://exemple.tld/calendrier.ics" } },
        { id: "vacances", name: "Vacances", tone: 4, source: { kind: "ics" } },
      ]),
    );
    window.localStorage.setItem(
      "lavande.ics.v1",
      JSON.stringify({
        events: {
          travail: [
            { id: "caldav:travail:a1", date: "2026-03-15", start: "09:00", end: "10:00", title: "Réunion", calendar: "Travail", external: true },
            { id: "caldav:travail:a2", date: "2026-03-16", start: "14:00", end: "15:00", title: "Point", calendar: "Travail", external: true },
          ],
          "exemple-tld": [
            { id: "ics:exemple-tld:b1", date: "2026-03-20", start: "", end: "", title: "Journée off", calendar: "exemple.tld", external: true },
          ],
          vacances: [
            { id: "ics:vacances:c1", date: "2026-08-01", start: "", end: "", title: "Congés", calendar: "Vacances", external: true },
          ],
        },
        synced: { travail: Date.now(), "exemple-tld": Date.now() },
      }),
    );
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ perimeters: { perso: { mails: true, calendar: false, contacts: false } } }),
    );
  });
};

try {
  // ---- Mobile
  const mobile = await browser.newContext({ viewport: { width: 412, height: 940 }, deviceScaleFactor: 2 });
  const page = await mobile.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(base, { waitUntil: "networkidle" });
  await seed(page);
  await page.reload({ waitUntil: "networkidle" });

  await page.getByRole("tab", { name: /Réglages|Reglages/ }).click().catch(async () => {
    await page.getByLabel(/Réglages/).click();
  });
  await page.getByRole("button", { name: /^Synchronisation Appareils/ }).click();
  await page.getByTestId("calendar-source-vacances").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);

  check(
    "mobile · la section Calendriers affiche les sources et leurs types",
    (await page.getByTestId("calendar-source-travail").isVisible()) &&
      (await page.getByTestId("calendar-source-vacances").isVisible()),
  );
  check(
    "mobile · badge de type et compte d'événements",
    (await page.getByTestId("calendar-source-travail").innerText()).includes("CalDAV") &&
      (await page.getByTestId("calendar-source-travail").innerText()).includes("2 événements"),
  );
  const tabs = page.getByRole("group", { name: "Type de source" });
  check(
    "mobile · les trois formulaires ICS / CalDAV / Google sont proposés",
    (await tabs.getByRole("button").count()) === 3 &&
      (await tabs.getByRole("button", { name: "CalDAV" }).count()) === 1 &&
      (await tabs.getByRole("button", { name: "Google" }).count()) === 1,
  );
  check(
    "mobile · actions par source : actualiser, renommer, supprimer",
    (await page.getByRole("button", { name: "Actualiser le calendrier Travail" }).count()) === 1 &&
      (await page.getByRole("button", { name: "Renommer le calendrier Travail" }).count()) === 1 &&
      (await page.getByRole("button", { name: "Supprimer le calendrier Travail" }).count()) === 1,
  );
  await page.screenshot({ path: "artifacts/11-mobile-calendars.png", fullPage: false });

  await page.getByRole("button", { name: "Retour aux réglages" }).click();
  await page.getByRole("button", { name: /^Comptes Boîtes mail/ }).click();
  await page.getByRole("heading", { name: "Périmètre de synchronisation" }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  check(
    "mobile · périmètre par compte : mails, agenda, contacts honnêtes",
    (await page.getByText("Contacts : bientôt disponible").count()) > 0 &&
      (await page.getByRole("switch", { name: /^Contacts/ }).count()) === 0 &&
      (await page.getByRole("switch", { name: /^Mails/ }).count()) > 0,
  );
  await page.screenshot({ path: "artifacts/11-account-perimeter.png", fullPage: false });
  check("mobile · aucune erreur JS", errors.length === 0, errors.join(" | "));
  await mobile.close();

  // ---- Desktop
  const desk = await browser.newContext({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 1 });
  const dpage = await desk.newPage();
  const derrors = [];
  dpage.on("pageerror", (error) => derrors.push(String(error)));
  await dpage.goto(`${base}/?desktop`, { waitUntil: "networkidle" });
  await seed(dpage);
  await dpage.reload({ waitUntil: "networkidle" });

  await dpage.getByRole("button", { name: /^Réglages|Réglages/ }).first().click();
  await dpage.getByRole("button", { name: "Calendriers" }).first().click();
  await dpage.waitForTimeout(600);

  const section = dpage.locator("#reglages-calendriers");
  await section.scrollIntoViewIfNeeded();
  await section.getByText("Travail", { exact: true }).first().waitFor();
  check(
    "PC · section Calendriers : sources, badges et compteurs",
    (await section.innerText()).includes("CalDAV") &&
      (await section.innerText()).includes("ICS") &&
      (await section.innerText()).includes("2 événements"),
  );
  check(
    "PC · relecture et gestion par source",
    (await dpage.getByRole("button", { name: "Actualiser le calendrier Travail" }).count()) >= 1 &&
      (await dpage.getByRole("button", { name: "Renommer le calendrier Travail" }).count()) >= 1 &&
      (await dpage.getByRole("button", { name: "Supprimer le calendrier Travail" }).count()) >= 1,
  );
  check(
    "PC · entrée « connecter un compte Google »",
    (await dpage.getByRole("button", { name: "Connecter un compte Google" }).count()) === 1,
  );
  await dpage.screenshot({ path: "artifacts/11-desktop-calendars.png", fullPage: false });

  check("PC · aucune erreur JS", derrors.length === 0, derrors.join(" | "));
  await desk.close();
} finally {
  await browser.close();
  await server.close();
}

console.log(results.join("\n"));
process.exit(results.some((line) => line.startsWith("FAIL")) ? 1 : 0);
