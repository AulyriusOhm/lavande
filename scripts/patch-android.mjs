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

const REQUIRED_PERMISSIONS = [
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.REQUEST_INSTALL_PACKAGES",
  "android.permission.RECEIVE_BOOT_COMPLETED",
  "android.permission.VIBRATE",
];

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

const INSTALL_RECEIVER_TAG = '<receiver android:name=".InstallResultReceiver" android:exported="false" />';

const WIDGET_RECEIVERS = `<receiver android:name=".LavandeWidgetProvider" android:exported="true">
          <intent-filter>
            <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
          </intent-filter>
          <meta-data
            android:name="android.appwidget.provider"
            android:resource="@xml/lavande_widget_info" />
        </receiver>
        <receiver android:name=".LavandeAgendaWidgetProvider" android:exported="true">
          <intent-filter>
            <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
          </intent-filter>
          <meta-data
            android:name="android.appwidget.provider"
            android:resource="@xml/lavande_agenda_widget_info" />
        </receiver>
        <receiver android:name=".BootReceiver" android:exported="false">
          <intent-filter>
            <action android:name="android.intent.action.BOOT_COMPLETED" />
          </intent-filter>
        </receiver>`;

function patchWidgetReceivers(source) {
  if (source.includes('android:name=".LavandeWidgetProvider"') && source.includes('android:name=".LavandeAgendaWidgetProvider"')) return source;
  const pattern = /([ \t]*)<\/application>/;
  if (!pattern.test(source)) throw new Error("balise </application> introuvable dans AndroidManifest.xml");
  if (!source.includes('android:name=".LavandeWidgetProvider"')) {
    source = source.replace(pattern, (_, indent) => `${indent}    ${WIDGET_RECEIVERS}\n${indent}</application>`);
  } else if (!source.includes('android:name=".LavandeAgendaWidgetProvider"')) {
    const agenda = `<receiver android:name=".LavandeAgendaWidgetProvider" android:exported="true">
          <intent-filter>
            <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
          </intent-filter>
          <meta-data
            android:name="android.appwidget.provider"
            android:resource="@xml/lavande_agenda_widget_info" />
        </receiver>`;
    source = source.replace(pattern, (_, indent) => `${indent}    ${agenda}\n${indent}</application>`);
  }
  return source;
}

const GRADLE_DEPS = [
  {
    marker: "androidx.work:work-runtime-ktx",
    entry: 'implementation("androidx.work:work-runtime-ktx:2.9.1")',
  },
  { marker: "androidx.core:core-ktx", entry: 'implementation("androidx.core:core-ktx:1.13.1")' },
];

/// WorkManager (synchro périodique) et core-ktx (NotificationCompat) manquent du
/// modèle Gradle généré : insérés une seule fois, avant la fermeture du bloc.
function patchGradle(source) {
  const missing = GRADLE_DEPS.filter((dep) => !source.includes(dep.marker));
  if (missing.length === 0) return source;
  const start = source.indexOf("dependencies {");
  if (start === -1) throw new Error("bloc « dependencies { » introuvable dans app/build.gradle.kts");
  const end = source.indexOf("\n}", start);
  if (end === -1) throw new Error("fin du bloc dependencies introuvable dans app/build.gradle.kts");
  const lines = missing.map((dep) => `    ${dep.entry}`).join("\n");
  return `${source.slice(0, end)}\n${lines}${source.slice(end)}`;
}

function patchInstallReceiver(source) {
  if (source.includes('android:name=".InstallResultReceiver"')) return source;
  const pattern = /([ \t]*)<\/application>/;
  if (!pattern.test(source)) throw new Error("balise </application> introuvable dans AndroidManifest.xml");
  return source.replace(pattern, (_, indent) => `${indent}    ${INSTALL_RECEIVER_TAG}\n${indent}</application>`);
}

const UPDATER_PLUGIN_KT = `package mail.lavande.app

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

@InvokeArg
class DownloadArgs { lateinit var url: String }

@InvokeArg
class InstallArgs { lateinit var path: String }

@TauriPlugin
class LavandeUpdaterPlugin(private val activity: Activity) : Plugin(activity) {

  @Command
  fun downloadApk(invoke: Invoke) {
    val args = invoke.parseArgs(DownloadArgs::class.java)
    val parsed = Uri.parse(args.url)
    val host = parsed.host ?: ""
    val loopback = host == "127.0.0.1" || host == "localhost" || host == "10.0.2.2"
    if (parsed.scheme != "https" && !(parsed.scheme == "http" && loopback)) {
      invoke.reject("URL de mise à jour invalide (https requis)"); return
    }
    thread {
      try {
        val dest = File(activity.cacheDir, "lavande-update.apk")
        val conn = URL(args.url).openConnection() as HttpURLConnection
        conn.connectTimeout = 30000; conn.readTimeout = 60000; conn.instanceFollowRedirects = true
        val total = conn.contentLengthLong
        var received = 0L
        conn.inputStream.use { input ->
          dest.outputStream().use { out ->
            val buf = ByteArray(64 * 1024)
            while (true) {
              val n = input.read(buf); if (n <= 0) break
              out.write(buf, 0, n); received += n
              val p = JSObject(); p.put("received", received); p.put("total", total)
              if (total > 0) p.put("percent", ((received * 100) / total).toInt())
              trigger("download-progress", p)
            }
          }
        }
        conn.disconnect()
        val res = JSObject(); res.put("path", dest.absolutePath); invoke.resolve(res)
      } catch (e: Exception) {
        invoke.reject("Téléchargement impossible : \${e.message}")
      }
    }
  }

  @Command
  fun canInstall(invoke: Invoke) {
    val allowed = if (Build.VERSION.SDK_INT >= 26) activity.packageManager.canRequestPackageInstalls()
      else Settings.Secure.getInt(activity.contentResolver, Settings.Secure.INSTALL_NON_MARKET_APPS, 0) == 1
    val res = JSObject(); res.put("allowed", allowed); invoke.resolve(res)
  }

  @Command
  fun openInstallSettings(invoke: Invoke) {
    val intent = if (Build.VERSION.SDK_INT >= 26)
      Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:\${activity.packageName}"))
    else Intent(Settings.ACTION_SECURITY_SETTINGS)
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    activity.startActivity(intent)
    invoke.resolve()
  }

  @Command
  fun installApk(invoke: Invoke) {
    val args = invoke.parseArgs(InstallArgs::class.java)
    try {
      val file = File(args.path)
      if (!file.exists()) { invoke.reject("APK introuvable"); return }
      val installer = activity.packageManager.packageInstaller
      val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
      params.setSize(file.length())
      val sessionId = installer.createSession(params)
      val session = installer.openSession(sessionId)
      session.openWrite("base.apk", 0, file.length()).use { out ->
        file.inputStream().use { it.copyTo(out) }
        session.fsync(out)
      }
      val intent = Intent(activity, InstallResultReceiver::class.java)
      val pending = PendingIntent.getBroadcast(activity, sessionId, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
      session.commit(pending.intentSender)
      session.close()
      val res = JSObject(); res.put("sessionId", sessionId); invoke.resolve(res)
    } catch (e: Exception) {
      invoke.reject("Installation impossible : \${e.message}")
    }
  }
}
`;

const INSTALL_RECEIVER_KT = `package mail.lavande.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build

class InstallResultReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
          else @Suppress("DEPRECATION") intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
        confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (confirm != null) context.startActivity(confirm)
      }
      PackageInstaller.STATUS_SUCCESS -> { }
      else -> android.util.Log.e("LavandeUpdater", "Installation échouée : \${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
    }
  }
}
`;

const BG_PREFS_KT = `package mail.lavande.app

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONException

/**
 * Préférences de la synchro de fond : interrupteur, comptes muets et dernier
 * résumé rendu par le widget. Le worker les écrit ; le widget, le récepteur de
 * démarrage et le plugin Tauri les relisent.
 */
object LavandeBgPrefs {
  private const val FILE = "lavande_bg"
  private const val KEY_ENABLED = "background_sync_enabled"
  private const val KEY_MUTED = "muted_accounts"
  private const val KEY_SUMMARY = "widget_summary"
  private const val KEY_AGENDA_SUMMARY = "widget_agenda_summary"
  private const val KEY_NOTIFIED = "notified_mails"
  private const val NOTIFIED_CAP = 200

  private fun open(context: Context): SharedPreferences =
    context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  fun enabled(context: Context): Boolean = open(context).getBoolean(KEY_ENABLED, false)

  fun setEnabled(context: Context, enabled: Boolean) {
    open(context).edit().putBoolean(KEY_ENABLED, enabled).apply()
  }

  fun muted(context: Context): Set<String> {
    val raw = open(context).getString(KEY_MUTED, "[]") ?: "[]"
    val muted = mutableSetOf<String>()
    try {
      val ids = JSONArray(raw)
      for (index in 0 until ids.length()) muted.add(ids.getString(index))
    } catch (e: JSONException) {
      android.util.Log.e("LavandeSync", "comptes muets illisibles : \${e.message}")
    }
    return muted
  }

  fun setMuted(context: Context, ids: List<String>) {
    open(context).edit().putString(KEY_MUTED, JSONArray(ids).toString()).apply()
  }

  fun summary(context: Context): String = open(context).getString(KEY_SUMMARY, "") ?: ""

  fun setSummary(context: Context, summary: String) {
    open(context).edit().putString(KEY_SUMMARY, summary).apply()
  }

  fun agendaSummary(context: Context): String = open(context).getString(KEY_AGENDA_SUMMARY, "") ?: ""

  fun setAgendaSummary(context: Context, summary: String) {
    open(context).edit().putString(KEY_AGENDA_SUMMARY, summary).apply()
  }

  /**
   * Clés des mails déjà notifiés, dans l'ordre d'arrivée. Un tableau JSON et non
   * un StringSet : le trim FIFO a besoin de l'ordre.
   */
  fun notified(context: Context): List<String> {
    val raw = open(context).getString(KEY_NOTIFIED, "[]") ?: "[]"
    val keys = mutableListOf<String>()
    try {
      val stored = JSONArray(raw)
      for (index in 0 until stored.length()) keys.add(stored.getString(index))
    } catch (e: JSONException) {
      android.util.Log.e("LavandeSync", "mails notifiés illisibles : \${e.message}")
    }
    return keys
  }

  fun setNotified(context: Context, keys: List<String>) {
    val trimmed = if (keys.size > NOTIFIED_CAP) keys.subList(keys.size - NOTIFIED_CAP, keys.size) else keys
    open(context).edit().putString(KEY_NOTIFIED, JSONArray(trimmed).toString()).apply()
  }

  /** Faux tant que le worker n'a jamais semé les clés : premier passage, aucune notification. */
  fun hasNotified(context: Context): Boolean = open(context).contains(KEY_NOTIFIED)
}
`;

const BG_WORKER_KT = `package mail.lavande.app

import android.app.ActivityManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Synchro de fond des boîtes : WorkManager réveille l'app même fermée, le Rust
 * ouvre sa propre instance du démon (même base SQLite), le résumé filtré est
 * stocké pour le widget puis poussé par LavandeWidgetProvider.refresh.
 */
class LavandeSyncWorker(context: Context, params: WorkerParameters) :
  CoroutineWorker(context, params) {

  companion object {
    private const val TAG = "LavandeSync"
    private const val PERIODIC_WORK = "lavande-mail-periodic"
    private const val ONE_SHOT_WORK = "lavande-mail-now"
    // Même canal que src/lib/notify.ts : une seule entrée dans les réglages Android.
    private const val CHANNEL_ID = "mails"
    private const val GROUP_ID = 1042
    private const val GROUP_KEY = "lavande.mails"

    private fun constraints(): Constraints = Constraints.Builder()
      .setRequiredNetworkType(NetworkType.CONNECTED)
      .setRequiresBatteryNotLow(true)
      .build()

    fun schedule(context: Context) {
      val request = PeriodicWorkRequestBuilder<LavandeSyncWorker>(15, TimeUnit.MINUTES)
        .setConstraints(constraints())
        .build()
      WorkManager.getInstance(context)
        .enqueueUniquePeriodicWork(PERIODIC_WORK, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun cancel(context: Context) {
      WorkManager.getInstance(context).cancelUniqueWork(PERIODIC_WORK)
    }

    fun requestOnce(context: Context) {
      val request = OneTimeWorkRequestBuilder<LavandeSyncWorker>()
        .setConstraints(constraints())
        .build()
      WorkManager.getInstance(context)
        .enqueueUniqueWork(ONE_SHOT_WORK, ExistingWorkPolicy.REPLACE, request)
    }
  }

  override suspend fun doWork(): Result {
    val context = applicationContext
    val payload = try {
      withContext(Dispatchers.IO) { BackgroundSyncLib.syncNow(context.dataDir.absolutePath) }
    } catch (error: UnsatisfiedLinkError) {
      return failed("bibliothèque native indisponible : \${error.message}")
    } catch (error: Exception) {
      return failed("appel natif interrompu : \${error.message}")
    }
    return try {
      val parsed = JSONObject(payload)
      if (parsed.has("error")) {
        return failed(parsed.optString("error", "synchro impossible"))
      }
      val summary = parsed.optJSONObject("summary")
      if (summary == null) {
        return failed("réponse native sans résumé")
      }
      publish(context, summary)
      Result.success()
    } catch (error: JSONException) {
      failed("réponse native illisible : \${error.message}")
    }
  }

  /**
   * Comptes muets (périmètre mails) filtrés ici : le Rust rend tous les comptes.
   * Le résumé filtré est mémorisé avant le rendu pour que le widget s'affiche
   * instantanément au prochain réveil du lanceur.
   */
  private fun publish(context: Context, summary: JSONObject) {
    val muted = LavandeBgPrefs.muted(context)
    val accounts = JSONArray()
    val unread = JSONObject()
    val labels = mutableMapOf<String, String>()
    val source = summary.optJSONArray("accounts") ?: JSONArray()
    for (index in 0 until source.length()) {
      val account = source.optJSONObject(index) ?: continue
      val id = account.optString("id")
      if (id.isEmpty() || muted.contains(id)) continue
      accounts.put(account)
      unread.put(id, account.optInt("unread", 0))
      labels[id] = account.optString("label", id)
    }
    val mails = JSONArray()
    val sourceMails = summary.optJSONArray("mails") ?: JSONArray()
    for (index in 0 until sourceMails.length()) {
      val mail = sourceMails.optJSONObject(index) ?: continue
      if (muted.contains(mail.optString("account"))) continue
      mails.put(mail)
    }
    var total = 0
    for (id in unread.keys()) total += unread.optInt(id, 0)
    val kept = JSONObject()
    kept.put("accounts", accounts)
    kept.put("mails", mails)
    kept.put("unread", total)
    kept.put("updated_at", summary.optLong("updated_at", System.currentTimeMillis() / 1000))

    LavandeBgPrefs.setSummary(context, kept.toString())
    LavandeWidgetProvider.refresh(context)
    notifyNewMails(context, mails, labels)
  }

  /**
   * Une notification par mail jamais notifié. Le premier passage sème les clés
   * sans rien notifier : sinon la première synchro déclenche une rafale pour
   * toute la boîte de réception.
   */
  private fun notifyNewMails(context: Context, mails: JSONArray, labels: Map<String, String>) {
    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) return
    // App au premier plan : le flux SSE (src/lib/notify.ts) notifie déjà.
    if (foreground(context)) return
    ensureChannel(manager)

    val keys = mutableListOf<String>()
    for (index in 0 until mails.length()) {
      val mail = mails.optJSONObject(index) ?: continue
      keys.add(keyOf(mail))
    }
    if (!LavandeBgPrefs.hasNotified(context)) {
      LavandeBgPrefs.setNotified(context, keys)
      return
    }

    val known = LavandeBgPrefs.notified(context).toMutableList()
    val seen = known.toMutableSet()
    val open = contentIntent(context)
    val fresh = mutableListOf<JSONObject>()
    for (index in 0 until mails.length()) {
      val mail = mails.optJSONObject(index) ?: continue
      val key = keyOf(mail)
      if (!seen.add(key)) continue
      known.add(key)
      fresh.add(mail)
      val account = mail.optString("account")
      manager.notify(
        key.hashCode(),
        NotificationCompat.Builder(context, CHANNEL_ID)
          .setSmallIcon(R.drawable.ic_lavande_notification)
          .setContentTitle(mail.optString("from").ifEmpty { "Nouveau message" })
          .setContentText(mail.optString("subject"))
          .setSubText(if (labels.size > 1) mail.optString("label") else null)
          .setPriority(NotificationCompat.PRIORITY_HIGH)
          .setAutoCancel(true)
          .setContentIntent(open)
          .setGroup("$GROUP_KEY.$account")
          .build(),
      )
    }
    LavandeBgPrefs.setNotified(context, known)
    if (fresh.size < 2) return
    manager.notify(
      GROUP_ID,
      NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_lavande_notification)
        .setContentTitle("\${fresh.size} nouveaux mails")
        .setContentText(fresh.joinToString(" · ") { it.optString("from") })
        .setStyle(
          NotificationCompat.BigTextStyle()
            .bigText(fresh.joinToString("\\n") { it.optString("from") + " — " + it.optString("subject") }),
        )
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setAutoCancel(true)
        .setContentIntent(open)
        .setGroup(GROUP_KEY)
        .setGroupSummary(true)
        .build(),
    )
  }

  /** \`id\` du fil ne bouge pas quand un nouveau message s'y ajoute : \`message_id\` prime. */
  private fun keyOf(mail: JSONObject): String {
    val identity = mail.optString("message_id").ifEmpty { mail.optString("id") }
    return mail.optString("account") + "|" + identity
  }

  private fun ensureChannel(manager: NotificationManagerCompat) {
    if (Build.VERSION.SDK_INT < 26) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Nouveaux mails",
      NotificationManager.IMPORTANCE_HIGH,
    )
    channel.description = "Un message arrive dans la boîte de réception d'un compte"
    manager.createNotificationChannel(channel)
  }

  private fun contentIntent(context: Context): PendingIntent = PendingIntent.getActivity(
    context,
    0,
    Intent(context, MainActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )

  private fun foreground(context: Context): Boolean {
    val activity = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
    val processes = activity.runningAppProcesses ?: return false
    return processes.any {
      it.processName == context.packageName &&
        it.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
    }
  }

  /** Un seul réessai (réseau absent, veille) : WorkManager reprend au prochain réveil. */
  private fun failed(message: String): Result {
    android.util.Log.e(TAG, message)
    return if (runAttemptCount < 1) Result.retry() else Result.failure()
  }
}
`;

const BG_PLUGIN_KT = `package mail.lavande.app

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class BackgroundSyncArgs { var enabled: Boolean = false }

@InvokeArg
class MutedAccountsArgs { var ids: List<String> = emptyList() }

@InvokeArg
class AgendaSummaryArgs { var summary: String = "" }

@TauriPlugin
class BackgroundSyncPlugin(private val activity: Activity) : Plugin(activity) {

  @Command
  fun setBackgroundSync(invoke: Invoke) {
    val args = invoke.parseArgs(BackgroundSyncArgs::class.java)
    LavandeBgPrefs.setEnabled(activity, args.enabled)
    if (args.enabled) {
      LavandeSyncWorker.schedule(activity)
      LavandeSyncWorker.requestOnce(activity)
    } else {
      LavandeSyncWorker.cancel(activity)
    }
    val result = JSObject()
    result.put("enabled", args.enabled)
    invoke.resolve(result)
  }

  @Command
  fun backgroundSyncState(invoke: Invoke) {
    val result = JSObject()
    result.put("enabled", LavandeBgPrefs.enabled(activity))
    invoke.resolve(result)
  }

  @Command
  fun setMutedAccounts(invoke: Invoke) {
    val args = invoke.parseArgs(MutedAccountsArgs::class.java)
    LavandeBgPrefs.setMuted(activity, args.ids)
    LavandeWidgetProvider.refresh(activity)
    invoke.resolve(JSObject())
  }

  @Command
  fun setWidgetAgendaSummary(invoke: Invoke) {
    val args = invoke.parseArgs(AgendaSummaryArgs::class.java)
    LavandeBgPrefs.setAgendaSummary(activity, args.summary)
    LavandeAgendaWidgetProvider.refresh(activity)
    invoke.resolve(JSObject())
  }

  @Command
  fun syncNow(invoke: Invoke) {
    LavandeSyncWorker.requestOnce(activity)
    val result = JSObject()
    result.put("ok", true)
    invoke.resolve(result)
  }
}
`;

const ATTACHMENTS_PLUGIN_KT = `package mail.lavande.app

import android.app.Activity
import android.content.Intent
import android.util.Base64
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class OpenAttachmentArgs { lateinit var name: String; var mime: String = ""; lateinit var dataBase64: String }

/**
 * Une ancre de téléchargement n'écrit rien dans la WebView Android (aucun
 * DownloadListener) : le front envoie donc les octets ici, le fichier part dans
 * le cache — couvert par le FileProvider déclaré au manifeste — et le système
 * l'ouvre avec l'application qui sait le lire.
 */
@TauriPlugin
class LavandeAttachmentsPlugin(private val activity: Activity) : Plugin(activity) {

  @Command
  fun openAttachment(invoke: Invoke) {
    val args = invoke.parseArgs(OpenAttachmentArgs::class.java)
    if (args.mime == "application/vnd.android.package-archive") {
      invoke.reject("installation d'APK refusée : passe par la mise à jour de l'application"); return
    }
    val bytes = try {
      Base64.decode(args.dataBase64, Base64.DEFAULT)
    } catch (e: IllegalArgumentException) {
      invoke.reject("pièce jointe illisible : \${e.message}"); return
    }
    if (bytes.size > 25 * 1024 * 1024) {
      invoke.reject("pièce jointe trop lourde : 25 Mo maximum"); return
    }
    try {
      val dir = File(activity.cacheDir, "attachments")
      dir.mkdirs()
      val dest = freeFile(dir, cleanName(args.name))
      dest.writeBytes(bytes)
      val uri = FileProvider.getUriForFile(activity, "\${activity.packageName}.fileprovider", dest)
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, args.mime.ifEmpty { "application/octet-stream" })
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      activity.startActivity(Intent.createChooser(intent, "Ouvrir la pièce jointe"))
      val result = JSObject(); result.put("path", dest.absolutePath); invoke.resolve(result)
    } catch (e: Exception) {
      invoke.reject("ouverture impossible : \${e.message}")
    }
  }

  private fun cleanName(raw: String): String {
    val cleaned = raw.map { c ->
      if (c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c == '-' || c == '_' || c == '.' || c == ' ' || c == '(' || c == ')') c else '_'
    }.joinToString("").trim().trim('.')
    return if (cleaned.isEmpty()) "piece-jointe" else cleaned
  }

  private fun freeFile(dir: File, name: String): File {
    val first = File(dir, name)
    if (!first.exists()) return first
    val dot = name.lastIndexOf('.')
    val stem = if (dot > 0) name.substring(0, dot) else name
    val extension = if (dot > 0) name.substring(dot) else ""
    var index = 1
    while (true) {
      val next = File(dir, "\$stem (\$index)\$extension")
      if (!next.exists()) return next
      index += 1
    }
  }
}
`;

const BG_LIB_KT = `package mail.lavande.app

/**
 * Entrée JNI de la synchro de fond : WorkManager peut réveiller le worker sans
 * activité ni WebView, la bibliothèque native est donc chargée ici.
 */
object BackgroundSyncLib {
  init {
    System.loadLibrary("lavande_lib")
  }

  external fun syncNow(dataDir: String): String
}
`;

const BG_WIDGET_KT = `package mail.lavande.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Widget mails 2×2 « A·Total » : total en grand, non-lus par compte, dernier
 * expéditeur. Ne lit que le résumé stocké par le worker (widget_summary), donc
 * affichage instantané même app fermée. Couleurs sémantiques (clair/sombre/Material You).
 */
class LavandeWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    refresh(context)
  }

  companion object {
    fun refresh(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(ComponentName(context, LavandeWidgetProvider::class.java))
      if (ids.isEmpty()) return
      val views = render(context)
      for (id in ids) manager.updateAppWidget(id, views)
    }

    private fun render(context: Context): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.lavande_widget)
      val open = PendingIntent.getActivity(
        context,
        0,
        Intent(context, MainActivity::class.java)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      views.setOnClickPendingIntent(R.id.lavande_widget_root, open)
      views.setViewVisibility(R.id.lavande_widget_normal, View.GONE)
      views.setViewVisibility(R.id.lavande_widget_free, View.GONE)
      views.setViewVisibility(R.id.lavande_widget_none, View.GONE)
      views.setViewVisibility(R.id.lavande_widget_warn, View.GONE)

      val summary = stored(context)
      if (summary == null || (summary.optJSONArray("accounts")?.length() ?: 0) == 0) {
        views.setViewVisibility(R.id.lavande_widget_none, View.VISIBLE)
        return views
      }

      val unread = summary.optInt("unread", 0)
      if (unread == 0) {
        views.setViewVisibility(R.id.lavande_widget_free, View.VISIBLE)
        views.setTextViewText(R.id.lavande_widget_free_sub, "Synchro à " + clock(summary.optLong("updated_at", 0)))
        return views
      }

      views.setViewVisibility(R.id.lavande_widget_normal, View.VISIBLE)
      views.setTextViewText(R.id.lavande_widget_number, unread.toString())
      views.setTextViewText(R.id.lavande_widget_unit, if (unread == 1) "non lu" else "non lus")
      views.setTextViewText(R.id.lavande_widget_accounts, accountsLine(summary.optJSONArray("accounts") ?: JSONArray()))

      val mails = summary.optJSONArray("mails") ?: JSONArray()
      val first = mails.optJSONObject(0)
      if (first != null) {
        views.setViewVisibility(R.id.lavande_widget_last, View.VISIBLE)
        views.setTextViewText(R.id.lavande_widget_sender, first.optString("from"))
        views.setTextViewText(R.id.lavande_widget_time, clock(first.optLong("date", 0)))
        views.setImageViewResource(
          R.id.lavande_widget_dot,
          if (first.optBoolean("unread", true)) R.drawable.lavande_widget_dot else R.drawable.lavande_widget_dot_read,
        )
      } else {
        views.setViewVisibility(R.id.lavande_widget_last, View.GONE)
      }
      return views
    }

    private fun accountsLine(accounts: JSONArray): String {
      val parts = mutableListOf<String>()
      for (index in 0 until accounts.length()) {
        val account = accounts.optJSONObject(index) ?: continue
        parts.add(account.optString("label") + " " + account.optInt("unread", 0))
      }
      return parts.joinToString(" · ")
    }

    private fun clock(seconds: Long): String {
      if (seconds <= 0) return ""
      return SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(seconds * 1000))
    }

    private fun stored(context: Context): JSONObject? {
      val raw = LavandeBgPrefs.summary(context)
      if (raw.isEmpty()) return null
      return try {
        JSONObject(raw)
      } catch (e: JSONException) {
        android.util.Log.e("LavandeSync", "résumé du widget illisible : \${e.message}")
        null
      }
    }
  }
}
`;

const BG_BOOT_KT = `package mail.lavande.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** WorkManager perd ses échéances au redémarrage : la synchro de fond se réinscrit. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
    if (!LavandeBgPrefs.enabled(context)) return
    LavandeSyncWorker.schedule(context)
  }
}
`;

const BG_WIDGET_LAYOUT_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- RemoteViews : LinearLayout uniquement. Couleurs sémantiques (values / values-night / values-v31). -->
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/lavande_widget_root"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="@drawable/lavande_widget_bg"
    android:orientation="vertical"
    android:padding="14dp">

    <TextView
        android:id="@+id/lavande_widget_brand"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:text="@string/lavande_widget_brand"
        android:textColor="@color/lavande_widget_ink_soft"
        android:textSize="11sp"
        android:textStyle="bold" />

    <LinearLayout
        android:id="@+id/lavande_widget_normal"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:orientation="vertical">

        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginTop="6dp"
            android:gravity="bottom"
            android:orientation="horizontal">

            <TextView
                android:id="@+id/lavande_widget_number"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:textColor="@color/lavande_widget_accent_ink"
                android:textSize="28sp"
                android:textStyle="bold" />

            <TextView
                android:id="@+id/lavande_widget_unit"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:layout_marginStart="6dp"
                android:layout_marginBottom="3dp"
                android:textColor="@color/lavande_widget_ink_soft"
                android:textSize="12sp" />
        </LinearLayout>

        <TextView
            android:id="@+id/lavande_widget_accounts"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginTop="4dp"
            android:ellipsize="end"
            android:maxLines="1"
            android:textColor="@color/lavande_widget_ink_soft"
            android:textSize="11sp" />

        <LinearLayout
            android:id="@+id/lavande_widget_last"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginTop="8dp"
            android:gravity="center_vertical"
            android:orientation="horizontal">

            <ImageView
                android:id="@+id/lavande_widget_dot"
                android:layout_width="7dp"
                android:layout_height="7dp"
                android:contentDescription="@null"
                android:src="@drawable/lavande_widget_dot" />

            <TextView
                android:id="@+id/lavande_widget_sender"
                android:layout_width="0dp"
                android:layout_height="wrap_content"
                android:layout_marginStart="6dp"
                android:layout_weight="1"
                android:ellipsize="end"
                android:maxLines="1"
                android:textColor="@color/lavande_widget_ink"
                android:textSize="12sp"
                android:textStyle="bold" />

            <TextView
                android:id="@+id/lavande_widget_time"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:layout_marginStart="6dp"
                android:textColor="@color/lavande_widget_ink_muted"
                android:textSize="10sp" />
        </LinearLayout>
    </LinearLayout>

    <LinearLayout
        android:id="@+id/lavande_widget_free"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:gravity="center"
        android:orientation="vertical"
        android:visibility="gone">

        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="Boîte calme"
            android:textColor="@color/lavande_widget_ink"
            android:textSize="13sp"
            android:textStyle="bold" />

        <TextView
            android:id="@+id/lavande_widget_free_sub"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginTop="2dp"
            android:textColor="@color/lavande_widget_ink_muted"
            android:textSize="11sp" />
    </LinearLayout>

    <LinearLayout
        android:id="@+id/lavande_widget_none"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:gravity="center"
        android:orientation="vertical"
        android:visibility="gone">

        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="Aucun compte mail"
            android:textColor="@color/lavande_widget_ink"
            android:textSize="13sp"
            android:textStyle="bold" />

        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginTop="2dp"
            android:text="Ouvrir Lavande"
            android:textColor="@color/lavande_widget_ink_muted"
            android:textSize="11sp" />
    </LinearLayout>

    <TextView
        android:id="@+id/lavande_widget_warn"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:ellipsize="end"
        android:maxLines="1"
        android:textColor="@color/lavande_widget_warn"
        android:textSize="10sp"
        android:visibility="gone" />
</LinearLayout>
`;

const BG_WIDGET_INFO_XML = `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:initialLayout="@layout/lavande_widget"
    android:minHeight="110dp"
    android:minWidth="110dp"
    android:resizeMode="horizontal|vertical"
    android:targetCellHeight="2"
    android:targetCellWidth="2"
    android:updatePeriodMillis="0"
    android:widgetCategory="home_screen" />
`;

const BG_WIDGET_BG_XML = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android"
    android:shape="rectangle">
    <solid android:color="@color/lavande_widget_surface" />
    <corners android:radius="26dp" />
    <stroke
        android:width="1dp"
        android:color="@color/lavande_widget_line" />
</shape>
`;

const BG_AGENDA_WIDGET_KT = `package mail.lavande.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import org.json.JSONException
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * Widget agenda 2×2 « A·Prochain » : prochain rendez-vous (heure, titre,
 * calendrier, compte à rebours) ou, jour libre (cas fréquent), la date en grand
 * + le prochain événement même lointain. Lit le résumé poussé par le front
 * (widget_agenda_summary). Couleurs sémantiques + tons calendriers fixes.
 */
class LavandeAgendaWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    refresh(context)
  }

  companion object {
    fun refresh(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(ComponentName(context, LavandeAgendaWidgetProvider::class.java))
      if (ids.isEmpty()) return
      val views = render(context)
      for (id in ids) manager.updateAppWidget(id, views)
    }

    private fun render(context: Context): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.lavande_agenda_widget)
      val open = PendingIntent.getActivity(
        context,
        1,
        Intent(context, MainActivity::class.java)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      views.setOnClickPendingIntent(R.id.lavande_agenda_root, open)
      views.setViewVisibility(R.id.lavande_agenda_date, View.GONE)
      views.setViewVisibility(R.id.lavande_agenda_normal, View.GONE)
      views.setViewVisibility(R.id.lavande_agenda_free, View.GONE)
      views.setViewVisibility(R.id.lavande_agenda_none, View.GONE)

      val summary = stored(context)
      if (summary == null) {
        views.setViewVisibility(R.id.lavande_agenda_none, View.VISIBLE)
        return views
      }

      val now = System.currentTimeMillis() / 1000
      val next = summary.optJSONObject("next")
      if (summary.optBoolean("free_today", false)) {
        views.setViewVisibility(R.id.lavande_agenda_free, View.VISIBLE)
        val cal = Calendar.getInstance()
        views.setTextViewText(R.id.lavande_agenda_fd_num, cal.get(Calendar.DAY_OF_MONTH).toString())
        views.setTextViewText(R.id.lavande_agenda_fd_wd, capitalize(SimpleDateFormat("EEEE", Locale.FRANCE).format(Date())))
        views.setTextViewText(R.id.lavande_agenda_fd_month, SimpleDateFormat("MMMM yyyy", Locale.FRANCE).format(Date()))
        if (next != null) {
          views.setViewVisibility(R.id.lavande_agenda_fd_next, View.VISIBLE)
          views.setTextViewText(R.id.lavande_agenda_fd_next, "Prochain · " + SimpleDateFormat("EEE d MMM · HH:mm", Locale.FRANCE).format(Date(next.optLong("start", 0) * 1000)))
          views.setTextViewText(R.id.lavande_agenda_fd_nexttitle, next.optString("title"))
          views.setTextColor(R.id.lavande_agenda_fd_next, toneColor(context, next.optInt("tone", 0)))
        } else {
          views.setViewVisibility(R.id.lavande_agenda_fd_next, View.GONE)
          views.setTextViewText(R.id.lavande_agenda_fd_nexttitle, "")
        }
        return views
      }

      views.setViewVisibility(R.id.lavande_agenda_date, View.VISIBLE)
      views.setTextViewText(R.id.lavande_agenda_date, SimpleDateFormat("EEE d MMM", Locale.FRANCE).format(Date()))
      views.setViewVisibility(R.id.lavande_agenda_normal, View.VISIBLE)
      if (next != null) {
        val start = next.optLong("start", 0)
        views.setTextViewText(R.id.lavande_agenda_next_time, SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(start * 1000)))
        views.setTextViewText(R.id.lavande_agenda_next_title, next.optString("title"))
        val location = next.optString("location", "")
        val meta = next.optString("calendar", "") + (if (location.isNotEmpty()) " · " + location else "")
        views.setTextViewText(R.id.lavande_agenda_next_meta, meta)
        views.setTextColor(R.id.lavande_agenda_next_meta, toneColor(context, next.optInt("tone", 0)))
        views.setTextViewText(R.id.lavande_agenda_countdown, countdown(start, now))
      }
      return views
    }

    private fun countdown(start: Long, now: Long): String {
      val delta = start - now
      if (delta <= 0) return "en cours"
      val minutes = delta / 60
      val hours = minutes / 60
      val rest = minutes % 60
      return when {
        hours > 0 -> "dans " + hours + " h " + rest.toString().padStart(2, '0')
        minutes > 0 -> "dans " + minutes + " min"
        else -> " imminent"
      }
    }

    private fun toneColor(context: Context, tone: Int): Int {
      val res = when (tone % 5) {
        2 -> R.color.lavande_widget_cal_perso
        3 -> R.color.lavande_widget_cal_clients
        else -> R.color.lavande_widget_accent
      }
      return ContextCompat.getColor(context, res)
    }

    private fun capitalize(text: String): String =
      text.replaceFirstChar { if (it.isLowerCase()) it.titlecase(Locale.FRANCE) else it.toString() }

    private fun stored(context: Context): JSONObject? {
      val raw = LavandeBgPrefs.agendaSummary(context)
      if (raw.isEmpty()) return null
      return try {
        JSONObject(raw)
      } catch (e: JSONException) {
        android.util.Log.e("LavandeSync", "résumé agenda illisible : \${e.message}")
        null
      }
    }
  }
}
`;

const BG_AGENDA_LAYOUT_XML = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/lavande_agenda_root"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="@drawable/lavande_widget_bg"
    android:orientation="vertical"
    android:padding="14dp">

    <TextView
        android:id="@+id/lavande_agenda_date"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:textColor="@color/lavande_widget_ink_muted"
        android:textSize="10sp"
        android:textStyle="bold"
        android:visibility="gone" />

    <LinearLayout
        android:id="@+id/lavande_agenda_normal"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:gravity="center_vertical"
        android:orientation="vertical"
        android:visibility="gone">

        <TextView
            android:id="@+id/lavande_agenda_next_time"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:textColor="@color/lavande_widget_accent_ink"
            android:textSize="24sp"
            android:textStyle="bold" />

        <TextView
            android:id="@+id/lavande_agenda_next_title"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginTop="3dp"
            android:ellipsize="end"
            android:maxLines="2"
            android:textColor="@color/lavande_widget_ink"
            android:textSize="12sp"
            android:textStyle="bold" />

        <TextView
            android:id="@+id/lavande_agenda_next_meta"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginTop="3dp"
            android:ellipsize="end"
            android:maxLines="1"
            android:textColor="@color/lavande_widget_ink_soft"
            android:textSize="10sp" />

        <TextView
            android:id="@+id/lavande_agenda_countdown"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginTop="8dp"
            android:gravity="center"
            android:textColor="@color/lavande_widget_accent_ink"
            android:textSize="11sp"
            android:textStyle="bold" />
    </LinearLayout>

    <LinearLayout
        android:id="@+id/lavande_agenda_free"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:gravity="center_vertical"
        android:orientation="vertical"
        android:visibility="gone">

        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:gravity="center_vertical"
            android:orientation="horizontal">

            <TextView
                android:id="@+id/lavande_agenda_fd_num"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:textColor="@color/lavande_widget_accent_ink"
                android:textSize="30sp"
                android:textStyle="bold" />

            <LinearLayout
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:layout_marginStart="8dp"
                android:orientation="vertical">

                <TextView
                    android:id="@+id/lavande_agenda_fd_wd"
                    android:layout_width="wrap_content"
                    android:layout_height="wrap_content"
                    android:textColor="@color/lavande_widget_ink"
                    android:textSize="12sp"
                    android:textStyle="bold" />

                <TextView
                    android:id="@+id/lavande_agenda_fd_month"
                    android:layout_width="wrap_content"
                    android:layout_height="wrap_content"
                    android:textColor="@color/lavande_widget_ink_muted"
                    android:textSize="10sp" />
            </LinearLayout>
        </LinearLayout>

        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginTop="5dp"
            android:text="Journée libre"
            android:textColor="@color/lavande_widget_ink_soft"
            android:textSize="12sp"
            android:textStyle="bold" />

        <TextView
            android:id="@+id/lavande_agenda_fd_next"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginTop="8dp"
            android:ellipsize="end"
            android:maxLines="1"
            android:textColor="@color/lavande_widget_ink_soft"
            android:textSize="10sp"
            android:textStyle="bold" />

        <TextView
            android:id="@+id/lavande_agenda_fd_nexttitle"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginTop="1dp"
            android:ellipsize="end"
            android:maxLines="1"
            android:textColor="@color/lavande_widget_ink"
            android:textSize="11sp"
            android:textStyle="bold" />
    </LinearLayout>

    <LinearLayout
        android:id="@+id/lavande_agenda_none"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:gravity="center"
        android:orientation="vertical"
        android:visibility="gone">

        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="Aucun calendrier"
            android:textColor="@color/lavande_widget_ink"
            android:textSize="13sp"
            android:textStyle="bold" />

        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginTop="2dp"
            android:text="Ouvrir Lavande"
            android:textColor="@color/lavande_widget_ink_muted"
            android:textSize="11sp" />
    </LinearLayout>
</LinearLayout>
`;

const BG_AGENDA_INFO_XML = `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:initialLayout="@layout/lavande_agenda_widget"
    android:minHeight="110dp"
    android:minWidth="110dp"
    android:resizeMode="horizontal|vertical"
    android:targetCellHeight="2"
    android:targetCellWidth="2"
    android:updatePeriodMillis="0"
    android:widgetCategory="home_screen" />
`;

const WIDGET_DOT_XML = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="oval">
    <solid android:color="@color/lavande_widget_accent" />
    <size android:width="7dp" android:height="7dp" />
</shape>
`;

const WIDGET_DOT_READ_XML = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="oval">
    <solid android:color="@android:color/transparent" />
    <stroke android:width="1.5dp" android:color="@color/lavande_widget_ink_muted" />
    <size android:width="7dp" android:height="7dp" />
</shape>
`;

// Couleurs sémantiques du widget : clair Lavande, sombre Orchidée, Material You (API 31+).
// Seul le ton 0 (Pro) suit l'accent ; Perso (émeraude) et Clients (ambre) restent fixes.
const WIDGET_COLORS_LIGHT = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="lavande_widget_surface">#FFFFFF</color>
    <color name="lavande_widget_ink">#1B1523</color>
    <color name="lavande_widget_ink_soft">#6B6478</color>
    <color name="lavande_widget_ink_muted">#726C7F</color>
    <color name="lavande_widget_line">#ECE8F5</color>
    <color name="lavande_widget_accent">#8B7CF6</color>
    <color name="lavande_widget_accent_soft">#EDEAFB</color>
    <color name="lavande_widget_accent_ink">#5A4FB8</color>
    <color name="lavande_widget_accent_ring">#C9C2F9</color>
    <color name="lavande_widget_cal_perso">#10B981</color>
    <color name="lavande_widget_cal_clients">#F59E0B</color>
    <color name="lavande_widget_warn">#D97706</color>
</resources>
`;

const WIDGET_COLORS_DARK = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="lavande_widget_surface">#16131F</color>
    <color name="lavande_widget_ink">#F4F1FA</color>
    <color name="lavande_widget_ink_soft">#A8A1B8</color>
    <color name="lavande_widget_ink_muted">#8C8699</color>
    <color name="lavande_widget_line">#2A2438</color>
    <color name="lavande_widget_accent">#8B7CF6</color>
    <color name="lavande_widget_accent_soft">#232035</color>
    <color name="lavande_widget_accent_ink">#B3A9F9</color>
    <color name="lavande_widget_accent_ring">#4A4370</color>
    <color name="lavande_widget_cal_perso">#34D399</color>
    <color name="lavande_widget_cal_clients">#FBBF24</color>
    <color name="lavande_widget_warn">#FBBF24</color>
</resources>
`;

const WIDGET_COLORS_V31 = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="lavande_widget_surface">@android:color/system_neutral1_50</color>
    <color name="lavande_widget_ink">@android:color/system_neutral1_900</color>
    <color name="lavande_widget_ink_soft">@android:color/system_neutral2_600</color>
    <color name="lavande_widget_ink_muted">@android:color/system_neutral2_500</color>
    <color name="lavande_widget_line">@android:color/system_neutral1_200</color>
    <color name="lavande_widget_accent">@android:color/system_accent1_400</color>
    <color name="lavande_widget_accent_soft">@android:color/system_accent1_100</color>
    <color name="lavande_widget_accent_ink">@android:color/system_accent1_700</color>
    <color name="lavande_widget_accent_ring">@android:color/system_accent1_200</color>
</resources>
`;

const WIDGET_COLORS_NIGHT_V31 = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="lavande_widget_surface">@android:color/system_neutral1_800</color>
    <color name="lavande_widget_ink">@android:color/system_neutral1_100</color>
    <color name="lavande_widget_ink_soft">@android:color/system_neutral2_300</color>
    <color name="lavande_widget_ink_muted">@android:color/system_neutral2_400</color>
    <color name="lavande_widget_line">@android:color/system_neutral1_700</color>
    <color name="lavande_widget_accent">@android:color/system_accent1_200</color>
    <color name="lavande_widget_accent_soft">@android:color/system_accent1_700</color>
    <color name="lavande_widget_accent_ink">@android:color/system_accent1_100</color>
    <color name="lavande_widget_accent_ring">@android:color/system_accent1_500</color>
</resources>
`;

const WIDGET_STRINGS_LIGHT = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="lavande_widget_brand">Lavande</string>
</resources>
`;

const WIDGET_STRINGS_DARK = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="lavande_widget_brand">Orchidée</string>
</resources>
`;

const BG_NOTIFICATION_ICON_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- Petite icône de notification : silhouette blanche, exigée par Android 8+. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFFFF"
        android:pathData="M20,4H4C2.9,4 2,4.9 2,6v12c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2V6C22,4.9 21.1,4 20,4zM20,8l-8,5 -8,-5V6l8,5 8,-5V8z" />
</vector>
`;

const PROGUARD_WORK_PRO = `# Room instancie sa base par réflexion (\`WorkDatabase_Impl\`), mais R8 en
# release renomme la classe : \`WorkManagerInitializer\`, exécuté par
# androidx.startup au démarrage de l'app, échoue alors avec « Failed to create
# an instance of class androidx.work.impl.WorkDatabase » et l'app crashe avant
# toute activité. Les AAR ne portent pas ces règles pour la base interne de
# WorkManager.
-keep class androidx.work.impl.WorkDatabase_Impl { *; }
-keep class * extends androidx.room.RoomDatabase { *; }
-keepclassmembers class * extends androidx.room.RoomDatabase { <init>(); }
`;

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
  (source) =>
    patchWidgetReceivers(
      patchInstallReceiver(patchPermissions(patchManifest(source))),
    ),
  "AndroidManifest.xml (sauvegarde fermée, cleartext restreint au LAN, notifications, installation d'APK, widget et démarrage)",
);
const kotlinDir = path.join(appDir, "java", "mail", "lavande", "app");
await writeStatic(
  path.join(kotlinDir, "LavandeUpdaterPlugin.kt"),
  UPDATER_PLUGIN_KT,
  "java/mail/lavande/app/LavandeUpdaterPlugin.kt",
);
await writeStatic(
  path.join(kotlinDir, "InstallResultReceiver.kt"),
  INSTALL_RECEIVER_KT,
  "java/mail/lavande/app/InstallResultReceiver.kt",
);
await writeStatic(
  path.join(kotlinDir, "LavandeBgPrefs.kt"),
  BG_PREFS_KT,
  "java/mail/lavande/app/LavandeBgPrefs.kt",
);
await writeStatic(
  path.join(kotlinDir, "BackgroundSyncLib.kt"),
  BG_LIB_KT,
  "java/mail/lavande/app/BackgroundSyncLib.kt",
);
await writeStatic(
  path.join(kotlinDir, "BackgroundSyncPlugin.kt"),
  BG_PLUGIN_KT,
  "java/mail/lavande/app/BackgroundSyncPlugin.kt",
);
await writeStatic(
  path.join(kotlinDir, "LavandeAttachmentsPlugin.kt"),
  ATTACHMENTS_PLUGIN_KT,
  "java/mail/lavande/app/LavandeAttachmentsPlugin.kt",
);
await writeStatic(
  path.join(kotlinDir, "LavandeSyncWorker.kt"),
  BG_WORKER_KT,
  "java/mail/lavande/app/LavandeSyncWorker.kt",
);
await writeStatic(
  path.join(kotlinDir, "LavandeWidgetProvider.kt"),
  BG_WIDGET_KT,
  "java/mail/lavande/app/LavandeWidgetProvider.kt",
);
await writeStatic(
  path.join(kotlinDir, "BootReceiver.kt"),
  BG_BOOT_KT,
  "java/mail/lavande/app/BootReceiver.kt",
);
await writeStatic(
  path.join(appDir, "res", "layout", "lavande_widget.xml"),
  BG_WIDGET_LAYOUT_XML,
  "res/layout/lavande_widget.xml",
);
await writeStatic(
  path.join(resXmlDir, "lavande_widget_info.xml"),
  BG_WIDGET_INFO_XML,
  "res/xml/lavande_widget_info.xml",
);
await writeStatic(
  path.join(appDir, "res", "drawable", "lavande_widget_bg.xml"),
  BG_WIDGET_BG_XML,
  "res/drawable/lavande_widget_bg.xml",
);
await writeStatic(
  path.join(kotlinDir, "LavandeAgendaWidgetProvider.kt"),
  BG_AGENDA_WIDGET_KT,
  "java/mail/lavande/app/LavandeAgendaWidgetProvider.kt",
);
await writeStatic(
  path.join(appDir, "res", "layout", "lavande_agenda_widget.xml"),
  BG_AGENDA_LAYOUT_XML,
  "res/layout/lavande_agenda_widget.xml",
);
await writeStatic(
  path.join(resXmlDir, "lavande_agenda_widget_info.xml"),
  BG_AGENDA_INFO_XML,
  "res/xml/lavande_agenda_widget_info.xml",
);
await writeStatic(
  path.join(appDir, "res", "drawable", "lavande_widget_dot.xml"),
  WIDGET_DOT_XML,
  "res/drawable/lavande_widget_dot.xml",
);
await writeStatic(
  path.join(appDir, "res", "drawable", "lavande_widget_dot_read.xml"),
  WIDGET_DOT_READ_XML,
  "res/drawable/lavande_widget_dot_read.xml",
);
for (const [qualifier, colors] of [
  ["values", WIDGET_COLORS_LIGHT],
  ["values-night", WIDGET_COLORS_DARK],
  ["values-v31", WIDGET_COLORS_V31],
  ["values-night-v31", WIDGET_COLORS_NIGHT_V31],
]) {
  await writeStatic(
    path.join(appDir, "res", qualifier, "lavande_widget_colors.xml"),
    colors,
    `res/${qualifier}/lavande_widget_colors.xml`,
  );
}
for (const [qualifier, strings] of [
  ["values", WIDGET_STRINGS_LIGHT],
  ["values-night", WIDGET_STRINGS_DARK],
]) {
  await writeStatic(
    path.join(appDir, "res", qualifier, "lavande_widget_strings.xml"),
    strings,
    `res/${qualifier}/lavande_widget_strings.xml`,
  );
}
await writeStatic(
  path.join(appDir, "res", "drawable", "ic_lavande_notification.xml"),
  BG_NOTIFICATION_ICON_XML,
  "res/drawable/ic_lavande_notification.xml",
);
await writeStatic(
  path.join(appDir, "proguard-work.pro"),
  PROGUARD_WORK_PRO,
  "proguard-work.pro (Room et WorkManager gardés de R8)",
);
await patchFile(
  path.join(genDir, "app", "build.gradle.kts"),
  patchGradle,
  "app/build.gradle.kts (WorkManager + core-ktx)",
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
