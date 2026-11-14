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
        <receiver android:name=".BootReceiver" android:exported="false">
          <intent-filter>
            <action android:name="android.intent.action.BOOT_COMPLETED" />
          </intent-filter>
        </receiver>`;

function patchWidgetReceivers(source) {
  if (source.includes('android:name=".LavandeWidgetProvider"')) return source;
  const pattern = /([ \t]*)<\/application>/;
  if (!pattern.test(source)) throw new Error("balise </application> introuvable dans AndroidManifest.xml");
  return source.replace(pattern, (_, indent) => `${indent}    ${WIDGET_RECEIVERS}\n${indent}</application>`);
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
import org.json.JSONObject

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
  private const val KEY_UNREAD = "widget_unread"

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

  /** Non lus par compte du dernier résumé rendu : une notification ne part que sur une hausse. */
  fun unread(context: Context): Map<String, Int> {
    val raw = open(context).getString(KEY_UNREAD, "{}") ?: "{}"
    val counts = mutableMapOf<String, Int>()
    try {
      val stored = JSONObject(raw)
      for (id in stored.keys()) counts[id] = stored.optInt(id, 0)
    } catch (e: JSONException) {
      android.util.Log.e("LavandeSync", "compteurs mémorisés illisibles : \${e.message}")
    }
    return counts
  }

  fun setUnread(context: Context, counts: JSONObject) {
    open(context).edit().putString(KEY_UNREAD, counts.toString()).apply()
  }
}
`;

const BG_WORKER_KT = `package mail.lavande.app

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
    private const val NOTIFICATION_ID = 1042

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

    val previous = LavandeBgPrefs.unread(context)
    val grown = mutableListOf<String>()
    for (id in unread.keys()) {
      val now = unread.optInt(id, 0)
      if (now <= (previous[id] ?: 0)) continue
      grown.add(labels[id] + " : " + now + " non lus")
    }

    LavandeBgPrefs.setSummary(context, kept.toString())
    LavandeBgPrefs.setUnread(context, unread)
    LavandeWidgetProvider.refresh(context)
    if (grown.isNotEmpty()) notify(context, grown)
  }

  private fun notify(context: Context, lines: List<String>) {
    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) return
    if (Build.VERSION.SDK_INT >= 26) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Nouveaux mails",
        NotificationManager.IMPORTANCE_HIGH,
      )
      channel.description = "Un message arrive dans la boîte de réception d'un compte"
      manager.createNotificationChannel(channel)
    }
    val open = PendingIntent.getActivity(
      context,
      0,
      Intent(context, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_lavande_notification)
      .setContentTitle("Nouveaux mails")
      .setContentText(lines.joinToString(" · "))
      .setStyle(NotificationCompat.BigTextStyle().bigText(lines.joinToString("\\n")))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setContentIntent(open)
      .build()
    manager.notify(NOTIFICATION_ID, notification)
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
  fun syncNow(invoke: Invoke) {
    LavandeSyncWorker.requestOnce(activity)
    val result = JSObject()
    result.put("ok", true)
    invoke.resolve(result)
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

/**
 * Widget d'écran d'accueil : ne lit que le résumé stocké par le worker
 * (clé widget_summary), donc il s'affiche instantanément, même app fermée.
 */
class LavandeWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    refresh(context)
  }

  companion object {
    private val MAIL_ROWS = intArrayOf(
      R.id.lavande_widget_mail_1,
      R.id.lavande_widget_mail_2,
      R.id.lavande_widget_mail_3,
    )

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
      for (row in MAIL_ROWS) views.setViewVisibility(row, View.GONE)

      val summary = stored(context)
      if (summary == null || (summary.optJSONArray("accounts")?.length() ?: 0) == 0) {
        views.setTextViewText(R.id.lavande_widget_count, "Aucun compte")
        return views
      }

      views.setTextViewText(R.id.lavande_widget_count, unreadLabel(summary.optInt("unread", 0)))
      val mails = summary.optJSONArray("mails") ?: JSONArray()
      val shown = minOf(mails.length(), MAIL_ROWS.size)
      for (index in 0 until shown) {
        val mail = mails.optJSONObject(index) ?: continue
        val line = mail.optString("label") + " · " + mail.optString("subject")
        views.setTextViewText(MAIL_ROWS[index], line)
        views.setViewVisibility(MAIL_ROWS[index], View.VISIBLE)
      }
      return views
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

    private fun unreadLabel(unread: Int): String = when {
      unread == 0 -> "Aucun mail non lu"
      unread == 1 -> "1 non lu"
      else -> "" + unread + " non lus"
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
<!-- RemoteViews n'accepte que LinearLayout/FrameLayout/RelativeLayout : pas de ConstraintLayout. -->
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/lavande_widget_root"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="@drawable/lavande_widget_bg"
    android:orientation="vertical"
    android:padding="16dp">

    <TextView
        android:id="@+id/lavande_widget_count"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:ellipsize="end"
        android:maxLines="1"
        android:text="Aucun compte"
        android:textColor="#2b2340"
        android:textSize="15sp"
        android:textStyle="bold" />

    <TextView
        android:id="@+id/lavande_widget_mail_1"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="8dp"
        android:ellipsize="end"
        android:maxLines="1"
        android:textColor="#5c5480"
        android:textSize="13sp"
        android:visibility="gone" />

    <TextView
        android:id="@+id/lavande_widget_mail_2"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="4dp"
        android:ellipsize="end"
        android:maxLines="1"
        android:textColor="#5c5480"
        android:textSize="13sp"
        android:visibility="gone" />

    <TextView
        android:id="@+id/lavande_widget_mail_3"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="4dp"
        android:ellipsize="end"
        android:maxLines="1"
        android:textColor="#5c5480"
        android:textSize="13sp"
        android:visibility="gone" />
</LinearLayout>
`;

const BG_WIDGET_INFO_XML = `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:initialLayout="@layout/lavande_widget"
    android:minHeight="110dp"
    android:minWidth="180dp"
    android:resizeMode="horizontal|vertical"
    android:targetCellHeight="2"
    android:targetCellWidth="4"
    android:updatePeriodMillis="0"
    android:widgetCategory="home_screen" />
`;

const BG_WIDGET_BG_XML = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android"
    android:shape="rectangle">
    <solid android:color="#FDFCFF" />
    <corners android:radius="24dp" />
    <stroke
        android:width="1dp"
        android:color="#E6E1F5" />
</shape>
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
