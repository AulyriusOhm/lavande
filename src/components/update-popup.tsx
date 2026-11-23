import { useEffect, useState } from "react";
import { Download, Mail, RotateCw, Sparkles, TrendingUp, Wrench, type LucideIcon } from "lucide-react";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { useEscapeLayer } from "@/desktop/escape";
import { useBackLayer } from "@/lib/back";
import { usePrefs } from "@/lib/prefs";
import { configureUpdaterSchedule, useUpdater } from "@/lib/updater";
import { cn } from "@/lib/utils";

const DEFAULT_GROUP = "Nouveautés";
const DISMISS_PREFIX = "lavande:updater-popup-dismissed:";
const GROUP_ICONS: Record<string, LucideIcon> = { Correctifs: Wrench, Améliorations: TrendingUp };

const LATER =
  "focus-ring grid h-10 w-full place-items-center rounded-full border border-line bg-surface-2 text-[12px] font-bold text-ink-soft transition-colors hover:text-ink";

export type ReleaseNoteGroup = { title: string; items: string[] };

export function parseReleaseNotes(notes: string): ReleaseNoteGroup[] {
  const groups: ReleaseNoteGroup[] = [];
  let current: ReleaseNoteGroup | null = null;
  for (const raw of notes.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const title = line.replace(/^#+\s*/, "").trim();
      if (!title) continue;
      current = { title, items: [] };
      groups.push(current);
      continue;
    }
    const item = line.replace(/^[-*]\s*/, "").trim();
    if (!item) continue;
    if (!current) {
      current = { title: DEFAULT_GROUP, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups.filter((group) => group.items.length > 0);
}

function dismissedThisSession(version: string) {
  try {
    return window.sessionStorage.getItem(DISMISS_PREFIX + version) === "1";
  } catch {
    return false;
  }
}

function rememberDismissed(version: string) {
  try {
    window.sessionStorage.setItem(DISMISS_PREFIX + version, "1");
  } catch {
    return;
  }
}

export function UpdatePopup() {
  const { supported, phase, current, install } = useUpdater();
  const { updates } = usePrefs();
  const [closed, setClosed] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);

  useEffect(() => configureUpdaterSchedule(updates), [updates]);

  const available = phase.kind === "available" ? phase : null;
  const running = phase.kind === "downloading" || phase.kind === "installing" ? phase : null;
  const failure = installing && phase.kind === "error" ? phase.message : null;
  const version = available?.version ?? installing;
  const postponed = version !== null && (version === closed || dismissedThisSession(version));

  const dismiss = () => {
    if (!version) return;
    rememberDismissed(version);
    setClosed(version);
    setInstalling(null);
  };

  useEscapeLayer(version !== null && !postponed && running === null, dismiss);
  useBackLayer(version !== null && !postponed && running === null, dismiss);

  if (!supported || version === null || postponed) return null;
  if (available === null && running === null && failure === null) return null;

  const startInstall = () => {
    if (available) setInstalling(available.version);
    void install();
  };

  const groups = available ? parseReleaseNotes(available.notes) : [];
  const percent = running === null ? 0 : running.kind === "downloading" ? running.percent : 100;
  const title = failure
    ? "Mise à jour interrompue"
    : running
      ? `Installation de la ${version}…`
      : `Lavande ${version} est disponible`;
  const subtitle = failure
    ? `La ${version} n'a pas pu être installée`
    : running
      ? running.kind === "installing"
        ? "Installation puis relance de Lavande"
        : "Téléchargement et vérification de la signature"
      : "Une nouvelle version prête à installer";
  const status = running
    ? running.kind === "installing"
      ? "Installation…"
      : running.percent === null
        ? "Téléchargement…"
        : `Téléchargement · ${running.percent} %`
    : null;

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-4">
      <div
        aria-hidden
        data-testid="update-popup-backdrop"
        onClick={running ? undefined : dismiss}
        className="absolute inset-0 bg-canvas/60 backdrop-blur-[6px]"
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={`Mise à jour Lavande ${version}`}
        className="relative w-full max-w-[440px] rounded-[26px] border border-line bg-surface p-5 shadow-[0_44px_96px_-48px_var(--accent)]"
      >
        <div className="flex items-center gap-3.5">
          <span className="grid size-11 shrink-0 place-items-center rounded-[15px] bg-gradient-to-br from-accent to-accent-ring text-accent-contrast shadow-[0_10px_24px_-12px_var(--accent)]">
            {running || failure ? (
              <RotateCw className={cn("size-5", running && "animate-spin")} strokeWidth={2} />
            ) : (
              <Mail className="size-5" strokeWidth={2} />
            )}
          </span>
          <div className="min-w-0">
            <h2 className="text-[19px] leading-tight font-extrabold tracking-[-0.035em] text-ink">
              {title}
            </h2>
            <p className="mt-0.5 text-[11.5px] font-semibold text-ink-muted">{subtitle}</p>
          </div>
        </div>

        {available ? (
          <>
            <div className="mt-3.5 flex flex-wrap gap-1.5">
              <span className="inline-flex items-center rounded-full bg-surface-2 px-2.5 py-1 text-[10.5px] font-bold text-ink-soft tabular-nums">
                {current ? `${current} → ${version}` : version}
              </span>
            </div>

            {groups.length > 0 ? (
              <div className="mt-3 max-h-[240px] space-y-3 overflow-y-auto pr-1">
                {groups.map((group) => {
                  const GroupIcon = GROUP_ICONS[group.title] ?? Sparkles;
                  return (
                    <div key={group.title}>
                      <p className="text-[10.5px] font-extrabold tracking-[0.12em] text-ink-muted uppercase">
                        {group.title}
                      </p>
                      <ul className="mt-1">
                        {group.items.map((item, index) => (
                          <li key={`${group.title}-${index}`} className="flex items-start gap-2.5 py-1">
                            <span className="mt-px grid size-7 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent-ink">
                              <GroupIcon className="size-3.5" strokeWidth={2} />
                            </span>
                            <span className="text-[12px] leading-relaxed font-medium text-ink-soft">
                              {item}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            ) : null}

            <div className="mt-4 space-y-2">
              <ShimmerButton autoFocus size="lg" className="w-full" onClick={startInstall}>
                <Download className="size-4" strokeWidth={2.2} />
                Installer la mise à jour
              </ShimmerButton>
              <button type="button" onClick={dismiss} className={LATER}>
                Plus tard
              </button>
            </div>
          </>
        ) : null}

        {running ? (
          <div className="mt-4">
            <div
              role="progressbar"
              aria-label="Progression de la mise à jour"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
              className="h-2 overflow-hidden rounded-full bg-surface-2"
            >
              <div
                className={cn(
                  "h-full rounded-full bg-accent transition-[width] duration-300",
                  percent === null ? "w-[35%] animate-pulse" : undefined,
                )}
                style={percent === null ? undefined : { width: `${percent}%` }}
              />
            </div>
            <p className="mt-2 text-[11px] font-bold text-ink-soft tabular-nums">{status}</p>
          </div>
        ) : null}

        {failure ? (
          <div className="mt-4 space-y-2">
            <p
              role="alert"
              className="rounded-2xl bg-rose-500/10 px-3 py-2 text-[11.5px] leading-relaxed font-semibold text-rose-700 dark:text-rose-300"
            >
              {failure}
            </p>
            <ShimmerButton autoFocus size="lg" className="w-full" onClick={() => void install()}>
              <RotateCw className="size-4" strokeWidth={2.2} />
              Réessayer
            </ShimmerButton>
            <button type="button" onClick={dismiss} className={LATER}>
              Fermer
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
