// Helpers partagés de la suite E2E web : binaire chromium, runner ok/fail,
// GreenMail, démon local, serveur Vite et client API du démon.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = path.resolve(import.meta.dirname, "../..");
const ARTIFACTS = path.join(ROOT, "artifacts");
const DAEMON_BIN = path.join(os.homedir(), ".cache/lavande-build/target/debug/lavande-maild");
const MAIL_TEST_CA = path.join(os.homedir(), ".cache/lavande/mail-test/cert.pem");

const candidates = [
  process.env.CHROMIUM_BIN,
  path.join(os.homedir(), ".cache/ms-playwright/chromium-1254/chrome-linux64/chrome"),
  path.join(os.homedir(), ".cache/ms-playwright/chromium-1254/chrome-linux/chrome"),
  path.join(os.homedir(), ".cache/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell"),
].filter(Boolean);

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

function slug(label) {
  return label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/** Runner ok/fail : chaque étape renvoie un booléen, la capture part en échec. */
export function createRunner(pageProvider) {
  let checks = 0;
  let failures = 0;

  const capture = async (label) => {
    const page = pageProvider?.();
    if (!page) return null;
    mkdirSync(ARTIFACTS, { recursive: true });
    const file = path.join(ARTIFACTS, `e2e-${slug(label)}.png`);
    try {
      await page.screenshot({ path: file });
      return path.relative(ROOT, file);
    } catch {
      return null;
    }
  };

  return {
    async check(label, fn) {
      checks += 1;
      try {
        const detail = await fn();
        console.log(`ok   ${label}${detail === undefined ? "" : ` — ${detail}`}`);
        return true;
      } catch (error) {
        failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        const shot = await capture(label);
        console.log(`FAIL ${label} — ${message}${shot ? ` (capture ${shot})` : ""}`);
        return false;
      }
    },
    get checks() {
      return checks;
    },
    get failures() {
      return failures;
    },
  };
}

export async function launchBrowser() {
  const executablePath = candidates.find((entry) => existsSync(entry));
  if (!executablePath) {
    throw new Error(`aucun binaire chromium trouvé parmi ${candidates.join(", ")}`);
  }
  return chromium.launch({ executablePath, headless: true, env: browserEnv });
}

/** `reset` recrée le conteneur : état propre, utilisateurs et certificat rechargés. */
export function resetGreenMail() {
  const script = path.join(ROOT, "scripts/mail-test-server.sh");
  try {
    const output = execFileSync("bash", [script, "reset"], { encoding: "utf8", stdio: "pipe" });
    const user = output.match(/^\s+user\s+(\S+)/m)?.[1];
    return user ? `conteneur recréé, utilisateur ${user}` : "conteneur recréé";
  } catch (error) {
    const stderr = error instanceof Error ? error.stderr?.trim() : String(error);
    throw new Error(`scripts/mail-test-server.sh reset a échoué : ${stderr || error}`);
  }
}

/**
 * GreenMail ne publie que INBOX à la naissance d'un utilisateur : les dossiers
 * à rôle (Envoyés, Corbeille, Archives) sont créés par le client, comme le font
 * les tests Rust. IMAP en clair sur le port de test, une commande à la fois.
 */
export async function createFolders(user, password, folders, { host = "127.0.0.1", port = 3143 } = {}) {
  const socket = net.connect({ host, port });
  let pending = "";
  let failure = null;
  let notify = () => {};
  socket.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    notify();
  });
  socket.on("error", (error) => {
    failure = error;
    notify();
  });

  const waitLine = (test) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        notify = () => {};
        reject(new Error(`IMAP ${host}:${port} muet`));
      }, 15_000);
      const scan = () => {
        if (failure) {
          notify = () => {};
          clearTimeout(timer);
          reject(new Error(`IMAP ${host}:${port} : ${failure.message}`));
          return;
        }
        let index;
        while ((index = pending.indexOf("\r\n")) >= 0) {
          const line = pending.slice(0, index);
          pending = pending.slice(index + 2);
          if (!test(line)) continue;
          notify = () => {};
          clearTimeout(timer);
          resolve(line);
          return;
        }
      };
      notify = scan;
      scan();
    });

  const command = async (tag, text) => {
    socket.write(`${tag} ${text}\r\n`);
    const line = await waitLine((entry) => entry.startsWith(`${tag} `));
    if (!/ OK/.test(line)) throw new Error(`${text} : ${line}`);
    return line;
  };

  try {
    await waitLine((line) => line.startsWith("* OK"));
    await command("a0", `LOGIN ${user} ${password}`);
    let tag = 0;
    for (const folder of folders) {
      tag += 1;
      await command(`a${tag}`, `CREATE "${folder}"`);
    }
    socket.write(`a${tag + 1} LOGOUT\r\n`);
    return folders;
  } finally {
    socket.destroy();
  }
}

export async function waitForHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // démon pas encore à l'écoute
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${url} n'a pas répondu en ${timeoutMs} ms`);
}

async function portBusy(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch (error) {
    return error instanceof Error && error.cause?.code !== "ECONNREFUSED";
  }
}

/** Démon jetable : données temporaires, port dédié, enfant du process node. */
export async function startDaemon({ port = 8791, bin = DAEMON_BIN } = {}) {
  if (!existsSync(bin)) throw new Error(`binaire absent : ${bin} (cargo build -p lavande-mail-api)`);
  if (await portBusy(port)) throw new Error(`le port ${port} est déjà pris, refus de démarrer le démon E2E`);

  const dataDir = mkdtempSync(path.join(os.tmpdir(), "lavande-e2e-"));
  const bind = `127.0.0.1:${port}`;
  const child = spawn(bin, [], {
    env: {
      ...process.env,
      LAVANDE_MAIL_DATA_DIR: dataDir,
      LAVANDE_MAIL_BIND: bind,
      LAVANDE_MAIL_EXTRA_ROOTS: MAIL_TEST_CA,
      LAVANDE_MAIL_SECRETS: "file",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });

  const base = `http://${bind}`;
  try {
    await waitForHttp(`${base}/api/health`);
  } catch (error) {
    child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`${error.message} — journal du démon :\n${log.trim() || "(vide)"}`);
  }

  const tokenFile = path.join(dataDir, "daemon-token");
  const deadline = Date.now() + 10_000;
  while (!existsSync(tokenFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!existsSync(tokenFile)) {
    child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`jeton du démon absent : ${tokenFile}`);
  }

  return {
    base,
    dataDir,
    token: readFileSync(tokenFile, "utf8").trim(),
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        const exited = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 5000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        if (!exited) child.kill("SIGKILL");
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Serveur Vite de la suite : mode api par défaut, jeton lu par vite.config.ts. */
export async function startVite({ dataDir, apiBase, port = 1422 }) {
  process.env.MAIL_API = apiBase;
  process.env.LAVANDE_MAIL_DATA_DIR = dataDir;
  delete process.env.VITE_MAIL_BACKEND;
  const server = await createServer({
    configFile: path.join(ROOT, "vite.config.ts"),
    root: ROOT,
    cacheDir: path.join(os.tmpdir(), "lavande-e2e-vite-cache"),
    server: { host: "127.0.0.1", port, strictPort: true },
  });
  await server.listen();
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** Client de l'API du démon, jeton Bearer inclus. */
export function apiClient(base, token) {
  return async (requestPath, options = {}) => {
    const headers = { accept: "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${base}${requestPath}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const raw = await response.text();
    let json = null;
    if (raw !== "") {
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }
    }
    return { status: response.status, json, raw };
  };
}

/**
 * S'envoie un message à soi-même : il atterrit dans l'INBOX GreenMail. Le
 * compte expéditeur est le premier par défaut, ou celui de l'adresse demandée.
 */
export function seedSender(api) {
  return async (subject, text, accountEmail) => {
    const accounts = await api("/api/accounts");
    if (accounts.status !== 200) {
      throw new Error(`GET /api/accounts : HTTP ${accounts.status} ${accounts.raw.slice(0, 200)}`);
    }
    const account = accountEmail
      ? accounts.json?.find((entry) => entry.email.toLowerCase() === accountEmail.toLowerCase())
      : accounts.json?.[0];
    if (!account) {
      throw new Error(
        accountEmail ? `compte « ${accountEmail} » absent du démon` : "aucun compte connecté côté démon",
      );
    }
    const sent = await api(`/api/accounts/${encodeURIComponent(account.id)}/send`, {
      method: "POST",
      body: {
        to: [{ name: null, email: account.email }],
        cc: [],
        bcc: [],
        subject,
        text,
        html: null,
      },
    });
    if (sent.status !== 204) {
      throw new Error(`send « ${subject} » : HTTP ${sent.status} ${sent.raw.slice(0, 200)}`);
    }
    return subject;
  };
}

/** Identifiant du compte côté démon, retrouvé par son adresse. */
export async function accountId(api, email) {
  const accounts = await api("/api/accounts");
  if (accounts.status !== 200) {
    throw new Error(`GET /api/accounts : HTTP ${accounts.status} ${accounts.raw.slice(0, 200)}`);
  }
  const account = accounts.json?.find(
    (entry) => entry.email.toLowerCase() === email.toLowerCase(),
  );
  if (!account) throw new Error(`compte « ${email} » absent du démon`);
  return account.id;
}

/** Fils d'un dossier tels que le démon les stocke : source des assertions backend. */
export async function folderThreads(api, id, path) {
  const response = await api(
    `/api/accounts/${encodeURIComponent(id)}/folders/${encodeURIComponent(path)}/threads`,
  );
  if (response.status !== 200) {
    throw new Error(`threads ${path} : HTTP ${response.status} ${response.raw.slice(0, 200)}`);
  }
  return response.json ?? [];
}

/** Corps d'un message, relu sur le serveur par le démon (`fetch_body`). */
export async function messageBody(api, id, path, uid) {
  const response = await api(
    `/api/accounts/${encodeURIComponent(id)}/folders/${encodeURIComponent(path)}/messages/${uid}?fetch_body=true`,
  );
  if (response.status !== 200) {
    throw new Error(`message ${uid} : HTTP ${response.status} ${response.raw.slice(0, 200)}`);
  }
  return `${response.json?.body_text ?? ""} ${response.json?.body_html ?? ""}`;
}

/** Message d'un sujet donné dans l'INBOX d'un compte, avec son corps relu. */
export async function inboxMessageBody(api, email, subject) {
  const id = await accountId(api, email);
  const threads = await folderThreads(api, id, "INBOX");
  const thread = threads.find((entry) => entry.messages.some((message) => message.subject === subject));
  if (!thread) throw new Error(`« ${subject} » absent de INBOX`);
  const message = thread.messages.find((entry) => entry.subject === subject);
  const content = await messageBody(api, id, message.folder_path, message.uid);
  return { uid: message.uid, content };
}

/**
 * Chiffrement et signature partent activés par défaut : sans clé PGP le démon
 * refuse l'envoi (« Aucune clé secrète pour signer ce message »). Les deux
 * interrupteurs sont coupés comme le ferait un utilisateur sans clé. `scope`
 * est la page (mobile) ou le panneau de rédaction (PC).
 */
export async function disablePgp(scope) {
  const toggles = [/^Chiffrer à l.envoi$/, /^Signer à l.envoi$/];
  const states = [];
  for (const name of toggles) {
    const toggle = scope.getByRole("button", { name });
    if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
    states.push(`${await toggle.innerText()} ${await toggle.getAttribute("aria-pressed")}`);
  }
  return states.join(" · ");
}

/** Synchro d'un compte par l'API du démon, tous ses dossiers sélectionnés. */
export async function syncAccount(api, email) {
  const id = await accountId(api, email);
  const response = await api(`/api/accounts/${encodeURIComponent(id)}/sync`, {
    method: "POST",
    body: {},
  });
  if (response.status !== 200) {
    throw new Error(`sync ${email} : HTTP ${response.status} ${response.raw.slice(0, 200)}`);
  }
  return id;
}
