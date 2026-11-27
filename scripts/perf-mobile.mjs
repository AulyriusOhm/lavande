#!/usr/bin/env node
/**
 * Harness de performance pour l'application mobile Lavande (`/?app`, PhoneApp).
 *
 * Mesure de façon reproductible la fluidité réelle des transitions entre menus
 * (dock, sauts longs, swipe tactile, sous-menus/feuilles) et le coût au repos :
 *   - rAF frame times (FPS, p50, p95, max, frames >20ms / >33ms / >50ms)
 *   - Long Tasks (>50ms) & Total Blocking Time (TBT)
 *   - Latence clic/tap -> premier rendu (input-to-paint)
 *   - Métriques Chromium CDP (LayoutCount/Duration, RecalcStyleCount/Duration,
 *     ScriptDuration, TaskDuration, Nodes, JSHeapUsedSize)
 *   - Audit statique DOM/CSS (backdrop-filter, filter:blur, animations infinies
 *     actives au repos, containment, nœuds par écran)
 *
 * Usage :
 *   npm run perf:mobile                         # build prod temporaire + CPU 4x
 *   npm run perf:mobile -- --cpu 1              # sans throttling CPU
 *   npm run perf:mobile -- --dev                # serveur Vite dev (itération rapide)
 *   npm run perf:mobile -- --no-build           # réutilise le dernier build /tmp
 *   npm run perf:mobile -- --runs 3             # 3 cycles complets
 *   npm run perf:mobile -- --save-baseline      # enregistre la référence
 *   npm run perf:mobile -- --baseline artifacts/perf-mobile-baseline.json
 *   npm run perf:mobile -- --cdp http://127.0.0.1:9333  # WebView Android (émulateur)
 *   npm run perf:mobile -- --check              # échoue (exit 1) si budget dépassé
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";
import { build, createServer, preview } from "vite";

const ROOT = path.resolve(import.meta.dirname, "..");
const ARTIFACTS = path.join(ROOT, "artifacts");
const TMP_DIST = path.join(os.tmpdir(), "lavande-perf-mobile-dist");
const DEFAULT_REPORT = path.join(ARTIFACTS, "perf-mobile-report.json");
const DEFAULT_BASELINE = path.join(ARTIFACTS, "perf-mobile-baseline.json");

// Budgets cibles pour une transition mobile fluide (60 fps sur téléphone milieu de gamme, CPU 4x)
const BUDGETS = {
  idleActiveAnimations: 0,
  idleRecalcStylePerSec: 5,
  tabTransitionMinFps: 50,
  tabTransitionMaxFrameMs: 50,
  tabTransitionMaxLayoutCount: 8,
  tabTransitionMaxTbtMs: 50,
  swipeMinFps: 45,
  swipeMaxFrameMs: 60,
};

function parseArgs(argv) {
  const opts = {
    mode: "prod", // "prod" | "dev"
    noBuild: false,
    cpu: 4,
    runs: 2,
    port: Number(process.env.PERF_PORT ?? 0),
    url: null,
    cdp: null,
    json: DEFAULT_REPORT,
    baseline: null,
    saveBaseline: null,
    check: false,
    settleMs: 750,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dev") opts.mode = "dev";
    else if (arg === "--prod") opts.mode = "prod";
    else if (arg === "--no-build") opts.noBuild = true;
    else if (arg === "--check") opts.check = true;
    else if (arg === "--cpu") opts.cpu = Number(argv[++i]);
    else if (arg === "--runs") opts.runs = Math.max(1, Number(argv[++i]));
    else if (arg === "--port") opts.port = Number(argv[++i]);
    else if (arg === "--url") opts.url = argv[++i];
    else if (arg === "--cdp") opts.cdp = argv[++i];
    else if (arg === "--json") opts.json = path.resolve(ROOT, argv[++i]);
    else if (arg === "--baseline") opts.baseline = path.resolve(ROOT, argv[++i]);
    else if (arg === "--save-baseline") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        opts.saveBaseline = path.resolve(ROOT, argv[++i]);
      } else {
        opts.saveBaseline = DEFAULT_BASELINE;
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/perf-mobile.mjs [options]
  --prod | --dev           Bundle de production (défaut) ou serveur Vite dev
  --no-build               Réutilise le build temporaire existant (${TMP_DIST})
  --cpu <rate>             Throttling CPU Chromium CDP (défaut: 4)
  --runs <n>               Nombre de cycles de mesure (défaut: 2)
  --port <port>            Port local Vite (défaut: 1425)
  --url <url>              URL déjà servie (sinon lance Vite en mode démo)
  --cdp <http://...>       Connexion CDP existante (ex. WebView Android :9333)
  --json <path>            Chemin du rapport JSON (défaut: artifacts/perf-mobile-report.json)
  --save-baseline [path]   Enregistre le rapport comme référence
  --baseline <path>        Compare avec une référence JSON et affiche les deltas
  --check                  Code de sortie 1 si un budget perf est dépassé`);
      process.exit(0);
    }
  }
  return opts;
}

const candidates = [
  process.env.CHROMIUM_BIN,
  path.join(os.homedir(), ".cache/ms-playwright/chromium-1254/chrome-linux64/chrome"),
  path.join(os.homedir(), ".cache/ms-playwright/chromium-1254/chrome-linux/chrome"),
  path.join(
    os.homedir(),
    ".cache/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell",
  ),
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

async function startAppServer(opts) {
  process.env.VITE_MAIL_BACKEND = "demo";
  if (opts.mode === "dev") {
    const server = await createServer({
      configFile: path.join(ROOT, "vite.config.ts"),
      root: ROOT,
      logLevel: "error",
      cacheDir: path.join(os.tmpdir(), "lavande-perf-vite-cache"),
      server: { host: "127.0.0.1", port: opts.port, strictPort: opts.port !== 0 },
    });
    await server.listen();
    const addr = server.httpServer?.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : opts.port;
    return {
      url: `http://127.0.0.1:${boundPort}/?app`,
      close: () => server.close(),
    };
  }

  if (!opts.noBuild || !existsSync(path.join(TMP_DIST, "index.html"))) {
    const t0 = performance.now();
    await build({
      configFile: path.join(ROOT, "vite.config.ts"),
      root: ROOT,
      logLevel: "error",
      build: { outDir: TMP_DIST, emptyOutDir: true },
    });
    const dt = Math.round(performance.now() - t0);
    console.log(`Build prod démo prêt en ${dt} ms (${TMP_DIST})`);
  }

  const server = await preview({
    configFile: path.join(ROOT, "vite.config.ts"),
    root: ROOT,
    logLevel: "error",
    build: { outDir: TMP_DIST },
    preview: { host: "127.0.0.1", port: opts.port, strictPort: opts.port !== 0 },
  });
  const addr = server.httpServer?.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : opts.port;
  return {
    url: `http://127.0.0.1:${boundPort}/?app`,
    close: () =>
      new Promise((resolve) => {
        server.httpServer.close(() => resolve());
      }),
  };
}

function metricsToMap(metrics) {
  const map = {};
  for (const m of metrics) map[m.name] = m.value;
  return map;
}

function diffMetrics(before, after) {
  const ms = (k) => Math.round(((after[k] ?? 0) - (before[k] ?? 0)) * 1000 * 10) / 10;
  const num = (k) => Math.round(((after[k] ?? 0) - (before[k] ?? 0)) * 10) / 10;
  return {
    layoutCount: num("LayoutCount"),
    layoutMs: ms("LayoutDuration"),
    recalcStyleCount: num("RecalcStyleCount"),
    recalcStyleMs: ms("RecalcStyleDuration"),
    scriptMs: ms("ScriptDuration"),
    taskMs: ms("TaskDuration"),
    nodes: after.Nodes ?? 0,
    heapMb: Math.round(((after.JSHeapUsedSize ?? 0) / (1024 * 1024)) * 10) / 10,
  };
}

async function installInPageProbe(page) {
  await page.evaluate(() => {
    if (window.__perfHarness) return;

    function percentile(sorted, p) {
      if (sorted.length === 0) return 0;
      const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
      return sorted[idx];
    }

    let state = null;

    window.__perfHarness = {
      start() {
        const frames = [];
        const longTasks = [];
        let cls = 0;
        let rafId = 0;
        let last = performance.now();
        const startedAt = last;
        let running = true;

        const tick = (now) => {
          if (!running) return;
          frames.push(now - last);
          last = now;
          rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);

        const observers = [];
        try {
          const ltObs = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              longTasks.push(entry.duration);
            }
          });
          ltObs.observe({ type: "longtask", buffered: false });
          observers.push(ltObs);
        } catch {
          // longtask non supporté
        }

        try {
          const lsObs = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (!entry.hadRecentInput) cls += entry.value;
            }
          });
          lsObs.observe({ type: "layout-shift", buffered: false });
          observers.push(lsObs);
        } catch {
          // layout-shift non supporté
        }

        state = { frames, longTasks, startedAt, getCls: () => cls, stop: () => {
          running = false;
          cancelAnimationFrame(rafId);
          for (const obs of observers) obs.disconnect();
        }};
      },

      stop() {
        if (!state) return null;
        state.stop();
        const durationMs = Math.max(1, performance.now() - state.startedAt);
        const frames = state.frames;
        const sorted = [...frames].sort((a, b) => a - b);
        const avg = frames.length ? frames.reduce((a, b) => a + b, 0) / frames.length : 0;
        const fps = frames.length / (durationMs / 1000);
        const tbt = state.longTasks.reduce((sum, d) => sum + Math.max(0, d - 50), 0);
        const result = {
          durationMs: Math.round(durationMs),
          frames: frames.length,
          fps: Math.round(fps * 10) / 10,
          avgFrameMs: Math.round(avg * 10) / 10,
          p50FrameMs: Math.round(percentile(sorted, 50) * 10) / 10,
          p95FrameMs: Math.round(percentile(sorted, 95) * 10) / 10,
          maxFrameMs: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
          jank20: frames.filter((d) => d > 20).length,
          jank33: frames.filter((d) => d > 33.3).length,
          jank50: frames.filter((d) => d > 50).length,
          longTaskCount: state.longTasks.length,
          totalBlockingMs: Math.round(tbt * 10) / 10,
          cls: Math.round(state.getCls() * 10000) / 10000,
        };
        state = null;
        return result;
      },

      auditDomAndCss() {
        const all = Array.from(document.querySelectorAll("*"));
        const backdropFilters = [];
        const blurFilters = [];
        const willChanges = [];

        const describe = (el) => {
          const tag = el.tagName.toLowerCase();
          const cls = typeof el.className === "string"
            ? el.className.trim().split(/\s+/).slice(0, 4).join(".")
            : "";
          const rect = el.getBoundingClientRect();
          return {
            el: cls ? `${tag}.${cls}` : tag,
            size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
          };
        };

        for (const el of all) {
          const st = getComputedStyle(el);
          if (st.backdropFilter && st.backdropFilter !== "none") {
            backdropFilters.push({ ...describe(el), value: st.backdropFilter });
          }
          if (st.filter && st.filter.includes("blur(")) {
            blurFilters.push({ ...describe(el), value: st.filter });
          }
          if (st.willChange && st.willChange !== "auto") {
            willChanges.push({ ...describe(el), value: st.willChange });
          }
        }

        const animations = document.getAnimations().map((anim) => {
          const effect = anim.effect;
          const target = effect && "target" in effect ? effect.target : null;
          const timing = effect?.getComputedTiming?.() ?? {};
          return {
            name: anim.animationName ?? anim.transitionProperty ?? anim.id ?? "waapi",
            playState: anim.playState,
            iterations: timing.iterations === Infinity ? "infinite" : timing.iterations ?? 1,
            target: target ? describe(target).el : "unknown",
          };
        });

        // Strip horizontal et ses 4 panneaux d'onglets
        const strip = document.querySelector('[style*="translate3d("]');
        const stripInfo = strip
          ? {
              transform: strip.style.transform,
              willChange: getComputedStyle(strip).willChange,
              panels: Array.from(strip.children).map((child, idx) => ({
                index: idx,
                nodes: child.querySelectorAll("*").length,
                contain: getComputedStyle(child).contain,
                contentVisibility: getComputedStyle(child).contentVisibility,
              })),
            }
          : null;

        return {
          totalNodes: all.length,
          backdropFilters,
          blurFilters,
          willChanges,
          activeAnimations: animations,
          strip: stripInfo,
        };
      },
    };
  });
}

async function measureWindow(page, cdp, label, actionFn, windowMs = 650) {
  const before = metricsToMap((await cdp.send("Performance.getMetrics")).metrics);
  await page.evaluate(() => window.__perfHarness.start());

  const tActionStart = performance.now();
  let inputLatencyMs = null;
  if (actionFn) {
    await actionFn();
    inputLatencyMs = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const t0 = performance.now();
          requestAnimationFrame(() => resolve(Math.round((performance.now() - t0) * 10) / 10));
        }),
    );
  }

  const elapsed = performance.now() - tActionStart;
  const remaining = Math.max(0, windowMs - elapsed);
  if (remaining > 0) await page.waitForTimeout(remaining);

  const probe = await page.evaluate(() => window.__perfHarness.stop());
  const after = metricsToMap((await cdp.send("Performance.getMetrics")).metrics);
  const cdpDelta = diffMetrics(before, after);

  return {
    label,
    inputLatencyMs,
    ...probe,
    ...cdpDelta,
  };
}

async function performHorizontalSwipe(page, direction) {
  // direction: "left" (vers onglet suivant) ou "right" (vers onglet précédent)
  // On évite les éléments [data-swipe] (lignes de mail/tâche) qui interceptent le geste.
  const vp = page.viewportSize() ?? { width: 412, height: 915 };
  const startX = direction === "left" ? Math.round(vp.width * 0.85) : Math.round(vp.width * 0.15);
  const endX = direction === "left" ? Math.round(vp.width * 0.15) : Math.round(vp.width * 0.85);
  const y = await page.evaluate((x) => {
    const candidatesY = [88, 120, 150, 740, 260, 500];
    for (const cy of candidatesY) {
      const el = document.elementFromPoint(x, cy);
      if (el && !el.closest("[data-swipe]") && !el.closest("button, a, input")) return cy;
    }
    return 88;
  }, startX);
  const steps = 16;

  await page.mouse.move(startX, y);
  await page.mouse.down();
  for (let s = 1; s <= steps; s += 1) {
    const x = Math.round(startX + ((endX - startX) * s) / steps);
    await page.mouse.move(x, y);
    await page.waitForTimeout(14);
  }
  await page.mouse.up();
}

function aggregateGroup(rows) {
  if (rows.length === 0) return null;
  const avg = (k) => Math.round((rows.reduce((s, r) => s + (r[k] ?? 0), 0) / rows.length) * 10) / 10;
  const max = (k) => Math.round(Math.max(...rows.map((r) => r[k] ?? 0)) * 10) / 10;
  const sum = (k) => Math.round(rows.reduce((s, r) => s + (r[k] ?? 0), 0) * 10) / 10;
  return {
    count: rows.length,
    avgFps: avg("fps"),
    minFps: Math.round(Math.min(...rows.map((r) => r.fps)) * 10) / 10,
    avgP95FrameMs: avg("p95FrameMs"),
    worstMaxFrameMs: max("maxFrameMs"),
    totalJank20: sum("jank20"),
    totalJank33: sum("jank33"),
    totalJank50: sum("jank50"),
    totalBlockingMs: sum("totalBlockingMs"),
    avgLayoutCount: avg("layoutCount"),
    avgLayoutMs: avg("layoutMs"),
    avgRecalcStyleCount: avg("recalcStyleCount"),
    avgRecalcStyleMs: avg("recalcStyleMs"),
    avgScriptMs: avg("scriptMs"),
    avgTaskMs: avg("taskMs"),
  };
}

function fmt(val, width = 6) {
  return String(val ?? "-").padStart(width);
}

function deltaStr(curr, prev, lowerIsBetter = true) {
  if (prev === undefined || prev === null) return "";
  const d = Math.round((curr - prev) * 10) / 10;
  if (d === 0) return " (=)";
  const sign = d > 0 ? "+" : "";
  const good = lowerIsBetter ? d < 0 : d > 0;
  return ` (${sign}${d}${good ? " ✓" : " ✗"})`;
}

function printTable(title, rows) {
  console.log(`\n── ${title} ──`);
  console.log(
    "Scénario".padEnd(32) +
      "   FPS  p95ms  maxms  >20 >33 >50   TBTms  Lay#  Layms  Sty#  Styms   JSms  Taskms",
  );
  console.log("─".repeat(113));
  for (const r of rows) {
    console.log(
      r.label.slice(0, 31).padEnd(32) +
        fmt(r.fps, 6) +
        fmt(r.p95FrameMs, 7) +
        fmt(r.maxFrameMs, 7) +
        fmt(r.jank20, 5) +
        fmt(r.jank33, 4) +
        fmt(r.jank50, 4) +
        fmt(r.totalBlockingMs, 8) +
        fmt(r.layoutCount, 6) +
        fmt(r.layoutMs, 7) +
        fmt(r.recalcStyleCount, 6) +
        fmt(r.recalcStyleMs, 7) +
        fmt(r.scriptMs, 7) +
        fmt(r.taskMs, 8),
    );
  }
}

function evaluateBudgets(report) {
  const issues = [];
  const { audit, idle, summary } = report;

  if (audit.activeAnimations.length > BUDGETS.idleActiveAnimations) {
    issues.push(
      `Idle: ${audit.activeAnimations.length} animation(s) continue(s) active(s) (budget ${BUDGETS.idleActiveAnimations})`,
    );
  }
  const idleRecalcPerSec = idle.recalcStyleCount / (idle.durationMs / 1000);
  if (idleRecalcPerSec > BUDGETS.idleRecalcStylePerSec) {
    issues.push(
      `Idle: ${Math.round(idleRecalcPerSec)} RecalcStyle/s au repos (budget <= ${BUDGETS.idleRecalcStylePerSec}/s)`,
    );
  }
  if (summary.dockTransitions.avgFps < BUDGETS.tabTransitionMinFps) {
    issues.push(
      `Dock tabs: FPS moyen ${summary.dockTransitions.avgFps} < ${BUDGETS.tabTransitionMinFps}`,
    );
  }
  if (summary.dockTransitions.worstMaxFrameMs > BUDGETS.tabTransitionMaxFrameMs) {
    issues.push(
      `Dock tabs: pire frame ${summary.dockTransitions.worstMaxFrameMs} ms > ${BUDGETS.tabTransitionMaxFrameMs} ms`,
    );
  }
  if (summary.dockTransitions.avgLayoutCount > BUDGETS.tabTransitionMaxLayoutCount) {
    issues.push(
      `Dock tabs: ${summary.dockTransitions.avgLayoutCount} layouts/transition > ${BUDGETS.tabTransitionMaxLayoutCount}`,
    );
  }
  if (summary.dockTransitions.totalBlockingMs > BUDGETS.tabTransitionMaxTbtMs) {
    issues.push(
      `Dock tabs: TBT cumulé ${summary.dockTransitions.totalBlockingMs} ms > ${BUDGETS.tabTransitionMaxTbtMs} ms`,
    );
  }
  if (summary.swipes && summary.swipes.avgFps < BUDGETS.swipeMinFps) {
    issues.push(`Swipes: FPS moyen ${summary.swipes.avgFps} < ${BUDGETS.swipeMinFps}`);
  }
  if (summary.swipes && summary.swipes.worstMaxFrameMs > BUDGETS.swipeMaxFrameMs) {
    issues.push(`Swipes: pire frame ${summary.swipes.worstMaxFrameMs} ms > ${BUDGETS.swipeMaxFrameMs} ms`);
  }
  return issues;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(ARTIFACTS, { recursive: true });

  let server = null;
  let browser = null;
  let ownsBrowser = false;

  try {
    let targetUrl = opts.url;
    if (!opts.cdp && !targetUrl) {
      server = await startAppServer(opts);
      targetUrl = server.url;
    }

    let page;
    let context;
    if (opts.cdp) {
      browser = await chromium.connectOverCDP(opts.cdp);
      const pages = browser.contexts().flatMap((c) => c.pages());
      page = pages.find((p) => p.url().includes("tauri.localhost") || p.url().includes("127.0.0.1")) ?? pages[0];
      if (!page) throw new Error(`Aucune page trouvée sur CDP ${opts.cdp}`);
      context = page.context();
    } else {
      const executablePath = candidates.find((entry) => existsSync(entry));
      if (!executablePath) {
        throw new Error(`Aucun binaire Chromium trouvé parmi: ${candidates.join(", ")}`);
      }
      browser = await chromium.launch({
        executablePath,
        headless: true,
        env: browserEnv,
        args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
      });
      ownsBrowser = true;
      context = await browser.newContext({
        viewport: { width: 412, height: 915 },
        deviceScaleFactor: 2.625,
        isMobile: true,
        hasTouch: true,
      });
      page = await context.newPage();
      await page.goto(targetUrl, { waitUntil: "networkidle" });
    }

    await page.locator('[aria-label="Boîte"]').waitFor({ state: "visible", timeout: 20_000 });
    await page.evaluate(() => document.fonts.ready);
    // Laisse passer le repli auto de la carte résumé (2s) pour stabiliser le repos
    await page.waitForTimeout(2400);

    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    if (opts.cpu > 1) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: opts.cpu });
    }

    await installInPageProbe(page);

    console.log(
      `\nHarness perf mobile — mode=${opts.cdp ? "cdp" : opts.mode}, CPU=${opts.cpu}x, runs=${opts.runs}, url=${page.url()}`,
    );

    // 0. Audit statique DOM / CSS / animations au repos
    const audit = await page.evaluate(() => window.__perfHarness.auditDomAndCss());

    // 1. Repos (2 secondes sans interaction)
    const idle = await measureWindow(page, cdp, "Repos (2s sans interaction)", null, 2000);

    // 2. Transitions séquentielles via le dock
    const tabSequence = [
      ["Boîte", "Agenda"],
      ["Agenda", "Planif."],
      ["Planif.", "Réglages"],
      ["Réglages", "Planif."],
      ["Planif.", "Agenda"],
      ["Agenda", "Boîte"],
    ];
    const dockTransitions = [];
    for (let run = 1; run <= opts.runs; run += 1) {
      for (const [from, to] of tabSequence) {
        const res = await measureWindow(
          page,
          cdp,
          `${from} → ${to}${opts.runs > 1 ? ` (#${run})` : ""}`,
          async () => {
            await page.getByRole("button", { name: to, exact: true }).click();
          },
          opts.settleMs,
        );
        dockTransitions.push(res);
        await page.waitForTimeout(150);
      }
    }

    // 3. Sauts longs (400% de la bande)
    const longJumps = [];
    for (const [from, to] of [
      ["Boîte", "Réglages"],
      ["Réglages", "Boîte"],
    ]) {
      const res = await measureWindow(
        page,
        cdp,
        `Saut ${from} → ${to}`,
        async () => {
          await page.getByRole("button", { name: to, exact: true }).click();
        },
        opts.settleMs,
      );
      longJumps.push(res);
      await page.waitForTimeout(150);
    }

    // 4. Swipes tactiles horizontaux (exercice de onPointerMove + setDragX)
    const swipes = [];
    for (const [label, dir] of [
      ["Swipe Boîte → Agenda", "left"],
      ["Swipe Agenda → Planif.", "left"],
      ["Swipe Planif. → Agenda", "right"],
      ["Swipe Agenda → Boîte", "right"],
    ]) {
      const res = await measureWindow(
        page,
        cdp,
        label,
        async () => {
          await performHorizontalSwipe(page, dir);
        },
        900,
      );
      swipes.push(res);
      await page.waitForTimeout(200);
    }

    // 5. Sous-menus & feuilles — s'assure d'être revenu sur Boîte
    await page.getByRole("button", { name: "Boîte", exact: true }).click();
    await page.waitForTimeout(500);
    const overlays = [];

    // 5a. Déplier / réduire la carte résumé
    const expandSummaryBtn = page.locator('[aria-label^="Réafficher le "]').first();
    if ((await expandSummaryBtn.count()) > 0) {
      overlays.push(
        await measureWindow(
          page,
          cdp,
          "Déplier le résumé",
          async () => {
            await expandSummaryBtn.click();
          },
          opts.settleMs,
        ),
      );
      await page.waitForTimeout(200);
      const collapseSummaryBtn = page.getByLabel("Réduire le résumé", { exact: true });
      if ((await collapseSummaryBtn.count()) > 0) {
        overlays.push(
          await measureWindow(
            page,
            cdp,
            "Réduire le résumé",
            async () => {
              await collapseSummaryBtn.click();
            },
            opts.settleMs,
          ),
        );
      }
      await page.waitForTimeout(200);
    }
    // 5b. Feuilles de création (Nouveau message, Nouveau RDV, Nouvelle tâche)
    const fabCompose = page.getByLabel("Nouveau message", { exact: true });
    if ((await fabCompose.count()) > 0) {
      overlays.push(
        await measureWindow(
          page,
          cdp,
          "Ouvrir Nouveau message",
          async () => {
            await fabCompose.click();
          },
          opts.settleMs,
        ),
      );
      await page.waitForTimeout(150);
      const closeCompose = page.getByLabel("Fermer", { exact: true });
      if ((await closeCompose.count()) > 0) {
        overlays.push(
          await measureWindow(
            page,
            cdp,
            "Fermer Nouveau message",
            async () => {
              await closeCompose.click();
            },
            opts.settleMs,
          ),
        );
        await page.waitForTimeout(150);
      } else {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }
    }

    await page.getByRole("button", { name: "Agenda", exact: true }).click();
    await page.waitForTimeout(500);
    const fabEvent = page.getByLabel("Nouveau rendez-vous", { exact: true });
    if ((await fabEvent.count()) > 0) {
      overlays.push(
        await measureWindow(
          page,
          cdp,
          "Ouvrir Nouveau RDV",
          async () => {
            await fabEvent.click();
          },
          opts.settleMs,
        ),
      );
      await page.waitForTimeout(150);
      const cancelEvent = page.getByRole("button", { name: "Annuler", exact: true });
      if ((await cancelEvent.count()) > 0) {
        overlays.push(
          await measureWindow(
            page,
            cdp,
            "Fermer Nouveau RDV",
            async () => {
              await cancelEvent.click();
            },
            opts.settleMs,
          ),
        );
        await page.waitForTimeout(150);
      }
    }

    await page.getByRole("button", { name: "Planif.", exact: true }).click();
    await page.waitForTimeout(500);
    const fabTask = page.getByLabel("Nouvelle tâche", { exact: true });
    if ((await fabTask.count()) > 0) {
      overlays.push(
        await measureWindow(
          page,
          cdp,
          "Ouvrir Nouvelle tâche",
          async () => {
            await fabTask.click();
          },
          opts.settleMs,
        ),
      );
      await page.waitForTimeout(150);
      const cancelTask = page.getByRole("button", { name: "Annuler", exact: true });
      if ((await cancelTask.count()) > 0) {
        overlays.push(
          await measureWindow(
            page,
            cdp,
            "Fermer Nouvelle tâche",
            async () => {
              await cancelTask.click();
            },
            opts.settleMs,
          ),
        );
        await page.waitForTimeout(150);
      }
    }

    await page.getByRole("button", { name: "Boîte", exact: true }).click();
    await page.waitForTimeout(500);

    const firstRow = page.locator('[data-mail-row] [role="button"]').first();
    if ((await firstRow.count()) > 0) {
      overlays.push(
        await measureWindow(
          page,
          cdp,
          "Ouvrir un message",
          async () => {
            await firstRow.click();
          },
          opts.settleMs,
        ),
      );
      await page.waitForTimeout(150);
      const backBtn = page.getByLabel("Retour", { exact: true });
      if ((await backBtn.count()) > 0) {
        overlays.push(
          await measureWindow(
            page,
            cdp,
            "Fermer le message",
            async () => {
              await backBtn.click();
            },
            opts.settleMs,
          ),
        );
      }
      await page.waitForTimeout(150);
    }

    // Réglages -> Apparence -> Retour
    await page.getByRole("button", { name: "Réglages", exact: true }).click();
    await page.waitForTimeout(600);
    const appearanceBtn = page.getByRole("button", { name: /^Apparence/ });
    if ((await appearanceBtn.count()) > 0) {
      overlays.push(
        await measureWindow(
          page,
          cdp,
          "Réglages → Apparence",
          async () => {
            await appearanceBtn.click();
          },
          opts.settleMs,
        ),
      );
      await page.waitForTimeout(150);
      const backSettings = page.getByLabel("Retour aux réglages");
      if ((await backSettings.count()) > 0) {
        overlays.push(
          await measureWindow(
            page,
            cdp,
            "Apparence → Réglages",
            async () => {
              await backSettings.click();
            },
            opts.settleMs,
          ),
        );
      }
    }

    const report = {
      timestamp: new Date().toISOString(),
      config: {
        mode: opts.cdp ? "cdp" : opts.mode,
        cpuThrottling: opts.cpu,
        runs: opts.runs,
        url: page.url(),
      },
      audit,
      idle,
      dockTransitions,
      longJumps,
      swipes,
      overlays,
      summary: {
        dockTransitions: aggregateGroup(dockTransitions),
        longJumps: aggregateGroup(longJumps),
        swipes: aggregateGroup(swipes),
        overlays: aggregateGroup(overlays),
      },
    };

    const issues = evaluateBudgets(report);
    report.budgetIssues = issues;

    writeFileSync(opts.json, JSON.stringify(report, null, 2));
    if (opts.saveBaseline) {
      writeFileSync(opts.saveBaseline, JSON.stringify(report, null, 2));
      console.log(`Référence enregistrée : ${path.relative(ROOT, opts.saveBaseline)}`);
    }

    // Affichage lisible
    printTable("Repos", [idle]);
    printTable("Transitions Dock (séquentielles)", dockTransitions);
    printTable("Sauts longs Dock", longJumps);
    printTable("Swipes horizontaux", swipes);
    if (overlays.length) printTable("Sous-menus & Overlays", overlays);

    console.log("\n── Audit DOM / CSS / Couches ──");
    console.log(`Nœuds DOM totaux : ${audit.totalNodes}`);
    if (audit.strip) {
      const panelStr = audit.strip.panels
        .map((p) => `#${p.index}:${p.nodes} nodes (contain=${p.contain})`)
        .join(" | ");
      console.log(`Strip horizontal : will-change=${audit.strip.willChange} | ${panelStr}`);
    }
    console.log(`backdrop-filter  : ${audit.backdropFilters.length} élément(s)`);
    for (const bf of audit.backdropFilters.slice(0, 5)) {
      console.log(`  - ${bf.el} (${bf.size}) → ${bf.value}`);
    }
    console.log(`filter: blur()   : ${audit.blurFilters.length} élément(s)`);
    for (const bl of audit.blurFilters.slice(0, 10)) {
      console.log(`  - ${bl.el} (${bl.size}) → ${bl.value}`);
    }
    console.log(`Animations actives au repos : ${audit.activeAnimations.length}`);
    for (const an of audit.activeAnimations) {
      console.log(`  - ${an.name} (${an.playState}, ${an.iterations}) sur ${an.target}`);
    }

    const base = opts.baseline && existsSync(opts.baseline)
      ? JSON.parse(readFileSync(opts.baseline, "utf8"))
      : null;

    console.log("\n── Synthèse ──");
    const dt = report.summary.dockTransitions;
    const bDt = base?.summary?.dockTransitions;
    console.log(
      `Dock tabs : FPS moy=${dt.avgFps}${deltaStr(dt.avgFps, bDt?.avgFps, false)} | ` +
        `min=${dt.minFps} | p95=${dt.avgP95FrameMs}ms${deltaStr(dt.avgP95FrameMs, bDt?.avgP95FrameMs)} | ` +
        `max=${dt.worstMaxFrameMs}ms${deltaStr(dt.worstMaxFrameMs, bDt?.worstMaxFrameMs)} | ` +
        `TBT=${dt.totalBlockingMs}ms | Layouts/tr=${dt.avgLayoutCount}${deltaStr(dt.avgLayoutCount, bDt?.avgLayoutCount)} | ` +
        `RecalcStyle/tr=${dt.avgRecalcStyleCount}${deltaStr(dt.avgRecalcStyleCount, bDt?.avgRecalcStyleCount)} | ` +
        `Task/tr=${dt.avgTaskMs}ms${deltaStr(dt.avgTaskMs, bDt?.avgTaskMs)}`,
    );
    const sw = report.summary.swipes;
    const bSw = base?.summary?.swipes;
    if (sw) {
      console.log(
        `Swipes    : FPS moy=${sw.avgFps}${deltaStr(sw.avgFps, bSw?.avgFps, false)} | ` +
          `min=${sw.minFps} | p95=${sw.avgP95FrameMs}ms | max=${sw.worstMaxFrameMs}ms | ` +
          `Layouts/tr=${sw.avgLayoutCount} | RecalcStyle/tr=${sw.avgRecalcStyleCount} | Task/tr=${sw.avgTaskMs}ms`,
      );
    }

    if (issues.length) {
      console.log(`\nBudgets dépassés (${issues.length}) :`);
      for (const issue of issues) console.log(`  ✗ ${issue}`);
    } else {
      console.log("\n✓ Tous les budgets de fluidité sont respectés.");
    }

    console.log(`\nRapport JSON : ${path.relative(ROOT, opts.json)}`);
    if (opts.check && issues.length > 0) process.exitCode = 1;
  } finally {
    if (ownsBrowser && browser) await browser.close();
    if (server) await server.close();
  }
}

main().catch((error) => {
  console.error("FAIL:", error?.message ?? error);
  process.exit(1);
});
