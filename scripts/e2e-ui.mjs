#!/usr/bin/env node
// Suite E2E de l'app web réelle (mode api) : GreenMail jetable, démon local sur
// port dédié et serveur Vite, puis les scénarios de scripts/e2e/. Le démon et son
// répertoire de données sont propres à la suite ; GreenMail reste en place après
// le run, ses messages sont effacés par le `reset` du run suivant.
import process from "node:process";
import {
  desktopComposeSend,
  desktopFolderActions,
  desktopReplySend,
  desktopSearch,
  desktopSettingsPersistence,
  desktopSmoke,
  desktopThread,
  desktopUnified,
} from "./e2e/desktop.mjs";
import {
  mobileComposeSend,
  mobileInboxRead,
  mobileLongPressArchive,
  mobileReplySend,
  mobileSettingsPersistence,
  mobileSummaryCard,
} from "./e2e/mobile.mjs";
import {
  apiClient,
  createFolders,
  createRunner,
  launchBrowser,
  resetGreenMail,
  seedSender,
  startDaemon,
  startVite,
} from "./e2e/lib.mjs";

const DAEMON_PORT = 8791;
const VITE_PORT = 1422;

const MAIN = { email: "roman@lavande.test", password: "secret" };
const SECOND = { email: "bob@lavande.test", password: "secret" };
// GreenMail ne publie que INBOX : les dossiers à rôle sont créés par le client.
// Bob n'a pas de dossier Envoyés : le démon n'y dépose donc pas de copie de ses
// messages, et chaque mail seedé chez lui n'existe qu'une fois.
const FOLDERS = [
  { user: MAIN, folders: ["Sent", "Trash", "Archive"] },
  { user: SECOND, folders: ["Trash"] },
];

process.env.LAVANDE_MAIL_TEST_USER2 = SECOND.email;
process.env.LAVANDE_MAIL_TEST_PASSWORD2 = SECOND.password;

let page = null;
const runner = createRunner(() => page);

// Un scénario en échec arrête la suite : l'état accumulé (comptes, mails, fils)
// n'est plus fiable pour les suivants.
const runScenarios = async (scenarios, ctx) => {
  for (const scenario of scenarios) {
    const before = runner.failures;
    await scenario(ctx);
    if (runner.failures > before) break;
  }
};

let daemon = null;
let vite = null;
let browser = null;

try {
  const ready =
    (await runner.check("greenmail : conteneur recréé", () => resetGreenMail())) &&
    (await runner.check("greenmail : dossiers à rôle créés", async () => {
      for (const entry of FOLDERS) {
        await createFolders(entry.user.email, entry.user.password, entry.folders);
      }
      return FOLDERS.map((entry) => `${entry.user.email} : ${entry.folders.join(", ")}`).join(" · ");
    })) &&
    (await runner.check("démon : jetable à l'écoute", async () => {
      daemon = await startDaemon({ port: DAEMON_PORT });
      return `${daemon.base} · données ${daemon.dataDir}`;
    })) &&
    (await runner.check("vite : app servie en mode api", async () => {
      vite = await startVite({ dataDir: daemon.dataDir, apiBase: daemon.base, port: VITE_PORT });
      return vite.baseUrl;
    }));

  if (ready) {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    page.on("pageerror", (error) => console.log(`     erreur page : ${error.message}`));

    const api = apiClient(daemon.base, daemon.token);
    const context2 = {
      page,
      baseUrl: vite.baseUrl,
      api,
      token: daemon.token,
      seed: seedSender(api),
      check: runner.check,
    };
    // Chaque scénario reprend la page et l'état laissés par le précédent.
    await runScenarios(
      [
        desktopSmoke,
        desktopReplySend,
        desktopComposeSend,
        desktopFolderActions,
        desktopSearch,
        desktopThread,
        desktopUnified,
        desktopSettingsPersistence,
      ],
      context2,
    );

    await context.close();

    if (runner.failures === 0) {
      const mobileContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
      page = await mobileContext.newPage();
      page.on("pageerror", (error) => console.log(`     erreur page : ${error.message}`));
      const mobileCtx = { ...context2, page };
      await runScenarios(
        [
          mobileInboxRead,
          mobileReplySend,
          mobileLongPressArchive,
          mobileComposeSend,
          mobileSettingsPersistence,
          mobileSummaryCard,
        ],
        mobileCtx,
      );
      await mobileContext.close();
    }
  }
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
  await daemon?.stop().catch(() => {});
}

const failed = runner.failures > 0 || Boolean(process.exitCode);
console.log("");
console.log(`${runner.checks} vérifications, ${runner.failures} échec(s) — ${failed ? "échec" : "succès"}`);
if (failed) process.exitCode = 1;
