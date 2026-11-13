import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const genDir = path.join("src-tauri", "gen", "android");
const appDir = path.join(genDir, "app", "src", "main");
const resValuesDir = path.join(appDir, "res", "values");
const resXmlDir = path.join(appDir, "res", "xml");

if (!existsSync(genDir)) {
  console.log("projet Android absent : lance d'abord npm run android:init");
  process.exit(0);
}

const REQUIRED_IMPORTS = [
  "android.os.Bundle",
  "android.view.View",
  "android.view.ViewGroup",
  "android.webkit.WebView",
  "androidx.activity.enableEdgeToEdge",
  "androidx.core.view.ViewCompat",
  "androidx.core.view.WindowInsetsCompat",
];

const CLASS_BODY = `class MainActivity : TauriActivity() {
  private var lastInsets: WindowInsetsCompat? = null
  private var lastPushed: String = ""

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val root = findViewById<ViewGroup>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
      lastInsets = insets
      pushInsets(root, insets)
      insets
    }
    root.requestApplyInsets()
    root.viewTreeObserver.addOnGlobalLayoutListener {
      lastInsets?.let { pushInsets(root, it) }
    }
  }

  override fun onResume() {
    super.onResume()
    val root = findViewById<ViewGroup>(android.R.id.content)
    root.post {
      lastInsets?.let { pushInsets(root, it) }
    }
  }

  private fun pushInsets(root: View, insets: WindowInsetsCompat) {
    val web = findWebView(root) ?: return
    web.setBackgroundColor(0xFFFBFAFF.toInt())
    val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
    val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
    val density = resources.displayMetrics.density
    fun css(px: Int): Int = Math.round(px / density)
    val bottom = css(bars.bottom)
    val imeBottom = css(ime.bottom)
    val signature = "$bottom|$imeBottom"
    if (signature == lastPushed) return
    lastPushed = signature
    val js = "(function(){var s=document.documentElement.style;" +
      "s.setProperty('--safe-bottom','" + bottom + "px');" +
      "s.setProperty('--ime-bottom','" + imeBottom + "px');" +
      "})();"
    web.evaluateJavascript(js, null)
  }

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        val found = findWebView(view.getChildAt(index))
        if (found != null) return found
      }
    }
    return null
  }
}
`;

function patchMainActivity(source) {
  const lines = source.split("\n");
  const packageLine = lines.find((line) => line.startsWith("package "));
  if (!packageLine) throw new Error("ligne package introuvable");
  const existingImports = lines
    .filter((line) => line.startsWith("import "))
    .map((line) => line.trim());
  const imports = [
    ...new Set([...existingImports, ...REQUIRED_IMPORTS.map((name) => `import ${name}`)]),
  ].sort((a, b) => a.localeCompare(b, "en"));
  return `${packageLine}\n\n${imports.join("\n")}\n\n${CLASS_BODY}`;
}

function upsertColor(source, name, value) {
  const entry = `<color name="${name}">${value}</color>`;
  const pattern = new RegExp(`<color name="${name}">[^<]*</color>`);
  if (pattern.test(source)) return source.replace(pattern, entry);
  const closing = source.lastIndexOf("</resources>");
  if (closing === -1) throw new Error("balise </resources> introuvable dans colors.xml");
  const head = source.slice(0, closing);
  const separator = head.endsWith("\n") ? "" : "\n";
  return `${head}${separator}    ${entry}\n${source.slice(closing)}`;
}

function patchColors(source) {
  return upsertColor(upsertColor(source, "lavande_canvas", "#fbfaff"), "ic_launcher_background", "#8b7cf6");
}

function patchThemes(source) {
  if (source.includes('name="android:windowBackground"')) return source;
  const pattern = /([ \t]*)<\/style>/;
  if (!pattern.test(source)) throw new Error("balise </style> introuvable dans themes.xml");
  return source.replace(
    pattern,
    (_, indent) => `${indent}    <item name="android:windowBackground">@color/lavande_canvas</item>\n${indent}</style>`,
  );
}

const MANIFEST_ATTRS = [
  ["android:networkSecurityConfig", "@xml/network_security_config"],
  ["android:allowBackup", "false"],
  ["android:fullBackupContent", "false"],
  ["android:dataExtractionRules", "@xml/data_extraction_rules"],
];

function patchManifest(source) {
  const pattern = /<application\b[^>]*>/;
  if (!pattern.test(source)) throw new Error("balise <application> introuvable dans AndroidManifest.xml");
  return source.replace(pattern, (tag) => {
    let next = tag.replace(/\s*android:usesCleartextTraffic="[^"]*"/, "");
    for (const [name, value] of MANIFEST_ATTRS.slice().reverse()) {
      const attr = `${name}="${value}"`;
      next = next.includes(`${name}="`)
        ? next.replace(new RegExp(`${name}="[^"]*"`), attr)
        : next.replace("<application", `<application\n        ${attr}`);
    }
    return next;
  });
}

const REQUIRED_PERMISSIONS = ["android.permission.POST_NOTIFICATIONS"];

function patchPermissions(source) {
  return REQUIRED_PERMISSIONS.reduce((next, permission) => {
    if (next.includes(`android:name="${permission}"`)) return next;
    const line = `<uses-permission android:name="${permission}" />`;
    if (/<uses-permission\b[^>]*\/>/.test(next)) {
      return next.replace(/<uses-permission\b[^>]*\/>/, (tag) => `${tag}\n    ${line}`);
    }
    return next.replace("<application", `${line}\n\n    <application`);
  }, source);
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"];

const syncHosts = (process.env.LAVANDE_SYNC_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

for (const host of syncHosts) {
  if (!/^[A-Za-z0-9.-]+$/.test(host)) {
    throw new Error(`LAVANDE_SYNC_HOSTS : hôte invalide « ${host} » (nom ou IP, sans schéma ni port)`);
  }
}

const cleartextHosts = [...new Set([...LOOPBACK_HOSTS, ...syncHosts])];

function networkSecurityConfig(hosts) {
  const domains = hosts.map((host) => `        <domain includeSubdomains="false">${host}</domain>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
${domains}
    </domain-config>
</network-security-config>
`;
}

const BACKUP_EXCLUDES = [
  "secrets.enc",
  "secrets.key",
  "daemon-token",
  "mail.db",
  "mail.db-wal",
  "mail.db-shm",
  "app_webview",
];

function dataExtractionRules() {
  const block = (tag) => [
    `    <${tag}>`,
    ...["root", "file"].flatMap((domain) =>
      BACKUP_EXCLUDES.map((name) => `        <exclude domain="${domain}" path="${name}" />`),
    ),
    `    </${tag}>`,
  ].join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Secrets (clés, jeton du démon, base mail, localStorage WebView) : jamais copiés hors de l'appareil. -->
<data-extraction-rules>
${block("cloud-backup")}
${block("device-transfer")}
</data-extraction-rules>
`;
}

const ADAPTIVE_ICON = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;

const summary = [];
let modified = 0;

async function writeStatic(file, content, label) {
  if (existsSync(file) && (await readFile(file, "utf8")) === content) {
    summary.push(`${label} : déjà à jour`);
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  modified += 1;
  summary.push(`${label} : écrit`);
}

async function patchFile(file, transform, label) {
  if (!existsSync(file)) {
    summary.push(`${label} : absent, ignoré`);
    return;
  }
  const current = await readFile(file, "utf8");
  const next = transform(current);
  if (next === current) {
    summary.push(`${label} : déjà à jour`);
    return;
  }
  await writeFile(file, next, "utf8");
  modified += 1;
  summary.push(`${label} : mis à jour`);
}

const mainActivities = existsSync(appDir)
  ? readdirSync(appDir, { recursive: true })
      .filter((entry) => path.basename(String(entry)) === "MainActivity.kt")
      .map((entry) => path.join(appDir, String(entry)))
      .sort()
  : [];

if (mainActivities.length === 0) {
  summary.push("MainActivity.kt : absent, ignoré");
}
for (const file of mainActivities) {
  await patchFile(file, patchMainActivity, path.relative(genDir, file));
}

await patchFile(path.join(resValuesDir, "colors.xml"), patchColors, "res/values/colors.xml");
// `tauri icon` dépose un ic_launcher_background.xml séparé qui duplique la couleur de colors.xml.
const strayLauncherBg = path.join(resValuesDir, "ic_launcher_background.xml");
if (existsSync(strayLauncherBg)) {
  await rm(strayLauncherBg, { force: true });
  summary.push("res/values/ic_launcher_background.xml : supprimé (doublon de colors.xml)");
}
await writeStatic(
  path.join(resXmlDir, "network_security_config.xml"),
  networkSecurityConfig(cleartextHosts),
  `res/xml/network_security_config.xml (cleartext : ${cleartextHosts.join(", ")})`,
);
await writeStatic(
  path.join(resXmlDir, "data_extraction_rules.xml"),
  dataExtractionRules(),
  "res/xml/data_extraction_rules.xml",
);
await patchFile(
  path.join(appDir, "AndroidManifest.xml"),
  (source) => patchPermissions(patchManifest(source)),
  "AndroidManifest.xml (sauvegarde fermée, cleartext restreint au LAN, notifications)",
);
await patchFile(path.join(resValuesDir, "themes.xml"), patchThemes, "res/values/themes.xml");
await patchFile(
  path.join(appDir, "res", "values-night", "themes.xml"),
  patchThemes,
  "res/values-night/themes.xml",
);

for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
  await writeStatic(
    path.join(appDir, "res", "mipmap-anydpi-v26", name),
    ADAPTIVE_ICON,
    `res/mipmap-anydpi-v26/${name}`,
  );
}

console.log(summary.join("\n"));
console.log(modified > 0 ? `${modified} fichier(s) modifié(s)` : "aucune modification nécessaire");
