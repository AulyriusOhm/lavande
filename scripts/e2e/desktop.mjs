// Scénarios E2E de la coquille PC (`/?desktop`) contre le démon et GreenMail.
// Chaque scénario reçoit { page, baseUrl, api, token, seed, check } et rend la
// main sur le premier échec : la suite s'arrête là où elle a cassé.

import { accountId, disablePgp, folderThreads, messageBody, syncAccount } from "./lib.mjs";

const ACCOUNT = {
  label: "E2E",
  email: "roman@lavande.test",
  username: "roman@lavande.test",
  password: "secret",
  imap: { host: "127.0.0.1", port: "3993", encryption: "tls" },
  smtp: { host: "127.0.0.1", port: "3465", encryption: "tls" },
};

const SEEDS = [
  { subject: "[e2e-smoke] Premier message", text: "Corps du premier message e2e smoke." },
  { subject: "[e2e-smoke] Second message", text: "Corps du second message e2e smoke." },
];

const SECOND_ACCOUNT = {
  label: "Bob",
  email: "bob@lavande.test",
  username: "bob@lavande.test",
  password: "secret",
};

const row = (page, subject) =>
  page.locator(`button[data-mail-row][aria-label*="${subject}"]`).first();
const reader = (page) => page.getByLabel("Panneau de lecture");
const syncButton = (page) => page.getByLabel("Synchroniser le dossier");
const railButton = (page, label) => page.getByRole("button", { name: new RegExp(`^${label}`) });
// Onglet du dock : son nom accessible porte le compteur de non-lus (« Boîte 4 »).
const dockTab = (page, label) =>
  page.getByRole("button", { name: new RegExp(`^${label}( \\d+)?$`) });
const menuItem = (page, label) =>
  page.getByRole("menuitem", { name: label, exact: true });

/** Attente d'une ligne de la liste, avec le délai que le repli lui donne. */
const waitRow = (page, subject) => (timeout) => row(page, subject).waitFor({ timeout });

/**
 * Synchro puis attente de `ready(timeout)`. Le bouton « Synchroniser » sert
 * quand il est au repos ; il peut rester bloqué sur « Synchronisation en cours »
 * (drapeau `syncing` jamais relâché quand on change de dossier pendant la
 * synchro de fond), d'où le repli sur l'API du démon et un rechargement.
 */
async function syncThen(page, api, email, ready) {
  const button = syncButton(page);
  if ((await button.count()) > 0) await button.click();
  try {
    await ready(15_000);
  } catch {
    await syncAccount(api, email);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByLabel("Ouvrir la recherche globale").waitFor({ timeout: 90_000 });
    await ready(90_000);
  }
}

/** Saisie du corps dans l'éditeur riche de la rédaction (ProseMirror). */
async function typeBody(page, compose, text) {
  await compose.locator("[contenteditable=true]").click();
  await page.keyboard.type(text);
}

export async function desktopSmoke({ page, baseUrl, seed, check }) {
  if (
    !(await check("smoke : formulaire de connexion affiché", async () => {
      await page.goto(`${baseUrl}/?desktop`, { waitUntil: "domcontentloaded" });
      await page.locator("#connect-email").waitFor({ state: "visible", timeout: 60_000 });
      return "phase empty → ConnectScreen";
    }))
  ) {
    return;
  }

  if (
    !(await check("smoke : compte GreenMail saisi", async () => {
      // Les hôtes d'abord : le blur de l'adresse déclenche une auto-découverte
      // qui écraserait les serveurs saisis à la main.
      await page.selectOption("#connect-imap-encryption", ACCOUNT.imap.encryption);
      await page.fill("#connect-imap-host", ACCOUNT.imap.host);
      await page.fill("#connect-imap-port", ACCOUNT.imap.port);
      await page.selectOption("#connect-smtp-encryption", ACCOUNT.smtp.encryption);
      await page.fill("#connect-smtp-host", ACCOUNT.smtp.host);
      await page.fill("#connect-smtp-port", ACCOUNT.smtp.port);
      await page.fill("#connect-label", ACCOUNT.label);
      await page.fill("#connect-username", ACCOUNT.username);
      await page.fill("#connect-password", ACCOUNT.password);
      await page.fill("#connect-email", ACCOUNT.email);
      return `${ACCOUNT.email} · imaps ${ACCOUNT.imap.port} · smtps ${ACCOUNT.smtp.port}`;
    }))
  ) {
    return;
  }

  if (
    !(await check("smoke : dossiers listés par le serveur", async () => {
      await page.getByRole("button", { name: "Prévisualiser les dossiers" }).click();
      await page.getByRole("heading", { name: "Dossiers à synchroniser" }).waitFor({ timeout: 90_000 });
      const folders = await page.getByRole("checkbox").count();
      if (folders === 0) throw new Error("aucun dossier proposé");
      return `${folders} dossiers`;
    }))
  ) {
    return;
  }

  if (
    !(await check("smoke : compte créé, boîte de réception ouverte", async () => {
      await page.getByRole("button", { name: "Connecter le compte" }).click();
      await page.getByLabel("Ouvrir la recherche globale").waitFor({ timeout: 90_000 });
      return "coquille PC affichée";
    }))
  ) {
    return;
  }

  if (
    !(await check("smoke : messages seedés envoyés au démon", async () => {
      for (const message of SEEDS) await seed(message.subject, message.text);
      return `${SEEDS.length} messages`;
    }))
  ) {
    return;
  }

  if (
    !(await check("smoke : synchro manuelle fait apparaître les deux messages", async () => {
      const sync = syncButton(page);
      await sync.waitFor({ state: "visible", timeout: 60_000 });
      await sync.click();
      for (const message of SEEDS) await row(page, message.subject).waitFor({ timeout: 90_000 });
      return SEEDS.map((message) => message.subject).join(" · ");
    }))
  ) {
    return;
  }

  await check("smoke : le premier message ouvre son corps", async () => {
    const first = page.locator("button[data-mail-row]").first();
    const label = await first.getAttribute("aria-label");
    const opened = SEEDS.find((message) => label?.includes(message.subject));
    if (!opened) throw new Error(`ligne inattendue : ${label}`);
    await first.click();
    await reader(page).getByText(opened.text).first().waitFor({ timeout: 60_000 });
    return `« ${opened.subject} » → ${opened.text}`;
  });
}

// 1. Réponse depuis le lecteur : la rédaction s'ouvre préremplie dans la
// coquille (pas de fenêtre détachée), l'envoi part par le démon, la réponse
// revient dans la boîte et sa copie atterrit dans Envoyés.
export async function desktopReplySend({ page, api, seed, check }) {
  const subject = "[e2e-reply] Question du fil";
  const original = "Corps original du fil e2e-reply.";
  const answer = "Reponse e2e-reply tapee dans la redaction PC.";

  if (
    !(await check("réponse : mail seedé et synchronisé", async () => {
      await seed(subject, original);
      await syncThen(page, api, ACCOUNT.email, waitRow(page, subject));
      return subject;
    }))
  ) {
    return;
  }

  if (
    !(await check("réponse : le lecteur affiche le corps seedé", async () => {
      await row(page, subject).click();
      await reader(page).getByText(original).first().waitFor({ timeout: 60_000 });
      return original;
    }))
  ) {
    return;
  }

  if (
    !(await check("réponse : « Répondre » ouvre la rédaction préremplie", async () => {
      await reader(page).getByRole("button", { name: "Répondre", exact: true }).click();
      const compose = page.getByTestId("desktop-compose");
      await compose.waitFor({ timeout: 30_000 });
      const to = await compose.locator("#compose-to").inputValue();
      if (to !== ACCOUNT.email) throw new Error(`destinataire « ${to} » au lieu de ${ACCOUNT.email}`);
      const composed = await compose.locator("#compose-subject").inputValue();
      if (!composed.startsWith("Re:")) throw new Error(`objet « ${composed} » sans préfixe Re:`);
      return `${to} · ${composed}`;
    }))
  ) {
    return;
  }

  if (
    !(await check("réponse : PGP coupé à l'envoi (aucune clé sur ce compte)", async () => {
      const states = await disablePgp(page.getByTestId("desktop-compose"));
      if (states.includes("true")) throw new Error(`interrupteur resté actif : ${states}`);
      return states;
    }))
  ) {
    return;
  }

  if (
    !(await check("réponse : corps saisi puis envoi, la rédaction se referme", async () => {
      const compose = page.getByTestId("desktop-compose");
      await typeBody(page, compose, answer);
      await compose.getByLabel("Envoyer le message").click();
      await compose.waitFor({ state: "detached", timeout: 60_000 });
      return answer;
    }))
  ) {
    return;
  }

  if (
    !(await check("réponse : la réponse rejoint le fil dans la boîte", async () => {
      const thread = page
        .locator(`button[data-mail-row][aria-label*="${subject}"][aria-label*="2 messages"]`)
        .first();
      await syncThen(page, api, ACCOUNT.email, (timeout) => thread.waitFor({ timeout }));
      const id = await accountId(api, ACCOUNT.email);
      const threads = await folderThreads(api, id, "INBOX");
      const found = threads.find((entry) => entry.messages.length === 2);
      if (!found) throw new Error("aucun fil à deux messages dans INBOX");
      const reply = found.messages.find((message) => /^Re:/.test(message.subject));
      if (!reply) throw new Error(`fil sans réponse : ${found.messages.map((m) => m.subject).join(" · ")}`);
      const root = found.messages.find((message) => message.message_id === reply.in_reply_to);
      if (!root) throw new Error(`la réponse ne cite aucun message du fil (${reply.in_reply_to})`);
      const body = await messageBody(api, id, reply.folder_path, reply.uid);
      if (!body.includes("e2e-reply tapee")) throw new Error(`corps reçu « ${body.slice(0, 120)} »`);
      return `${found.count} messages · ${reply.subject} · réponse à « ${root.subject} »`;
    }))
  ) {
    return;
  }

  if (
    !(await check("réponse : la copie est dans Envoyés", async () => {
      await railButton(page, "Envoyés").click();
      const sent = page
        .locator(`button[data-mail-row][aria-label*="${subject}"][aria-label*="À ${ACCOUNT.email}"]`)
        .first();
      await sent.waitFor({ timeout: 60_000 });
      await sent.click();
      await reader(page)
        .getByRole("heading", { name: /^Re: / })
        .waitFor({ timeout: 30_000 });
      return `Envoyés · Re: ${subject}`;
    }))
  ) {
    return;
  }

  await check("réponse : retour à la boîte de réception", async () => {
    await railButton(page, "Boîte de réception").click();
    await row(page, subject).waitFor({ timeout: 60_000 });
    return "Boîte de réception";
  });
}

// 2. Nouveau message depuis le bouton flottant du dock : destinataire, objet et
// corps saisis à la main, envoi par le démon, message relevé dans la boîte.
export async function desktopComposeSend({ page, api, check }) {
  const subject = "[e2e-compose] Message neuf";
  const body = "Corps e2e-compose ecrit dans la redaction PC.";

  if (
    !(await check("rédaction : le bouton « Nouveau message » ouvre un brouillon vide", async () => {
      await page.getByLabel("Nouveau message").click();
      const compose = page.getByTestId("desktop-compose");
      await compose.waitFor({ timeout: 30_000 });
      const to = await compose.locator("#compose-to").inputValue();
      const composed = await compose.locator("#compose-subject").inputValue();
      if (to !== "" || composed !== "") throw new Error(`brouillon non vide : « ${to} » / « ${composed} »`);
      return "destinataire et objet vides";
    }))
  ) {
    return;
  }

  if (
    !(await check("rédaction : destinataire, objet et corps saisis", async () => {
      const compose = page.getByTestId("desktop-compose");
      await compose.locator("#compose-to").fill(ACCOUNT.email);
      await compose.locator("#compose-subject").fill(subject);
      await disablePgp(compose);
      await typeBody(page, compose, body);
      return `${ACCOUNT.email} · ${subject}`;
    }))
  ) {
    return;
  }

  if (
    !(await check("rédaction : envoi, la rédaction se referme", async () => {
      const compose = page.getByTestId("desktop-compose");
      await compose.getByLabel("Envoyer le message").click();
      await compose.waitFor({ state: "detached", timeout: 60_000 });
      return "rédaction fermée";
    }))
  ) {
    return;
  }

  await check("rédaction : le message envoyé arrive dans la boîte", async () => {
    await syncThen(page, api, ACCOUNT.email, waitRow(page, subject));
    const id = await accountId(api, ACCOUNT.email);
    const threads = await folderThreads(api, id, "INBOX");
    const thread = threads.find((entry) => entry.messages.some((message) => message.subject === subject));
    if (!thread) throw new Error(`« ${subject} » absent de INBOX`);
    const message = thread.messages.find((entry) => entry.subject === subject);
    const content = await messageBody(api, id, message.folder_path, message.uid);
    if (!content.includes("e2e-compose ecrit")) throw new Error(`corps reçu « ${content.slice(0, 120)} »`);
    return `${subject} · uid ${message.uid}`;
  });
}

// 3. Actions de dossier par le menu contextuel : corbeille puis restauration,
// archivage puis retour en réception, étoile et non-lu.
export async function desktopFolderActions({ page, api, seed, check }) {
  const trashSubject = "[e2e-folder] A corbeiller";
  const archiveSubject = "[e2e-folder] A archiver";

  const openMenu = async (subject) => {
    await row(page, subject).click({ button: "right" });
    await page.getByRole("menu", { name: "Actions du message" }).waitFor({ timeout: 30_000 });
  };

  if (
    !(await check("dossiers : deux mails seedés et synchronisés", async () => {
      await seed(trashSubject, "Corps e2e-folder a corbeiller.");
      await seed(archiveSubject, "Corps e2e-folder a archiver.");
      await syncThen(page, api, ACCOUNT.email, waitRow(page, trashSubject));
      await row(page, archiveSubject).waitFor({ timeout: 60_000 });
      return `${trashSubject} · ${archiveSubject}`;
    }))
  ) {
    return;
  }

  if (
    !(await check("dossiers : « Mettre à la corbeille » retire le mail de la boîte", async () => {
      await openMenu(trashSubject);
      await menuItem(page, "Mettre à la corbeille").click();
      await row(page, trashSubject).waitFor({ state: "detached", timeout: 60_000 });
      return "mail déplacé";
    }))
  ) {
    return;
  }

  if (
    !(await check("dossiers : le mail est dans la Corbeille", async () => {
      await railButton(page, "Corbeille").click();
      await row(page, trashSubject).waitFor({ timeout: 60_000 });
      return "Corbeille";
    }))
  ) {
    return;
  }

  if (
    !(await check("dossiers : « Restaurer » ramène le mail dans la boîte", async () => {
      await openMenu(trashSubject);
      await menuItem(page, "Restaurer").click();
      await row(page, trashSubject).waitFor({ state: "detached", timeout: 60_000 });
      await railButton(page, "Boîte de réception").click();
      await row(page, trashSubject).waitFor({ timeout: 60_000 });
      return "restauré";
    }))
  ) {
    return;
  }

  if (
    !(await check("dossiers : « Archiver » puis « Déplacer vers la réception »", async () => {
      await openMenu(archiveSubject);
      await menuItem(page, "Archiver").click();
      await row(page, archiveSubject).waitFor({ state: "detached", timeout: 60_000 });
      await railButton(page, "Archives").click();
      await row(page, archiveSubject).waitFor({ timeout: 60_000 });
      await openMenu(archiveSubject);
      await menuItem(page, "Déplacer vers la réception").click();
      await row(page, archiveSubject).waitFor({ state: "detached", timeout: 60_000 });
      await railButton(page, "Boîte de réception").click();
      await row(page, archiveSubject).waitFor({ timeout: 60_000 });
      return "archivé puis revenu";
    }))
  ) {
    return;
  }

  if (
    !(await check("dossiers : « Étoiler » puis filtre « Étoilés »", async () => {
      await openMenu(archiveSubject);
      await menuItem(page, "Étoiler").click();
      await page.getByRole("button", { name: "Étoilés", exact: true }).click();
      await row(page, archiveSubject).waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: "Tous", exact: true }).click();
      return `${archiveSubject} étoilé`;
    }))
  ) {
    return;
  }

  await check("dossiers : « Marquer non lu » se voit sur la ligne", async () => {
    await row(page, archiveSubject).click();
    await reader(page).getByRole("heading", { name: archiveSubject }).waitFor({ timeout: 30_000 });
    await openMenu(archiveSubject);
    await menuItem(page, "Marquer non lu").click();
    const line = page.locator(`button[data-mail-row][aria-label*="${archiveSubject}"]`).first();
    await line.and(page.locator('[aria-label*="non lu"]')).waitFor({ timeout: 30_000 });
    return "ligne marquée non lue";
  });
}

// 4. Recherche globale : un sujet unique seedé, un résultat, le lecteur affiche
// le bon corps, puis fermeture explicite du panneau.
export async function desktopSearch({ page, api, seed, check }) {
  const subject = "[e2e-search] Aiguille unique";
  const body = "Corps e2e-search retrouve par la recherche globale.";

  if (
    !(await check("recherche : mail seedé et synchronisé", async () => {
      await seed(subject, body);
      await syncThen(page, api, ACCOUNT.email, waitRow(page, subject));
      return subject;
    }))
  ) {
    return;
  }

  if (
    !(await check("recherche : le panneau s'ouvre sur le champ de recherche", async () => {
      await page.getByLabel("Ouvrir la recherche globale").click();
      await page
        .getByRole("dialog", { name: "Recherche globale" })
        .getByLabel("Rechercher dans tous les comptes")
        .waitFor({ timeout: 30_000 });
      return "panneau ouvert";
    }))
  ) {
    return;
  }

  if (
    !(await check("recherche : le sujet seedé remonte un résultat", async () => {
      const dialog = page.getByRole("dialog", { name: "Recherche globale" });
      await dialog.getByLabel("Rechercher dans tous les comptes").fill(subject);
      await dialog.getByText(/^1 résultat pour/).waitFor({ timeout: 60_000 });
      await dialog.getByRole("button").filter({ hasText: subject }).first().waitFor({ timeout: 30_000 });
      return "1 résultat";
    }))
  ) {
    return;
  }

  if (
    !(await check("recherche : le résultat ouvre le bon corps dans le lecteur", async () => {
      const dialog = page.getByRole("dialog", { name: "Recherche globale" });
      await dialog.getByRole("button").filter({ hasText: subject }).first().click();
      await dialog.waitFor({ state: "detached", timeout: 30_000 });
      await reader(page).getByRole("heading", { name: subject }).waitFor({ timeout: 30_000 });
      await reader(page).getByText(body).first().waitFor({ timeout: 60_000 });
      return body;
    }))
  ) {
    return;
  }

  await check("recherche : « Fermer la recherche » referme le panneau", async () => {
    await page.getByLabel("Ouvrir la recherche globale").click();
    const dialog = page.getByRole("dialog", { name: "Recherche globale" });
    await dialog.waitFor({ timeout: 30_000 });
    await dialog.getByLabel("Fermer la recherche").click();
    await dialog.waitFor({ state: "detached", timeout: 30_000 });
    return "panneau fermé";
  });
}

// 5. Fil dans le lecteur (#42) : la réponse du scénario 1 ouvre le fil, les
// messages antérieurs sont dépliés par défaut, se replient et se redéplient
// avec le corps seedé de l'original.
export async function desktopThread({ page, check }) {
  const subject = "[e2e-reply] Question du fil";
  const original = "Corps original du fil e2e-reply.";
  const toggle = (label) =>
    reader(page).getByRole("button", { name: new RegExp(`^${label} le message de`) });
  // Les cartes des antérieurs, quel que soit leur état : l'ordre ne bouge pas.
  const cards = () => toggle("(Replier|Déplier)").locator("..");
  let originalIndex = -1;

  if (
    !(await check("fil : la réponse ouvre le fil dans le lecteur", async () => {
      const thread = page
        .locator(`button[data-mail-row][aria-label*="${subject}"][aria-label*="2 messages"]`)
        .first();
      await thread.waitFor({ timeout: 60_000 });
      await thread.click();
      await reader(page).getByRole("heading", { name: `Re: ${subject}` }).waitFor({ timeout: 30_000 });
      const section = reader(page).getByText(/messages? antérieur/);
      await section.first().waitFor({ timeout: 30_000 });
      return `Re: ${subject} · ${await section.first().innerText()}`;
    }))
  ) {
    return;
  }

  if (
    !(await check("fil : les antérieurs sont dépliés et portent leur corps", async () => {
      const total = await cards().count();
      const expanded = await toggle("Replier").count();
      if (total === 0) throw new Error("aucun message antérieur");
      if (expanded !== total) throw new Error(`${expanded} antérieurs dépliés sur ${total}`);
      for (let index = 0; index < total; index += 1) {
        if ((await cards().nth(index).getByText(original).count()) > 0) originalIndex = index;
      }
      if (originalIndex < 0) throw new Error(`corps « ${original} » absent des antérieurs`);
      return `${total} antérieurs dépliés · corps dans l'antérieur ${originalIndex + 1}`;
    }))
  ) {
    return;
  }

  if (
    !(await check("fil : « Tout replier » masque le corps antérieur", async () => {
      await reader(page)
        .getByRole("button", { name: "Tout replier les messages antérieurs" })
        .click();
      await toggle("Déplier").first().waitFor({ timeout: 30_000 });
      if ((await toggle("Replier").count()) > 0) throw new Error("un antérieur est resté déplié");
      if ((await cards().nth(originalIndex).getByText(original).count()) > 0) {
        throw new Error("corps antérieur encore visible");
      }
      return `${await cards().count()} antérieurs repliés`;
    }))
  ) {
    return;
  }

  await check("fil : déplier l'antérieur ramène son corps seedé", async () => {
    await cards().nth(originalIndex).getByRole("button").first().click();
    await cards().nth(originalIndex).getByText(original).first().waitFor({ timeout: 60_000 });
    return original;
  });
}

// 6. Boîte unifiée (#43) : un second compte est connecté depuis les réglages,
// les mails des deux comptes se lisent dans la même liste, et un mail mis à la
// corbeille quitte l'unifiée (Corbeille exclue) tout en restant dans celle du
// compte.
export async function desktopUnified({ page, api, seed, check }) {
  const bobSubject = "[e2e-unified] Message de bob";
  const romanSubject = "[e2e-compose] Message neuf";

  if (
    !(await check("unifiée : « Ajouter un compte » ouvre le formulaire de connexion", async () => {
      await dockTab(page, "Réglages").click();
      await page.getByRole("button", { name: "Ajouter un compte", exact: true }).click();
      await page.locator("#connect-email").waitFor({ timeout: 60_000 });
      return "formulaire de connexion affiché";
    }))
  ) {
    return;
  }

  if (
    !(await check("unifiée : second compte GreenMail saisi", async () => {
      // Les hôtes d'abord : le blur de l'adresse lance une auto-découverte.
      await page.selectOption("#connect-imap-encryption", ACCOUNT.imap.encryption);
      await page.fill("#connect-imap-host", ACCOUNT.imap.host);
      await page.fill("#connect-imap-port", ACCOUNT.imap.port);
      await page.selectOption("#connect-smtp-encryption", ACCOUNT.smtp.encryption);
      await page.fill("#connect-smtp-host", ACCOUNT.smtp.host);
      await page.fill("#connect-smtp-port", ACCOUNT.smtp.port);
      await page.fill("#connect-label", SECOND_ACCOUNT.label);
      await page.fill("#connect-username", SECOND_ACCOUNT.username);
      await page.fill("#connect-password", SECOND_ACCOUNT.password);
      await page.fill("#connect-email", SECOND_ACCOUNT.email);
      return `${SECOND_ACCOUNT.email} · imaps ${ACCOUNT.imap.port}`;
    }))
  ) {
    return;
  }

  if (
    !(await check("unifiée : les dossiers de bob sont publiés puis le compte créé", async () => {
      await page.getByRole("button", { name: "Prévisualiser les dossiers" }).click();
      await page.getByRole("heading", { name: "Dossiers à synchroniser" }).waitFor({ timeout: 90_000 });
      const folders = await page.getByRole("checkbox").count();
      if (folders === 0) throw new Error("aucun dossier proposé");
      await page.getByRole("button", { name: "Connecter le compte" }).click();
      await page
        .getByRole("heading", { name: "Dossiers à synchroniser" })
        .waitFor({ state: "detached", timeout: 90_000 });
      const accounts = await api("/api/accounts");
      const emails = (accounts.json ?? []).map((entry) => entry.email);
      if (!emails.includes(SECOND_ACCOUNT.email)) throw new Error(`comptes : ${emails.join(", ")}`);
      return `${folders} dossiers · comptes ${emails.join(", ")}`;
    }))
  ) {
    return;
  }

  if (
    !(await check("unifiée : mail seedé dans la boîte de bob", async () => {
      await seed(bobSubject, "Corps e2e-unified cote bob.", SECOND_ACCOUNT.email);
      return `${bobSubject} → ${SECOND_ACCOUNT.email}`;
    }))
  ) {
    return;
  }

  if (
    !(await check("unifiée : la vue « Tous les comptes » ouvre la Boîte unifiée", async () => {
      await dockTab(page, "Boîte").click();
      await railButton(page, "Tous les comptes").click();
      await syncThen(page, api, SECOND_ACCOUNT.email, waitRow(page, bobSubject));
      await row(page, romanSubject).waitFor({ timeout: 60_000 });
      return `${romanSubject} + ${bobSubject}`;
    }))
  ) {
    return;
  }

  if (
    !(await check("unifiée : un mail mis à la corbeille quitte l'unifiée", async () => {
      await row(page, bobSubject).click({ button: "right" });
      await page.getByRole("menu", { name: "Actions du message" }).waitFor({ timeout: 30_000 });
      await menuItem(page, "Mettre à la corbeille").click();
      await row(page, bobSubject).waitFor({ state: "detached", timeout: 60_000 });
      await row(page, romanSubject).waitFor({ timeout: 30_000 });
      return `${bobSubject} hors de l'unifiée, ${romanSubject} toujours là`;
    }))
  ) {
    return;
  }

  await check("unifiée : le mail est dans la Corbeille du compte de bob", async () => {
    await railButton(page, "Corbeille").click();
    await row(page, bobSubject).waitFor({ timeout: 60_000 });
    const id = await accountId(api, SECOND_ACCOUNT.email);
    const threads = await folderThreads(api, id, "Trash");
    const found = threads.find((entry) => entry.messages.some((message) => message.subject === bobSubject));
    if (!found) throw new Error(`« ${bobSubject} » absent de Trash chez bob`);
    return `Trash de ${SECOND_ACCOUNT.email} · ${found.messages[0].subject}`;
  });
}

// 7. Réglages persistants : le choix d'affichage des conversations survit à un
// rechargement complet de la page (préférences en localStorage).
export async function desktopSettingsPersistence({ page, check }) {
  const option = () =>
    page.getByRole("button", { name: "Tout dans le même mail", exact: true });
  const nav = () => page.getByRole("navigation", { name: "Sections des réglages" });

  if (
    !(await check("réglages : « Apparence » affiche l'option par défaut", async () => {
      await dockTab(page, "Réglages").click();
      await nav().getByRole("button", { name: "Apparence", exact: true }).click();
      await option().waitFor({ timeout: 30_000 });
      const tidy = await page
        .getByRole("button", { name: "Bien rangé", exact: true })
        .getAttribute("aria-pressed");
      if (tidy !== "true") throw new Error(`« Bien rangé » n'est pas sélectionné : ${tidy}`);
      return "Bien rangé sélectionné";
    }))
  ) {
    return;
  }

  if (
    !(await check("réglages : « Tout dans le même mail » est enregistré", async () => {
      await option().click();
      const pressed = await option().getAttribute("aria-pressed");
      if (pressed !== "true") throw new Error(`option non sélectionnée : ${pressed}`);
      const stored = await page.evaluate(() => localStorage.getItem("lavande.prefs"));
      if (!stored?.includes('"threadView":"inline"')) {
        throw new Error(`préférences enregistrées : ${stored}`);
      }
      return "threadView = inline";
    }))
  ) {
    return;
  }

  await check("réglages : le choix survit au rechargement de la page", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    // La vue et le dossier sont persistés : on repasse par la boîte, puis par
    // les réglages pour relire l'option.
    await dockTab(page, "Boîte").waitFor({ timeout: 90_000 });
    await dockTab(page, "Boîte").click();
    await page.getByLabel("Ouvrir la recherche globale").waitFor({ timeout: 90_000 });
    await dockTab(page, "Réglages").click();
    await nav().getByRole("button", { name: "Apparence", exact: true }).click();
    await option().waitFor({ timeout: 30_000 });
    const pressed = await option().getAttribute("aria-pressed");
    if (pressed !== "true") throw new Error(`option perdue au rechargement : ${pressed}`);
    return "« Tout dans le même mail » toujours sélectionné";
  });
}
