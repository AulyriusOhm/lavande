// Scénarios E2E de la coquille mobile (`/?app`, PhoneApp) contre le démon et
// GreenMail. Même contrat que desktop.mjs : { page, baseUrl, api, token, seed,
// check }, arrêt au premier échec. La page est un contexte tactile 390×844.

import { accountId, disablePgp, folderThreads, inboxMessageBody, messageBody, syncAccount } from "./lib.mjs";

const ACCOUNT_EMAIL = "roman@lavande.test";

// Ligne de la boîte : le wrapper porte data-mail-row, l'enfant est un div
// role="button" (pas un <button>, contrairement au PC).
const row = (page, subject) =>
  page.locator(`[data-mail-row] [role="button"][aria-label*="${subject}"]`).first();
const messageHeading = (page, subject) => page.getByRole("heading", { name: subject });
const back = (page) => page.getByLabel("Retour", { exact: true });
const actionSheet = (page) => page.getByRole("dialog", { name: "Actions du message" });
const composeTo = (page) => page.locator("#compose-to");
const composeSubject = (page) => page.locator("#compose-subject");
const composeBody = (page) => page.locator(".rich-editor [contenteditable='true']");
const expandSummary = (page) => page.locator('[aria-label^="Réafficher le "]');

/**
 * « Ouvrir les dossiers » existe deux fois : dans l'en-tête (replié au bout de
 * deux secondes) et dans la barre compacte. `:visible` garde le bouton réellement
 * cliquable — l'en-tête replié a une hauteur nulle.
 */
const foldersButton = (page) =>
  page.locator('[aria-label="Ouvrir les dossiers"]:visible').first();

/** Ramène la coquille sur la réception : onglet puis dossier, quel que soit l'état laissé. */
async function gotoInbox(page) {
  await page.getByRole("button", { name: "Boîte", exact: true }).click();
  // Les deux boutons « Ouvrir les dossiers » (en-tête et barre compacte) ouvrent
  // la même feuille ; pendant l'animation de repli le hit-test est instable.
  await foldersButton(page).dispatchEvent("click");
  await page.getByRole("button", { name: /^Boîte de réception/ }).click();
}

/**
 * Le bouton de synchro ne vit que dans l'en-tête : la carte résumé le rouvre.
 * Son libellé devient « Synchronisation en cours » pendant la synchro de fond
 * (et peut y rester bloqué, drapeau `syncing` jamais relâché) : on attend le
 * repos, sinon synchro par l'API du démon et rechargement.
 */
async function syncInbox(page, api) {
  await expandSummary(page).dispatchEvent("click");
  const idle = page.getByLabel("Synchroniser le dossier");
  try {
    await idle.waitFor({ timeout: 15_000 });
    await idle.click();
  } catch {
    await syncAccount(api, ACCOUNT_EMAIL);
    await page.reload({ waitUntil: "domcontentloaded" });
    await gotoInbox(page);
  }
}

/** Appui long : 500 ms côté composant, doigt immobile, hors des boutons internes. */
async function longPress(page, line) {
  // hover attend la stabilité de la ligne (animation d'entrée BlurFade) : un
  // boundingBox lu trop tôt pointerait à côté de la ligne qui se translate.
  await line.hover();
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
}

async function opacityOf(locator) {
  return Number(await locator.evaluate((element) => getComputedStyle(element).opacity));
}

/**
 * La carte résumé se replie toute seule deux secondes après l'arrivée : ses deux
 * chevrons portent l'état (opacité animée), pas une classe.
 */
async function waitSummary(page, selector, open) {
  await page.waitForFunction(
    ({ selector, open }) => {
      const button = document.querySelector(selector);
      if (!button) return false;
      const opacity = Number(getComputedStyle(button).opacity);
      return open ? opacity > 0.9 : opacity < 0.1;
    },
    { selector, open },
    { timeout: 30_000 },
  );
}

// 1. Réception mobile : la coquille s'ouvre sur la liste (phase ready, pas de
// ConnectScreen), un mail relevé par la synchro s'ouvre au clic simple et
// « Retour » ramène à la liste.
export async function mobileInboxRead({ page, baseUrl, api, seed, check }) {
  const subject = "[e2e-mobile-read] Message de la boîte";
  const body = "Corps e2e-mobile-read lu depuis la coquille mobile.";

  if (
    !(await check("mobile : la réception s'affiche sans écran de connexion", async () => {
      await page.goto(`${baseUrl}/?app`, { waitUntil: "domcontentloaded" });
      // Plusieurs comptes connectés : l'atterrissage api est la Boîte unifiée.
      // Le hero (et son h1) se replie seul après 2 s : le heading reste dans le DOM.
      await page
        .getByRole("heading", { name: /Boîte/ })
        .waitFor({ state: "attached", timeout: 90_000 });
      if ((await page.locator("#connect-email").count()) > 0) throw new Error("ConnectScreen affiché");
      await gotoInbox(page);
      await page.locator("[data-mail-row]").first().waitFor({ timeout: 90_000 });
      return `${await page.locator("[data-mail-row]").count()} conversations déjà en boîte`;
    }))
  ) {
    return;
  }

  if (
    !(await check("mobile : le mail seedé est relevé par la synchro", async () => {
      await seed(subject, body);
      await syncInbox(page, api);
      await row(page, subject).waitFor({ timeout: 90_000 });
      return `${subject} · ${await row(page, subject).getAttribute("aria-label")}`;
    }))
  ) {
    return;
  }

  if (
    !(await check("mobile : le clic simple ouvre le message et son corps", async () => {
      await row(page, subject).click();
      await messageHeading(page, subject).waitFor({ timeout: 60_000 });
      await page.getByText(body).last().waitFor({ timeout: 60_000 });
      return body;
    }))
  ) {
    return;
  }

  await check("mobile : « Retour » ramène à la liste de réception", async () => {
    await back(page).click();
    await back(page).waitFor({ state: "detached", timeout: 30_000 });
    await row(page, subject).waitFor({ timeout: 30_000 });
    return "liste de réception";
  });
}

// 2. Réponse depuis le message : la rédaction s'ouvre en écran inline,
// préremplie, l'envoi part par le démon et la réponse rejoint le fil en boîte.
export async function mobileReplySend({ page, api, seed, check }) {
  const subject = "[e2e-mobile-reply] Question du fil";
  const original = "Corps original du fil e2e-mobile-reply.";
  const answer = "Reponse e2e-mobile-reply tapee dans la redaction mobile.";

  if (
    !(await check("réponse mobile : mail seedé et relevé", async () => {
      await gotoInbox(page);
      await seed(subject, original);
      await syncInbox(page, api);
      await row(page, subject).waitFor({ timeout: 90_000 });
      return subject;
    }))
  ) {
    return;
  }

  if (
    !(await check("réponse mobile : le message ouvre son corps", async () => {
      await row(page, subject).click();
      await messageHeading(page, subject).waitFor({ timeout: 60_000 });
      await page.getByText(original).last().waitFor({ timeout: 60_000 });
      return original;
    }))
  ) {
    return;
  }

  if (
    !(await check("réponse mobile : « Répondre » ouvre la rédaction préremplie", async () => {
      // Deux boutons « Répondre » : l'icône de l'expéditeur puis la barre du bas.
      await page.getByRole("button", { name: "Répondre", exact: true }).last().click();
      await composeTo(page).waitFor({ timeout: 30_000 });
      const to = await composeTo(page).inputValue();
      if (to !== ACCOUNT_EMAIL) throw new Error(`destinataire « ${to} » au lieu de ${ACCOUNT_EMAIL}`);
      const composed = await composeSubject(page).inputValue();
      if (!composed.startsWith("Re:")) throw new Error(`objet « ${composed} » sans préfixe Re:`);
      return `${to} · ${composed}`;
    }))
  ) {
    return;
  }

  if (
    !(await check("réponse mobile : PGP coupé à l'envoi (aucune clé sur ce compte)", async () => {
      const states = await disablePgp(page);
      if (states.includes("true")) throw new Error(`interrupteur resté actif : ${states}`);
      return states;
    }))
  ) {
    return;
  }

  if (
    !(await check("réponse mobile : corps saisi puis envoi, la rédaction se referme", async () => {
      await composeBody(page).click();
      await page.keyboard.type(answer);
      await page.getByLabel("Envoyer le message").click();
      await composeTo(page).waitFor({ state: "detached", timeout: 60_000 });
      return answer;
    }))
  ) {
    return;
  }

  await check("réponse mobile : la réponse rejoint le fil dans la boîte", async () => {
    await back(page).click();
    await back(page).waitFor({ state: "detached", timeout: 30_000 });
    await syncInbox(page, api);
    const thread = page
      .locator(`[data-mail-row] [role="button"][aria-label*="${subject}"][aria-label*="2 messages"]`)
      .first();
    await thread.waitFor({ timeout: 90_000 });
    const id = await accountId(api, ACCOUNT_EMAIL);
    const threads = await folderThreads(api, id, "INBOX");
    const found = threads.find((entry) =>
      entry.messages.some((message) => message.subject.includes(subject)),
    );
    if (!found) throw new Error(`« ${subject} » absent de INBOX`);
    if (found.messages.length !== 2) {
      throw new Error(`fil de ${found.messages.length} message(s) au lieu de 2`);
    }
    const reply = found.messages.find((message) => /^Re:/.test(message.subject));
    if (!reply) {
      throw new Error(`fil sans réponse : ${found.messages.map((m) => m.subject).join(" · ")}`);
    }
    const content = await messageBody(api, id, reply.folder_path, reply.uid);
    if (!content.includes("e2e-mobile-reply tapee")) {
      throw new Error(`corps reçu « ${content.slice(0, 120)} »`);
    }
    return `${reply.subject} · ${found.messages.length} messages`;
  });
}

// 3. Appui long : la feuille d'actions mobile s'ouvre, « Archiver » sort le mail
// de la réception et le dépose dans Archives ; un clic simple, lui, ouvre
// toujours le message.
export async function mobileLongPressArchive({ page, api, seed, check }) {
  const subject = "[e2e-mobile-archive] A archiver";
  const body = "Corps e2e-mobile-archive archive par appui long.";

  if (
    !(await check("appui long : mail seedé et relevé", async () => {
      await gotoInbox(page);
      await seed(subject, body);
      await syncInbox(page, api);
      await row(page, subject).waitFor({ timeout: 90_000 });
      return subject;
    }))
  ) {
    return;
  }

  if (
    !(await check("appui long : le clic simple ouvre le message, sans feuille", async () => {
      await row(page, subject).click();
      await messageHeading(page, subject).waitFor({ timeout: 60_000 });
      if ((await actionSheet(page).count()) > 0) {
        throw new Error("feuille d'actions ouverte par un clic simple");
      }
      await back(page).click();
      await back(page).waitFor({ state: "detached", timeout: 30_000 });
      return "message ouvert puis refermé";
    }))
  ) {
    return;
  }

  if (
    !(await check("appui long : 650 ms ouvrent la feuille d'actions", async () => {
      await longPress(page, row(page, subject));
      await actionSheet(page).waitFor({ timeout: 30_000 });
      const items = await actionSheet(page).getByRole("menuitem").count();
      if (items === 0) throw new Error("feuille sans action");
      return `${items} actions`;
    }))
  ) {
    return;
  }

  if (
    !(await check("appui long : « Archiver » retire le mail de la réception", async () => {
      await actionSheet(page).getByRole("menuitem", { name: "Archiver", exact: true }).click();
      await row(page, subject).waitFor({ state: "detached", timeout: 60_000 });
      return "mail archivé";
    }))
  ) {
    return;
  }

  await check("appui long : le mail est dans Archives", async () => {
    await foldersButton(page).dispatchEvent("click");
    await page.getByRole("button", { name: /^Archives/ }).click();
    await row(page, subject).waitFor({ timeout: 90_000 });
    return "Archives";
  });
}

// 4. Nouveau message depuis le bouton flottant du dock : destinataire, objet et
// corps saisis à la main, envoi par le démon, message relevé dans la boîte.
export async function mobileComposeSend({ page, api, check }) {
  const subject = "[e2e-mobile-compose] Message neuf";
  const body = "Corps e2e-mobile-compose ecrit dans la redaction mobile.";

  if (
    !(await check("rédaction mobile : le FAB « Nouveau message » ouvre un brouillon vide", async () => {
      await gotoInbox(page);
      await page.getByLabel("Nouveau message").click();
      await composeTo(page).waitFor({ timeout: 30_000 });
      const to = await composeTo(page).inputValue();
      const composed = await composeSubject(page).inputValue();
      if (to !== "" || composed !== "") {
        throw new Error(`brouillon non vide : « ${to} » / « ${composed} »`);
      }
      return "destinataire et objet vides";
    }))
  ) {
    return;
  }

  if (
    !(await check("rédaction mobile : destinataire, objet et corps saisis", async () => {
      await composeTo(page).fill(ACCOUNT_EMAIL);
      await composeSubject(page).fill(subject);
      const states = await disablePgp(page);
      if (states.includes("true")) throw new Error(`interrupteur resté actif : ${states}`);
      await composeBody(page).click();
      await page.keyboard.type(body);
      return `${ACCOUNT_EMAIL} · ${subject}`;
    }))
  ) {
    return;
  }

  if (
    !(await check("rédaction mobile : envoi, la rédaction se referme", async () => {
      await page.getByLabel("Envoyer le message").click();
      await composeTo(page).waitFor({ state: "detached", timeout: 60_000 });
      return "rédaction fermée";
    }))
  ) {
    return;
  }

  await check("rédaction mobile : le message envoyé arrive dans la boîte", async () => {
    await syncInbox(page, api);
    await row(page, subject).waitFor({ timeout: 90_000 });
    const { uid, content } = await inboxMessageBody(api, ACCOUNT_EMAIL, subject);
    if (!content.includes("e2e-mobile-compose ecrit")) {
      throw new Error(`corps reçu « ${content.slice(0, 120)} »`);
    }
    return `${subject} · uid ${uid}`;
  });
}

// 5. Réglages mobile : navigation par groupes, choix « Tout dans le même mail »
// dans Apparence, conservé après rechargement de la page.
export async function mobileSettingsPersistence({ page, check }) {
  const settingsTab = page.getByRole("button", { name: "Réglages", exact: true });
  const appearance = page.getByRole("button", { name: /^Apparence/ });
  const tidy = page.getByRole("button", { name: "Bien rangé", exact: true });
  const sameMail = page.getByRole("button", { name: "Tout dans le même mail", exact: true });

  if (
    !(await check("réglages mobile : le dock ouvre les réglages puis Apparence", async () => {
      await settingsTab.click();
      await appearance.click();
      // Le retour n'existe qu'une fois le groupe ouvert (navigation en profondeur).
      await page.getByLabel("Retour aux réglages").waitFor({ timeout: 30_000 });
      await page.getByText("Affichage des conversations").waitFor({ timeout: 30_000 });
      return "groupe Apparence ouvert";
    }))
  ) {
    return;
  }

  if (
    !(await check("réglages mobile : « Tout dans le même mail » est retenu", async () => {
      await sameMail.click();
      if ((await sameMail.getAttribute("aria-pressed")) !== "true") {
        throw new Error("option non sélectionnée");
      }
      if ((await tidy.getAttribute("aria-pressed")) !== "false") {
        throw new Error("« Bien rangé » encore sélectionné");
      }
      return "threadView = inline";
    }))
  ) {
    return;
  }

  await check("réglages mobile : le choix survit au rechargement", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", { name: /Boîte/ })
      .waitFor({ state: "attached", timeout: 90_000 });
    await settingsTab.click();
    await appearance.click();
    await page.getByLabel("Retour aux réglages").waitFor({ timeout: 30_000 });
    const pressed = await sameMail.getAttribute("aria-pressed");
    if (pressed !== "true") {
      throw new Error(`« Tout dans le même mail » aria-pressed=${pressed} après rechargement`);
    }
    if ((await tidy.getAttribute("aria-pressed")) !== "false") {
      throw new Error("« Bien rangé » resélectionné");
    }
    return "inline conservé";
  });
}

// 6. Carte résumé de la réception : badge de source « local » (aucun LLM en
// E2E), repli automatique deux secondes après l'arrivée, dépliage et repli
// manuels. Les états ne se lisent qu'à l'opacité animée des deux chevrons.
export async function mobileSummaryCard({ page, check }) {
  const badge = page.locator('[data-testid="summary-source-mobile"]');
  const cardBody = badge.locator("xpath=../..");
  const collapse = page.getByLabel("Réduire le résumé", { exact: true });

  if (
    !(await check("résumé mobile : carte et badge « local » en boîte de réception", async () => {
      await gotoInbox(page);
      await badge.waitFor({ timeout: 60_000 });
      const source = (await badge.innerText()).trim();
      if (source !== "local") throw new Error(`badge « ${source} » au lieu de « local »`);
      const text = await cardBody.innerText();
      if (!text.includes("sur la période")) throw new Error(`résumé inattendu : « ${text.slice(0, 120)} »`);
      return `${source} · ${text.split("\n").slice(0, 2).join(" · ")}`;
    }))
  ) {
    return;
  }

  if (
    !(await check("résumé mobile : la carte se replie deux secondes après l'arrivée", async () => {
      await waitSummary(page, '[aria-label^="Réafficher le "]', true);
      const body = await opacityOf(cardBody);
      if (body > 0.1) throw new Error(`corps encore visible (opacité ${body})`);
      return `replié · corps opacité ${body}`;
    }))
  ) {
    return;
  }

  if (
    !(await check("résumé mobile : déplier ramène le texte", async () => {
      await expandSummary(page).click();
      await waitSummary(page, '[aria-label="Réduire le résumé"]', true);
      const body = await opacityOf(cardBody);
      if (body < 0.9) throw new Error(`corps masqué (opacité ${body})`);
      const text = await cardBody.innerText();
      if (!text.includes("sur la période")) throw new Error(`résumé absent : « ${text.slice(0, 120)} »`);
      return `déplié · corps opacité ${body}`;
    }))
  ) {
    return;
  }

  await check("résumé mobile : « Réduire le résumé » replie la carte", async () => {
    // La hauteur de la carte est animée : le hit-test du bouton absolute est
    // instable, le handler collapse est certain.
    await collapse.dispatchEvent("click");
    await waitSummary(page, '[aria-label^="Réafficher le "]', true);
    const body = await opacityOf(cardBody);
    if (body > 0.1) throw new Error(`corps encore visible (opacité ${body})`);
    return `replié · corps opacité ${body}`;
  });
}
