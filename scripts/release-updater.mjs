#!/usr/bin/env node
/**
 * Prépare une release de bureau et le manifeste de mise à jour de Lavande.
 *
 *   node scripts/release-updater.mjs                 # après un `tauri build`
 *   node scripts/release-updater.mjs --build         # build rpm + appimage puis publie
 *   node scripts/release-updater.mjs --notes "…" --url-base https://exemple/updates
 *
 * Le script ne touche pas au code : il lit la version de `src-tauri/tauri.conf.json`,
 * récupère le RPM et l'AppImage déjà construits dans `src-tauri/target/release/bundle/`,
 * les signe avec la clé privée (`.tauri/lavande-updater.key`) et écrit `latest.json`.
 *
 * L'updater Tauri télécharge le paquet correspondant à l'installation qui tourne :
 * `linux-x86_64-rpm` pour un paquet RPM, `linux-x86_64-appimage` pour un AppImage,
 * et `linux-x86_64` en dernier recours.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "src-tauri/target/release/bundle");
const CONFIG = path.join(ROOT, "src-tauri/tauri.conf.json");

const fail = (message) => {
  console.error(`release-updater : ${message}`);
  process.exit(1);
};

const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    [
      "usage : node scripts/release-updater.mjs [options]",
      "",
      "  --build           lance `tauri build --bundles rpm,appimage` (VITE_DISTRIBUTION=1) avant de publier",
      "  --notes <texte>   notes de version (défaut : dernier commit git)",
      "  --url-base <url>  dossier public des artefacts (défaut : dossier de l'endpoint)",
      "  --key <chemin>    clé privée (défaut : .tauri/lavande-updater.key)",
      "  --out <dossier>   sortie (défaut : artifacts/updater)",
      "  -h, --help        cette aide",
    ].join("\n"),
  );
  process.exit(0);
}

const run = (command, args, extra = {}) =>
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit", ...extra });

const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const version = config.version;
if (!version) fail("version absente de src-tauri/tauri.conf.json");

const endpoints = config.plugins?.updater?.endpoints ?? [];
if (endpoints.length === 0) fail("aucun endpoint updater dans src-tauri/tauri.conf.json");
const endpoint = new URL(endpoints[0]);
const urlBase = (
  option("url-base") ?? endpoint.href.replace(/\/[^/]*$/, "")
).replace(/\/$/, "");

const keyPath = path.resolve(ROOT, option("key") ?? ".tauri/lavande-updater.key");
if (!fs.existsSync(keyPath)) fail(`clé privée introuvable : ${keyPath}`);
const publicPath = `${keyPath}.pub`;
if (fs.existsSync(publicPath)) {
  const expected = fs.readFileSync(publicPath, "utf8").trim();
  if (expected !== (config.plugins?.updater?.pubkey ?? "").trim()) {
    fail(
      "plugins.updater.pubkey de tauri.conf.json ne correspond pas à la clé privée : " +
        "les mises à jour publiées seraient rejetées.",
    );
  }
} else {
  console.warn(`release-updater : ${publicPath} absent, pubkey non vérifiée`);
}

const notes =
  option("notes") ??
  (() => {
    try {
      return execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: ROOT }).toString().trim();
    } catch {
      return "";
    }
  })();

if (process.argv.includes("--build")) {
  console.log("release-updater : build rpm + appimage (verrou distribution)");
  run("npx", ["tauri", "build", "--bundles", "rpm,appimage"], {
    env: { ...process.env, VITE_DISTRIBUTION: "1" },
  });
} else if (process.env.VITE_DISTRIBUTION !== "1") {
  console.warn(
    "release-updater : binaires réutilisés — ils doivent avoir été construits avec VITE_DISTRIBUTION=1",
  );
}

const newest = (directory, extension) => {
  if (!fs.existsSync(directory)) return null;
  return (
    fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(extension) && name.includes(version))
      .sort()
      .at(-1) ?? null
  );
};

const appimage = newest(path.join(BUNDLE, "appimage"), ".AppImage");
const rpm = newest(path.join(BUNDLE, "rpm"), ".rpm");
if (!appimage && !rpm) {
  fail(
    `aucun artefact ${version} dans ${path.relative(ROOT, BUNDLE)} : lancez ` +
      "`VITE_DISTRIBUTION=1 npx tauri build --bundles rpm,appimage`",
  );
}

const outDir = path.resolve(ROOT, option("out") ?? "artifacts/updater");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const sign = (file) => {
  run("npx", [
    "tauri",
    "signer",
    "sign",
    "--app-version",
    version,
    "--private-key-path",
    keyPath,
    file,
  ]);
  const signature = fs.readFileSync(`${file}.sig`, "utf8").trim();
  if (!signature) fail(`signature vide pour ${path.basename(file)}`);
  return signature;
};

const platforms = {};

if (rpm) {
  const source = path.join(BUNDLE, "rpm", rpm);
  const target = path.join(outDir, rpm);
  fs.copyFileSync(source, target);
  platforms["linux-x86_64-rpm"] = {
    signature: sign(target),
    url: `${urlBase}/${encodeURIComponent(rpm)}`,
  };
  console.log(`signé : ${rpm}`);
}

if (appimage) {
  const source = path.join(BUNDLE, "appimage", appimage);
  const archive = `${appimage}.tar.gz`;
  const target = path.join(outDir, archive);
  run("tar", ["-czf", target, "-C", path.dirname(source), appimage]);
  platforms["linux-x86_64-appimage"] = {
    signature: sign(target),
    url: `${urlBase}/${encodeURIComponent(archive)}`,
  };
  console.log(`signé : ${archive}`);
}

platforms["linux-x86_64"] = platforms["linux-x86_64-rpm"] ?? platforms["linux-x86_64-appimage"];

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};
fs.writeFileSync(path.join(outDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const published = fs.readdirSync(outDir).sort();
console.log("");
console.log(`Lavande ${version} prête dans ${path.relative(ROOT, outDir)}`);
console.log(`Endpoint : ${endpoint.href}`);
console.log(`À publier dans ${urlBase}/ :`);
for (const name of published) console.log(`  - ${name}`);
console.log(`Notes : ${notes || "(aucune)"}`);
