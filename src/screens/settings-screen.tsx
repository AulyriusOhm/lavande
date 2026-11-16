import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  AlertTriangle,
  Bell,
  Blocks,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  FolderTree,
  KeyRound,
  Keyboard,
  Link2,
  ListChecks,
  Lock,
  Mail as MailIcon,
  Moon,
  Palette,
  PenLine,
  PlugZap,
  Plus,
  RefreshCw,
  Sparkles,
  Sun,
  SunMoon,
  Trash2,
  Type,
  Upload,
  Users,
} from "lucide-react";
import { ACCENT_PRESETS, accentContrast, useTheme, type ThemeMode } from "@/lib/theme";
import { llmModels, llmProbe, llmReady, type LlmConfig } from "@/lib/llm";
import { formatTokens, lastDays, resetAiStats, topModels } from "@/lib/ai-stats";
import { useAiUsage } from "@/lib/ai-sync";
import {
  SWIPE_ACTIONS,
  CALENDAR_LEAD_MINUTES,
  CONTACTS_PENDING,
  mergeFlags,
  perimeterOf,
  usePrefs,
} from "@/lib/prefs";
import {
  TONE_DOT,
  calendarSourceKind,
  icsUrlOf,
  isExternalCalendar,
  isIcsCalendar,
  type CalendarDef,
} from "@/lib/calendars";
import { useCalendarSources } from "@/lib/ics";
import { ALL_ACCOUNTS } from "@/lib/accounts";
import type { ApiAccount, GoogleCalendar } from "@/lib/api";
import { useMailStore } from "@/lib/store";
import { MCP_SERVERS, mcpCounts } from "@/lib/mcp";
import type { Mail } from "@/lib/mail";
import { cn } from "@/lib/utils";
import { Avatar, Card, SectionTitle, SwitchTrack, ToggleRow } from "@/components/ui/primitives";
import { FolderRow } from "@/components/folder-row";
import { SyncSettings } from "@/components/sync-settings";
import { ShortcutList } from "@/components/shortcut-list";
import { detectModKey } from "@/lib/shortcuts";
import { requestNotifications } from "@/lib/notify";
import { shortcutCatalog } from "@/lib/app-shortcuts";
import { BlurFade } from "@/components/ui/blur-fade";
import { MeshGlow } from "@/components/ui/backdrops";
import { AnimatedGradientText } from "@/components/ui/animated-text";
import { APP_VERSION, phaseLabel, useUpdater, type UpdateTone } from "@/lib/updater";
import {
  backgroundSyncSupported,
  readBackgroundSync,
  useMutedAccountsSync,
  writeBackgroundSync,
} from "@/lib/background-sync";

const LLM_FIELDS: { key: keyof LlmConfig; label: string; aria: string; placeholder: string; password?: boolean }[] = [
  { key: "endpoint", label: "Endpoint", aria: "Endpoint du modèle", placeholder: "https://api.openai.com/v1" },
  { key: "model", label: "Modèle", aria: "Nom du modèle", placeholder: "gpt-4o-mini" },
  { key: "apiKey", label: "Clé API", aria: "Clé API", placeholder: "sk-…", password: true },
];

const PREVIEW_OPTIONS = [
  { value: "always", label: "Toujours" },
  { value: "unlocked", label: "Si déverrouillé" },
  { value: "never", label: "Jamais" },
] as const;

type PreviewMode = (typeof PREVIEW_OPTIONS)[number]["value"];

type GroupId = "comptes" | "apparence" | "synchronisation" | "securite" | "ia" | "mcp" | "application";

const GROUPS: { id: GroupId; label: string; hint: string; icon: typeof Sun }[] = [
  { id: "comptes", label: "Comptes", hint: "Boîtes mail, signatures, dossiers", icon: Users },
  { id: "apparence", label: "Apparence", hint: "Thème, couleur d'accent, modules", icon: Palette },
  { id: "synchronisation", label: "Synchronisation", hint: "Appareils, calendriers, notifications", icon: RefreshCw },
  { id: "securite", label: "Sécurité & PGP", hint: "Clés et chiffrement de bout en bout", icon: KeyRound },
  { id: "ia", label: "IA", hint: "Modèle, résumés, suggestions de tâches", icon: Sparkles },
  { id: "mcp", label: "MCP", hint: "Serveurs et outils de l'assistant", icon: Blocks },
  { id: "application", label: "Application", hint: "Gestes, raccourcis clavier, version", icon: Keyboard },
];

export function SettingsScreen({
  mails,
  account,
  onOpenAccounts,
  onOpenPgp,
  onOpenMcp,
}: {
  mails: Mail[];
  account: string;
  onOpenAccounts: () => void;
  onOpenPgp: () => void;
  onOpenMcp: () => void;
}) {
  const { accent, mode: themeMode, brand, setAccent, setMode: setThemeMode, reset } = useTheme();
  const { accounts, mode, readOnly, openConnect, askRemoveAccount, folderOptions, deleteFolder } =
    useMailStore();
  const {
    swipeLeft,
    swipeRight,
    setSwipe,
    mcpEnabled,
    calendarEnabled,
    planningEnabled,
    setCalendarEnabled,
    setPlanningEnabled,
    notifications,
    setNotifications,
    setAccountNotification,
    llm,
    setLlm,
    aiReplyEnabled,
    setAiReplyEnabled,
    summary,
    setSummary,
    aiTasks,
    setAiTasks,
    perimeters,
    setAccountPerimeter,
  } = usePrefs();
  const [openGroup, setOpenGroup] = useState<GroupId | null>(null);
  const [preview, setPreview] = useState<PreviewMode>("unlocked");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const aiUsage = useAiUsage();
  const aiDays = lastDays(aiUsage.combined);
  const aiPeak = Math.max(...aiDays.map((day) => day.usage.calls), 1);
  const aiModels = topModels(aiUsage.combined);
  const [backgroundSync, setBackgroundSync] = useState(false);
  const [backgroundSyncError, setBackgroundSyncError] = useState<string | null>(null);
  const backgroundSyncOn = backgroundSyncSupported();
  useMutedAccountsSync(accounts, perimeters);
  const scrollRef = useRef<HTMLDivElement>(null);
  const groups =
    import.meta.env.VITE_PLATFORM === "android" ? GROUPS.filter((entry) => entry.id !== "mcp") : GROUPS;
  const group = groups.find((entry) => entry.id === openGroup) ?? null;
  const enabled = mergeFlags(
    Object.fromEntries(MCP_SERVERS.map((server) => [server.id, server.status === "connected"])),
    mcpEnabled,
  );
  const mcp = mcpCounts((server) => enabled[server.id]);
  const mod = detectModKey();
  const shortcuts = shortcutCatalog();
  const customFolders = folderOptions.filter((entry) => entry.id === "other");
  const updater = useUpdater();
  const updateState = phaseLabel(updater.phase);
  const installedVersion = updater.current ?? APP_VERSION;

  const showGroup = (id: GroupId | null) => {
    setOpenGroup(id);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  useEffect(() => {
    if (!backgroundSyncOn) return;
    let alive = true;
    void readBackgroundSync().then((enabled) => {
      if (alive) setBackgroundSync(enabled);
    });
    return () => {
      alive = false;
    };
  }, [backgroundSyncOn]);

  const toggleBackgroundSync = async (enabled: boolean) => {
    setBackgroundSyncError(null);
    setBackgroundSync(enabled);
    try {
      await writeBackgroundSync(enabled);
    } catch (failure) {
      setBackgroundSync(!enabled);
      setBackgroundSyncError(failureText(failure));
    }
  };

  const updateLlm = (key: keyof LlmConfig, value: string) => {
    setProbe(null);
    if (key !== "model") {
      setModels([]);
      setModelsError(null);
    }
    setLlm({ ...llm, [key]: value });
  };

  const loadModels = async () => {
    setLoadingModels(true);
    setModelsError(null);
    try {
      setModels(await llmModels(llm));
    } catch (failure) {
      setModels([]);
      setModelsError(failure instanceof Error ? failure.message : "échec inconnu");
    } finally {
      setLoadingModels(false);
    }
  };

  const runProbe = async () => {
    setProbing(true);
    setProbe(null);
    try {
      setProbe({ ok: true, text: await llmProbe(llm) });
    } catch (failure) {
      setProbe({ ok: false, text: failure instanceof Error ? failure.message : "échec inconnu" });
    } finally {
      setProbing(false);
    }
  };

  const unreadFor = (id: string) =>
    mails.filter(
      (mail) =>
        mail.unread &&
        mail.folder !== "spam" &&
        mail.folder !== "trash" &&
        (id === ALL_ACCOUNTS || mail.account === id),
    ).length;

  return (
    <div ref={scrollRef} className="relative h-full overflow-y-auto no-scrollbar pb-32">
      <MeshGlow className="h-48" />

      <header className="relative px-5 pt-4">
        {group ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Retour aux réglages"
              onClick={() => showGroup(null)}
              className="focus-ring -ml-2.5 grid size-11 shrink-0 place-items-center rounded-full text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <ArrowLeft className="size-5" />
            </button>
            <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-muted uppercase">Réglages</p>
          </div>
        ) : (
          <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-muted uppercase">{brand}</p>
        )}
        <h1 className="mt-1.5 text-[27px] leading-none font-extrabold tracking-[-0.035em] text-ink">
          {group ? group.label : "Réglages"}
        </h1>
      </header>

      {group === null ? (
        <BlurFade delay={0.05}>
          <Card className="mx-5 mt-5 divide-y divide-line/80 overflow-hidden">
            {groups.map((entry) => {
              const Icon = entry.icon;
              return (
                <Row
                  key={entry.id}
                  icon={<Icon className="size-4" />}
                  label={entry.label}
                  hint={entry.hint}
                  onClick={() => showGroup(entry.id)}
                >
                  <ChevronRight className="size-4 text-ink-muted" />
                </Row>
              );
            })}
          </Card>
        </BlurFade>
      ) : null}

      {openGroup === "comptes" ? (
        <>
          <BlurFade delay={0.05}>
            <Card className="mx-5 mt-5 flex items-center gap-3 p-3.5">
              <Avatar
                name={accounts.find((entry) => entry.id === account)?.label ?? "Compte"}
                size={48}
                rounded="rounded-2xl"
                tone={0}
              />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-[14px] font-bold text-ink">
                  {accounts.find((entry) => entry.id === account)?.label ?? "Tous les comptes"}
                </p>
                <p className="truncate text-[11.5px] font-medium text-ink-muted">
                  {accounts.find((entry) => entry.id === account)?.email ??
                    `${accounts.length} compte${accounts.length > 1 ? "s" : ""}`}
                </p>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-[10.5px] font-bold text-accent-ink">
                <PenLine className="size-3" />
                Signature e-mail
              </span>
            </Card>
          </BlurFade>

          <SectionTitle hint={`${accounts.length} compte${accounts.length > 1 ? "s" : ""}`}>Comptes</SectionTitle>
          <BlurFade delay={0.08}>
            <Card className="mx-5 divide-y divide-line/80 overflow-hidden">
              {accounts.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    "flex items-center gap-1 pr-1.5 transition-colors",
                    item.id === account && "bg-accent-soft/40",
                  )}
                >
                  <button
                    type="button"
                    onClick={onOpenAccounts}
                    className="focus-row flex min-w-0 flex-1 items-center gap-3 py-3 pr-1 pl-3.5 text-left transition-colors hover:bg-surface-2/70"
                  >
                    <span
                      className="grid size-8 shrink-0 place-items-center rounded-xl text-[11px] font-black"
                      style={{ backgroundColor: item.color, color: accentContrast(item.color) }}
                    >
                      {item.label[0]}
                    </span>
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate text-[12.5px] font-bold text-ink">{item.label}</span>
                      <span className="block truncate text-[12px] font-medium text-ink-muted">{item.email}</span>
                    </span>
                    {unreadFor(item.id) > 0 && (
                      <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold text-accent-ink">
                        {unreadFor(item.id)}
                      </span>
                    )}
                    <ChevronRight className="size-4 shrink-0 text-ink-muted" />
                  </button>
                  {mode === "api" && !readOnly && (
                    <button
                      type="button"
                      aria-label={`Retirer le compte ${item.label}`}
                      onClick={() => askRemoveAccount(item)}
                      className="focus-ring grid size-11 shrink-0 place-items-center rounded-full text-ink-muted transition-colors hover:bg-rose-500/10 hover:text-rose-700 dark:hover:text-rose-300"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {readOnly ? null : (
                <Row
                  icon={<Plus className="size-4" />}
                  label="Ajouter un compte"
                  hint="IMAP + SMTP · connexion testée par le service local"
                  onClick={openConnect}
                >
                  <ChevronRight className="size-4 text-ink-muted" />
                </Row>
              )}
              <Row
                icon={<Users className="size-4" />}
                label="Boîte unifiée"
                hint="Choisir les comptes · tous les comptes dans une liste"
                onClick={onOpenAccounts}
              >
                <ChevronRight className="size-4 text-ink-muted" />
              </Row>
            </Card>
          </BlurFade>

          <SectionTitle hint="par compte">Périmètre de synchronisation</SectionTitle>
          <BlurFade delay={0.1}>
            <div className="mx-5 space-y-3">
              {accounts.map((item) => (
                <Card key={item.id} className="overflow-hidden">
                  <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-1">
                    <span
                      className="grid size-8 shrink-0 place-items-center rounded-xl text-[11px] font-black"
                      style={{ backgroundColor: item.color, color: accentContrast(item.color) }}
                    >
                      {item.label[0]}
                    </span>
                    <div className="min-w-0 flex-1 leading-tight">
                      <p className="truncate text-[12.5px] font-bold text-ink">{item.label}</p>
                      <p className="truncate text-[11.5px] font-medium text-ink-muted">{item.email}</p>
                    </div>
                  </div>
                  <div
                    role="group"
                    aria-label={`Périmètre de synchronisation de ${item.label}`}
                    className="divide-y divide-line/80"
                  >
                    <ToggleRow
                      icon={<MailIcon className="size-4" />}
                      label="Mails"
                      hint="Relève la boîte, les dossiers et le fil en direct"
                      checked={perimeterOf(perimeters, item.id).mails}
                      onChange={(value) => setAccountPerimeter(item.id, { mails: value })}
                    />
                    <ToggleRow
                      icon={<CalendarDays className="size-4" />}
                      label="Agenda"
                      hint="Affiche et relit les calendriers du compte (Google, CalDAV rattaché)"
                      checked={perimeterOf(perimeters, item.id).calendar}
                      onChange={(value) => setAccountPerimeter(item.id, { calendar: value })}
                    />
                    <div aria-disabled="true" className="flex w-full items-center gap-3 px-3.5 py-3 opacity-60">
                      <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-soft">
                        <Users className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="block text-[12.5px] font-bold text-ink">Contacts</span>
                        <span className="block text-[11px] font-medium text-ink-muted">{CONTACTS_PENDING}</span>
                      </span>
                      <SwitchTrack checked={false} />
                    </div>
                  </div>
                </Card>
              ))}
              {accounts.length === 0 ? (
                <Card className="p-3.5">
                  <p className="text-[12px] font-medium text-ink-muted">
                    Aucun compte : le périmètre se règle après la connexion d'une boîte.
                  </p>
                </Card>
              ) : null}
            </div>
            <p className="mt-2 px-5 text-[12px] leading-relaxed font-medium text-ink-muted">
              Un agenda coupé garde ses sources CalDAV, ICS et Google rangées : seule la part du compte est mise en
              pause.
            </p>
          </BlurFade>

          {customFolders.length > 0 ? (
            <>
              <SectionTitle hint="compte sélectionné">Dossiers</SectionTitle>
              <BlurFade delay={0.1}>
                <Card className="mx-5 divide-y divide-line/80 overflow-hidden">
                  {customFolders.map((entry) => (
                    <div key={entry.path} className="px-1.5 py-1">
                      <FolderRow
                        label={entry.label}
                        variant="mobile"
                        onDelete={() => void deleteFolder(entry.path, entry.label)}
                      >
                        <div className="flex min-h-11 items-center gap-3 px-2">
                          <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-soft">
                            <FolderTree className="size-4" />
                          </span>
                          <span className="min-w-0 flex-1 leading-tight">
                            <span className="block truncate text-[12.5px] font-bold text-ink">
                              {entry.label}
                            </span>
                            <span className="block truncate text-[11.5px] font-medium text-ink-muted">
                              {entry.path}
                            </span>
                          </span>
                        </div>
                      </FolderRow>
                    </div>
                  ))}
                </Card>
                <p className="mt-2 px-5 text-[12px] leading-relaxed font-medium text-ink-muted">
                  Supprimer un dossier l'efface sur le serveur IMAP, avec les messages qu'il contient.
                </p>
              </BlurFade>
            </>
          ) : null}
        </>
      ) : null}

      {openGroup === "apparence" ? (
        <>
          <SectionTitle hint="personnalisable">Couleur d'accent</SectionTitle>
          <BlurFade delay={0.08}>
            <Card className="mx-5 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="grid size-7 place-items-center rounded-xl bg-accent-soft text-accent-ink">
                    <Palette className="size-3.5" />
                  </span>
                  <p className="text-[12.5px] font-bold text-ink">Couleur d'accent</p>
                </div>
                <span className="font-mono text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
                  {accent}
                </span>
              </div>

              <div className="mt-2.5 flex flex-wrap gap-0.5">
                {ACCENT_PRESETS.map((preset) => {
                  const selected = preset.value.toLowerCase() === accent.toLowerCase();
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      title={preset.name}
                      aria-label={preset.name}
                      aria-pressed={selected}
                      onClick={() => setAccent(preset.value)}
                      className="focus-ring grid size-11 place-items-center rounded-full"
                    >
                      <span
                        className="size-8 rounded-full transition-transform duration-200 hover:scale-110"
                        style={{
                          backgroundColor: preset.value,
                          boxShadow: selected
                            ? `0 0 0 2px var(--surface), 0 0 0 4px ${preset.value}`
                            : "inset 0 0 0 1px rgba(0,0,0,0.06)",
                        }}
                      />
                    </button>
                  );
                })}

                <label
                  className={cn(
                    "relative grid size-11 cursor-pointer place-items-center rounded-full",
                    "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent",
                  )}
                  title="Couleur personnalisée"
                >
                  <span className="grid size-8 place-items-center rounded-full border border-line bg-surface text-[13px] font-black text-ink-soft">
                    +
                  </span>
                  <input
                    type="color"
                    value={accent}
                    onChange={(event) => setAccent(event.target.value)}
                    className="absolute inset-0 cursor-pointer opacity-0"
                    aria-label="Choisir une couleur personnalisée"
                  />
                </label>
              </div>

              <div className="mt-4 flex items-center gap-2 rounded-2xl bg-surface-2 p-3">
                <Avatar name="C" tone={0} size={32} />
                <div className="min-w-0 flex-1 leading-tight">
                  <p className="text-[12px] font-bold text-ink">Aperçu de l'accent</p>
                  <p className="text-[12px] leading-relaxed font-medium text-ink-muted">
                    Boutons, badges et surlignages suivent cette teinte
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-accent px-2.5 py-1 text-[10px] font-bold text-accent-contrast">
                  {accent}
                </span>
              </div>
            </Card>
          </BlurFade>

          <SectionTitle>Modules</SectionTitle>
          <BlurFade delay={0.12}>
            <Card className="mx-5 divide-y divide-line/80 overflow-hidden">
              <ToggleRow
                icon={<CalendarDays className="size-4" />}
                label="Calendrier"
                hint="Onglet Agenda, rendez-vous et disponibilités"
                checked={calendarEnabled}
                onChange={setCalendarEnabled}
              />
              <ToggleRow
                icon={<ListChecks className="size-4" />}
                label="Planification"
                hint="Onglet Planif., tâches et suggestions issues des mails"
                checked={planningEnabled}
                onChange={setPlanningEnabled}
              />
            </Card>
            <p className="mt-2 px-5 text-[12px] leading-relaxed font-medium text-ink-muted">
              Un module désactivé disparaît du dock et du balayage horizontal. Tes données restent en place.
            </p>
          </BlurFade>

          <SectionTitle>Apparence</SectionTitle>
          <BlurFade delay={0.15}>
            <Card className="mx-5 p-1.5">
              <div className="flex gap-1.5">
                {([
                  { label: "Clair", icon: Sun, value: "light" },
                  { label: "Sombre", icon: Moon, value: "dark" },
                  { label: "Auto", icon: SunMoon, value: "auto" },
                ] as { label: string; icon: typeof Sun; value: ThemeMode }[]).map((option) => {
                  const selected = themeMode === option.value;
                  const Icon = option.icon;
                  return (
                    <button
                      key={option.label}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setThemeMode(option.value)}
                      className={cn(
                        "focus-ring flex min-h-11 flex-1 items-center justify-center gap-2 rounded-[18px] py-2.5 text-[12.5px] font-bold transition-all",
                        selected
                          ? "bg-accent-soft text-accent-ink ring-1 ring-accent-ring/60"
                          : "text-ink-muted hover:bg-surface-2",
                      )}
                    >
                      <Icon className="size-4" />
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </Card>
            <div className="mt-3 flex justify-center px-5">
              <button
                type="button"
                onClick={reset}
                className="focus-ring min-h-11 rounded-full border border-line px-4 text-[11.5px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
              >
                Réinitialiser le thème
              </button>
            </div>
          </BlurFade>
        </>
      ) : null}

      {openGroup === "synchronisation" ? (
        <>
          <SectionTitle hint="chiffré de bout en bout">Synchronisation</SectionTitle>
          <BlurFade delay={0.08}>
            <div className="mx-5">
              <SyncSettings variant="mobile" />
            </div>
          </BlurFade>

          <CalendarsSettings />

          <SectionTitle hint={notifications.enabled ? "actives" : "coupées"}>Notifications</SectionTitle>
          <BlurFade delay={0.12}>
            <Card className="mx-5 divide-y divide-line/80 overflow-hidden">
              <ToggleRow
                icon={<Bell className="size-4" />}
                label="Notifications"
                hint="Nouveaux mails et rappels, tant que l'app tourne"
                checked={notifications.enabled}
                onChange={(value) => {
                  setNotifications({ enabled: value });
                  if (value) void requestNotifications();
                }}
              />
              <div className="px-3.5 py-3">
                <div className="flex items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-soft">
                    <Type className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="text-[12.5px] font-bold text-ink">Aperçu du texte</p>
                    <p className="text-[12px] font-medium text-ink-muted">Dans les notifications push</p>
                  </div>
                </div>
                <div
                  role="radiogroup"
                  aria-label="Aperçu du texte des notifications"
                  className={cn("mt-2.5 flex gap-1.5", !notifications.enabled && "opacity-55")}
                >
                  {PREVIEW_OPTIONS.map((option) => {
                    const selected = preview === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        disabled={!notifications.enabled}
                        aria-checked={selected}
                        onClick={() => setPreview(option.value)}
                        className={cn(
                          "focus-ring min-h-11 flex-1 rounded-xl px-1 text-[11.5px] font-bold transition-colors disabled:cursor-not-allowed",
                          selected
                            ? "bg-accent text-accent-contrast"
                            : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
                        )}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-[12px] leading-relaxed font-medium text-ink-muted">
                  Les messages chiffrés ne sont jamais inclus en clair dans la notification push.
                </p>
              </div>
            </Card>

            <Card className="mx-5 mt-3 divide-y divide-line/80 overflow-hidden">
              <ToggleRow
                icon={<CalendarDays className="size-4" />}
                label="Rappels d'agenda"
                hint="Un rendez-vous du calendrier commence bientôt"
                checked={notifications.calendar}
                onChange={(value) => setNotifications({ calendar: value })}
              />
              <div className="px-3.5 py-3">
                <div className="flex items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-soft">
                    <Clock className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="text-[12.5px] font-bold text-ink">Délai du rappel</p>
                    <p className="text-[12px] font-medium text-ink-muted">Avant le début du rendez-vous</p>
                  </div>
                </div>
                <div
                  role="radiogroup"
                  aria-label="Délai du rappel calendrier"
                  className={cn("mt-2.5 flex gap-1.5", !notifications.calendar && "opacity-55")}
                >
                  {CALENDAR_LEAD_MINUTES.map((minutes) => {
                    const selected = notifications.calendarMinutes === minutes;
                    return (
                      <button
                        key={minutes}
                        type="button"
                        role="radio"
                        disabled={!notifications.calendar}
                        aria-checked={selected}
                        onClick={() => setNotifications({ calendarMinutes: minutes })}
                        className={cn(
                          "focus-ring min-h-11 flex-1 rounded-xl px-1 text-[11.5px] font-bold transition-colors disabled:cursor-not-allowed",
                          selected
                            ? "bg-accent text-accent-contrast"
                            : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
                        )}
                      >
                        {minutes === 0 ? "À l'heure" : `${minutes} min`}
                      </button>
                    );
                  })}
                </div>
              </div>
            </Card>

            <p className="mt-2 px-5 text-[12px] leading-relaxed font-medium text-ink-muted">
              Un compte absent de la liste suit l'interrupteur général. App fermée, aucune notification n'est
              envoyée.
            </p>
          </BlurFade>

          <SectionTitle hint={`${accounts.length} compte${accounts.length > 1 ? "s" : ""}`}>
            Notifications par compte
          </SectionTitle>
          <BlurFade delay={0.155}>
            <Card className="mx-5 divide-y divide-line/80 overflow-hidden">
              {accounts.map((item) => (
                <ToggleRow
                  key={item.id}
                  icon={<Bell className="size-4" />}
                  label={item.label}
                  hint={item.email}
                  checked={notifications.accounts[item.id] !== false}
                  onChange={(value) => setAccountNotification(item.id, value)}
                />
              ))}
              {accounts.length === 0 ? (
                <p className="px-3.5 py-3 text-[12px] font-medium text-ink-muted">
                  Aucun compte : ajoute une boîte pour régler ses notifications.
                </p>
              ) : null}
            </Card>
          </BlurFade>

          {backgroundSyncOn ? (
            <>
              <SectionTitle hint="Android">Application</SectionTitle>
              <BlurFade delay={0.19}>
                <Card className="mx-5 divide-y divide-line/80 overflow-hidden">
                  <ToggleRow
                    icon={<RefreshCw className="size-4" />}
                    label="Synchronisation en arrière-plan"
                    hint="Relevé des boîtes app fermée"
                    checked={backgroundSync}
                    onChange={(value) => void toggleBackgroundSync(value)}
                  />
                </Card>
                <p className="mt-2 px-5 text-[12px] leading-relaxed font-medium text-ink-muted">
                  Android relève les boîtes toutes les 15 minutes au mieux, réseau obligatoire. Le widget de
                  l'écran d'accueil affiche les non-lus par compte.
                </p>
                {backgroundSyncError ? (
                  <p className="mx-5 mt-2 flex items-start gap-1.5 rounded-xl bg-rose-500/10 px-2.5 py-2 text-[11px] font-semibold text-rose-700 dark:text-rose-300">
                    <AlertTriangle className="mt-px size-3.5 shrink-0" />
                    Réglage non enregistré · {backgroundSyncError}
                  </p>
                ) : null}
              </BlurFade>
            </>
          ) : null}
        </>
      ) : null}

      {openGroup === "securite" ? (
        <>
          <SectionTitle hint="clés et chiffrement">Sécurité</SectionTitle>
          <BlurFade delay={0.08}>
            <Card className="mx-5 divide-y divide-line/80 overflow-hidden">
              <Row
                icon={<KeyRound className="size-4" />}
                label="Gérer mes clés PGP"
                hint="Générer, importer, exporter et supprimer"
                onClick={onOpenPgp}
              >
                <ChevronRight className="size-4 text-ink-muted" />
              </Row>
            </Card>
          </BlurFade>
        </>
      ) : null}

      {openGroup === "ia" ? (
        <>
          <SectionTitle hint={llmReady(llm) ? "modèle configuré" : "local"}>
            Intelligence artificielle
          </SectionTitle>
          <BlurFade delay={0.08}>
            <Card className="mx-5 space-y-3 p-3.5">
              <p className="text-[12px] leading-relaxed font-medium text-ink-muted">
                Branche un modèle compatible OpenAI pour les suggestions de réponse, la réécriture et les
                résumés. Sans configuration, Lavande propose des réponses locales.
              </p>
              {LLM_FIELDS.map((field) => (
                <label key={field.key} className="block">
                  <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                    {field.label}
                  </span>
                  <input
                    aria-label={field.aria}
                    type={field.password ? "password" : "text"}
                    list={field.key === "model" ? "llm-models" : undefined}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder={field.placeholder}
                    value={llm[field.key]}
                    onChange={(event) => updateLlm(field.key, event.target.value)}
                    className="focus-ring mt-1.5 h-11 w-full rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink placeholder:font-medium placeholder:text-ink-muted"
                  />
                </label>
              ))}
              <datalist id="llm-models">
                {models.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
              <button
                type="button"
                disabled={!llmReady(llm) || probing}
                onClick={() => void runProbe()}
                className="focus-ring min-h-11 w-full rounded-full bg-accent px-4 text-[12.5px] font-bold text-accent-contrast transition-opacity disabled:opacity-40"
              >
                {probing ? "Test en cours…" : "Tester la connexion"}
              </button>
              <button
                type="button"
                disabled={!llm.endpoint.trim() || !llm.apiKey.trim() || loadingModels}
                onClick={() => void loadModels()}
                className="focus-ring min-h-11 w-full rounded-full border border-line bg-surface px-4 text-[12.5px] font-bold text-ink-soft transition-colors disabled:opacity-40"
              >
                {loadingModels ? "Chargement…" : "Charger les modèles"}
              </button>
              {modelsError ? (
                <p className="rounded-2xl bg-rose-500/10 px-3 py-2 text-[12px] leading-relaxed font-semibold break-words text-rose-600 dark:text-rose-300">
                  {`Liste indisponible · ${modelsError}`}
                </p>
              ) : null}
              {probe ? (
                <p
                  className={cn(
                    "rounded-2xl px-3 py-2 text-[12px] leading-relaxed font-semibold break-words",
                    probe.ok
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "bg-rose-500/10 text-rose-600 dark:text-rose-300",
                  )}
                >
                  {probe.ok ? `Réponse du modèle · ${probe.text}` : `Échec · ${probe.text}`}
                </p>
              ) : null}
              <p className="text-[11.5px] leading-relaxed font-medium text-ink-muted">
                {llmReady(llm)
                  ? "IA active · les propositions utilisent le modèle configuré."
                  : "IA inactive · propositions locales uniquement."}
              </p>
            </Card>
          </BlurFade>

          <BlurFade delay={0.1}>
            <Card className="mx-5 mt-3 space-y-3 p-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                  Consommation
                </span>
                <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold text-ink-muted">
                  {aiUsage.devices > 1 ? `tous appareils · ${aiUsage.devices}` : "cet appareil"}
                </span>
              </div>
              <dl className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-surface-2 px-2 py-2">
                  <dt className="text-[10px] font-bold tracking-[0.1em] text-ink-muted uppercase">Appels</dt>
                  <dd className="text-[15px] font-extrabold text-ink">{formatTokens(aiUsage.combined.total.calls)}</dd>
                </div>
                <div className="rounded-xl bg-surface-2 px-2 py-2">
                  <dt className="text-[10px] font-bold tracking-[0.1em] text-ink-muted uppercase">Entrée</dt>
                  <dd className="text-[15px] font-extrabold text-ink">{formatTokens(aiUsage.combined.total.prompt)}</dd>
                </div>
                <div className="rounded-xl bg-surface-2 px-2 py-2">
                  <dt className="text-[10px] font-bold tracking-[0.1em] text-ink-muted uppercase">Sortie</dt>
                  <dd className="text-[15px] font-extrabold text-ink">
                    {formatTokens(aiUsage.combined.total.completion)}
                  </dd>
                </div>
              </dl>
              {aiModels.length > 0 ? (
                <ul className="space-y-1">
                  {aiModels.map((entry) => (
                    <li
                      key={entry.model}
                      className="flex items-center justify-between gap-2 text-[12px] font-semibold text-ink-soft"
                    >
                      <span className="truncate">{entry.model}</span>
                      <span className="shrink-0 text-ink-muted">
                        {`${formatTokens(entry.usage.calls)} appel(s) · ${formatTokens(entry.usage.prompt + entry.usage.completion)} tokens`}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] leading-relaxed font-medium text-ink-muted">
                  Aucun appel enregistré · les tokens sont comptés à chaque réponse du modèle.
                </p>
              )}
              <div className="flex items-end justify-between gap-1.5">
                {aiDays.map((entry) => (
                  <div key={entry.day} className="flex flex-1 flex-col items-center gap-1">
                    <div
                      className="w-full rounded-t-md bg-accent/70"
                      style={{ height: `${Math.max(3, (entry.usage.calls / aiPeak) * 40)}px` }}
                      title={`${entry.day} · ${entry.usage.calls} appel(s)`}
                    />
                    <span className="text-[9.5px] font-bold text-ink-muted">{entry.day.slice(8)}</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold text-ink-muted">7 derniers jours · 90 jours conservés</span>
                <button
                  type="button"
                  aria-label="Réinitialiser la consommation"
                  onClick={() => resetAiStats()}
                  className="focus-ring rounded-full border border-line px-3 py-1.5 text-[11.5px] font-bold text-ink-soft"
                >
                  Réinitialiser
                </button>
              </div>
            </Card>
          </BlurFade>

          <BlurFade delay={0.12}>
            <Card className="mx-5 mt-3 divide-y divide-line/80 overflow-hidden">
              <ToggleRow
                icon={<Sparkles className="size-4" />}
                label="Suggestions de réponse IA"
                hint="Le modèle lit la conversation du fil · désactivable, repli sur les réponses locales"
                checked={aiReplyEnabled}
                onChange={setAiReplyEnabled}
              />
              <ToggleRow
                icon={<Sparkles className="size-4" />}
                label="Résumés périodiques"
                hint="Un résumé de la boîte de réception matin, midi et soir"
                checked={summary.enabled}
                onChange={(value) => setSummary({ enabled: value })}
              />
              <ToggleRow
                icon={<Lock className="size-4" />}
                label="Autoriser l'analyse de mes mails par le LLM"
                hint="Sans accord, le résumé reste local (compteurs et expéditeurs)"
                checked={summary.llmConsent}
                onChange={(value) => setSummary({ llmConsent: value })}
              />
              <ToggleRow
                icon={<ListChecks className="size-4" />}
                label="Suggestions de tâches IA"
                hint="Extraire des tâches actionnables des mails récents · tout reste à valider"
                checked={aiTasks.enabled}
                onChange={(value) => setAiTasks({ enabled: value })}
              />
              <ToggleRow
                icon={<CalendarDays className="size-4" />}
                label="Suggestions de rendez-vous IA"
                hint="Extraire aussi des rendez-vous des mêmes mails · à valider dans l'agenda"
                checked={aiTasks.events}
                onChange={(value) => setAiTasks({ events: value })}
              />
            </Card>
            <p className="mt-2 px-5 text-[12px] leading-relaxed font-medium text-ink-muted">
              Le modèle reçoit uniquement les expéditeurs, objets et premières lignes des mails ; aucune tâche
              n'est créée sans validation.
            </p>
          </BlurFade>

          <SectionTitle
            hint={`${accounts.length - aiTasks.excludedAccounts.filter((id) => accounts.some((item) => item.id === id)).length} sur ${accounts.length}`}
          >
            Suggestions par compte
          </SectionTitle>
          <BlurFade delay={0.16}>
            <Card className="mx-5 divide-y divide-line/80 overflow-hidden">
              {accounts.map((item) => {
                const excluded = aiTasks.excludedAccounts.includes(item.id);
                return (
                  <ToggleRow
                    key={item.id}
                    icon={<Sparkles className="size-4" />}
                    label={item.label}
                    hint={
                      excluded
                        ? "Exclu · ses mails ne produisent ni tâche ni rendez-vous suggérés"
                        : "Analysé par l'IA"
                    }
                    checked={!excluded}
                    onChange={(value) =>
                      setAiTasks({
                        excludedAccounts: value
                          ? aiTasks.excludedAccounts.filter((id) => id !== item.id)
                          : [...aiTasks.excludedAccounts, item.id],
                      })
                    }
                  />
                );
              })}
              {accounts.length === 0 ? (
                <p className="px-3.5 py-3 text-[12px] font-medium text-ink-muted">
                  Aucun compte : ajoute une boîte pour l'exclure des suggestions.
                </p>
              ) : null}
            </Card>
          </BlurFade>
        </>
      ) : null}

      {openGroup === "mcp" ? (
        <>
          <SectionTitle>Assistant</SectionTitle>
          <BlurFade delay={0.08}>
            <Card className="mx-5 divide-y divide-line/80 overflow-hidden">
              <Row
                icon={<Blocks className="size-4" />}
                label="Serveurs MCP"
                hint={`${mcp.activeServers} serveurs actifs · ${mcp.activeTools} outils actifs`}
                onClick={onOpenMcp}
              >
                <ChevronRight className="size-4 text-ink-muted" />
              </Row>
            </Card>
          </BlurFade>
        </>
      ) : null}

      {openGroup === "application" ? (
        <>
          <SectionTitle>Gestes des mails</SectionTitle>
          <BlurFade delay={0.08}>
            <Card className="mx-5 space-y-3 p-3.5">
              {(
                [
                  { side: "left" as const, title: "Glisser vers la gauche", current: swipeLeft },
                  { side: "right" as const, title: "Glisser vers la droite", current: swipeRight },
                ]
              ).map((row) => (
                <div key={row.side}>
                  <p className="mb-1.5 text-[11px] font-bold text-ink">{row.title}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {SWIPE_ACTIONS.map((action) => {
                      const active = action.id === row.current;
                      return (
                        <button
                          key={action.id}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setSwipe(row.side, action.id)}
                          className={cn(
                            "focus-ring min-h-11 rounded-full px-3 text-[11px] font-bold transition-all",
                            active
                              ? "bg-accent text-accent-contrast shadow-[0_4px_12px_-6px_var(--accent)]"
                              : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
                          )}
                        >
                          {action.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <p className="text-[12px] leading-relaxed font-medium text-ink-muted">
                Ces gestes s'appliquent aux mails de la boîte. Les gestes des suggestions de la
                planification sont gérés séparément.
              </p>
            </Card>
          </BlurFade>

          <SectionTitle hint={mod === "meta" ? "⌘ sur Mac" : "Ctrl sur cet appareil"}>
            Raccourcis clavier
          </SectionTitle>
          <BlurFade delay={0.12}>
            <Card className="mx-5 overflow-hidden">
              <button
                type="button"
                aria-expanded={shortcutsOpen}
                onClick={() => setShortcutsOpen(!shortcutsOpen)}
                className="focus-row flex w-full items-center gap-3 px-3.5 py-3 transition-colors hover:bg-surface-2/70"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-soft">
                  <Keyboard className="size-4" />
                </span>
                <span className="min-w-0 flex-1 text-left leading-tight">
                  <span className="block text-[12.5px] font-bold text-ink">Toutes les touches</span>
                  <span className="block text-[12px] font-medium text-ink-muted">
                    {shortcuts.length} raccourcis · navigation, message et aide
                  </span>
                </span>
                <ChevronDown
                  className={cn(
                    "size-4 shrink-0 text-ink-muted transition-transform duration-200",
                    shortcutsOpen && "rotate-180",
                  )}
                />
              </button>
              {shortcutsOpen && (
                <div className="border-t border-line px-1 py-1">
                  <ShortcutList shortcuts={shortcuts} mod={mod} />
                </div>
              )}
            </Card>
          </BlurFade>

          <SectionTitle hint={`v${installedVersion}`}>Mise à jour</SectionTitle>
          <BlurFade delay={0.14}>
            <Card className="mx-5 space-y-3 p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div className="leading-tight">
                  <p className={MOBILE_LABEL}>Version installée</p>
                  <p className="mt-1 text-[17px] font-extrabold tracking-[-0.02em] text-ink tabular-nums">
                    v{installedVersion}
                  </p>
                </div>
                {updater.supported ? (
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[10.5px] font-bold",
                      UPDATE_TONES[updateState.tone],
                    )}
                  >
                    {updateState.label}
                  </span>
                ) : null}
              </div>

              {updater.supported ? (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      disabled={updater.busy}
                      onClick={() => void updater.check()}
                      className={SOURCE_ACTION}
                    >
                      <RefreshCw
                        className={cn("size-3.5", updater.phase.kind === "checking" && "animate-spin")}
                      />
                      Vérifier les mises à jour
                    </button>
                    {updater.canInstall ? (
                      <button
                        type="button"
                        disabled={updater.busy}
                        onClick={() => void updater.install()}
                        className="focus-ring inline-flex min-h-10 items-center gap-1 rounded-full bg-accent px-3 text-[11.5px] font-bold text-accent-contrast disabled:pointer-events-none disabled:opacity-45"
                      >
                        <Download className="size-3.5" />
                        Installer
                      </button>
                    ) : null}
                  </div>

                  {updater.phase.kind === "downloading" ? (
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className={cn(
                          "h-full rounded-full bg-accent transition-[width] duration-300",
                          updater.phase.percent === null && "animate-pulse",
                        )}
                        style={{ width: `${updater.phase.percent ?? 35}%` }}
                      />
                    </div>
                  ) : null}

                  {updater.phase.kind === "available" && updater.phase.notes ? (
                    <p className="max-h-40 overflow-y-auto rounded-xl bg-surface-2/70 px-2.5 py-2 text-[11.5px] leading-relaxed font-medium whitespace-pre-line text-ink-soft">
                      {updater.phase.notes}
                    </p>
                  ) : null}

                  {updater.phase.kind === "error" ? (
                    <p className="flex items-start gap-1.5 rounded-xl bg-rose-500/10 px-2.5 py-2 text-[11px] font-semibold text-rose-700 dark:text-rose-300">
                      <AlertTriangle className="mt-px size-3.5 shrink-0" />
                      {updater.phase.message}
                    </p>
                  ) : null}

                  <p className="text-[11px] leading-relaxed font-medium text-ink-muted">
                    L'APK signé est vérifié avant installation, puis Android installe et relance
                    Lavande sur la nouvelle version.
                  </p>
                </>
              ) : null}
            </Card>
          </BlurFade>

          <BlurFade delay={0.15}>
            <div className="mt-6 px-5 text-center">
              <p className="text-[11px] font-semibold text-ink-muted">
                <AnimatedGradientText>{brand}</AnimatedGradientText> · v{APP_VERSION}
                {import.meta.env.VITE_DISTRIBUTION === "1" ? null : " · design preview"}
              </p>
              {import.meta.env.VITE_DISTRIBUTION === "1" ? null : (
                <a
                  href="?desktop"
                  className="focus-ring mt-2 flex min-h-11 items-center justify-center rounded-full text-[11.5px] font-bold text-accent-ink transition-colors hover:bg-accent-soft"
                >
                  Voir la maquette PC →
                </a>
              )}
            </div>
          </BlurFade>
        </>
      ) : null}
    </div>
  );
}

const MOBILE_FIELD =
  "focus-ring h-11 w-full rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink placeholder:font-medium placeholder:text-ink-muted";

const failureText = (failure: unknown): string =>
  failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "échec inconnu";

const MOBILE_LABEL = "text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase";

const UPDATE_TONES: Record<UpdateTone, string> = {
  neutral: "bg-surface-2 text-ink-muted",
  accent: "bg-accent-soft text-accent-ink",
  green: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  amber: "bg-amber-500/14 text-amber-700 dark:text-amber-300",
  rose: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
};

const SOURCE_ACTION =
  "focus-ring inline-flex min-h-10 items-center gap-1 rounded-full border border-line bg-surface px-2.5 text-[11.5px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink disabled:pointer-events-none disabled:opacity-45";

const ADD_TABS = [
  { id: "ics", label: "ICS" },
  { id: "caldav", label: "CalDAV" },
  { id: "google", label: "Google" },
] as const;

type AddTab = (typeof ADD_TABS)[number]["id"];

function ToneDots({ label, value, onPick }: { label: string; value: number; onPick: (tone: number) => void }) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-0.5">
      {TONE_DOT.map((dot, index) => (
        <button
          key={dot}
          type="button"
          aria-label={`${label} · ton ${index + 1}`}
          aria-pressed={value === index}
          onClick={() => onPick(index)}
          className={cn(
            "focus-ring grid size-10 place-items-center rounded-full transition-opacity",
            value === index ? "ring-2 ring-accent-ring" : "opacity-55 hover:opacity-100",
          )}
        >
          <span className={cn("size-4 rounded-full", dot)} />
        </button>
      ))}
    </div>
  );
}

function CalendarsSettings() {
  const { notify, readOnly, openConnect } = useMailStore();
  const sources = useCalendarSources(notify);
  const [draftName, setDraftName] = useState("");
  const [draftTone, setDraftTone] = useState(0);
  const [draftUrl, setDraftUrl] = useState("");
  const [caldav, setCaldav] = useState({ url: "", username: "", password: "" });
  const [tab, setTab] = useState<AddTab>("ics");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const count = sources.calendars.length;

  const addLocal = () => {
    if (sources.addLocal({ name: draftName, tone: draftTone })) setDraftName("");
  };

  const subscribe = async () => {
    if (await sources.subscribeIcs({ url: draftUrl, name: draftName, tone: draftTone })) {
      setDraftName("");
      setDraftUrl("");
    }
  };

  const importFile = async (file: File) => {
    if (await sources.importIcsFile({ file, name: draftName, tone: draftTone })) setDraftName("");
  };

  const connectCaldav = async () => {
    const added = await sources.addCaldav({ ...caldav, name: draftName, tone: draftTone });
    if (!added) return;
    setDraftName("");
    setCaldav({ url: "", username: "", password: "" });
  };

  const addGoogle = async (account: ApiAccount, calendar: GoogleCalendar) => {
    if (await sources.addGoogle(account, calendar, { name: draftName, tone: draftTone })) setDraftName("");
  };

  const commitRename = (id: string) => {
    if (sources.rename(id, renameValue)) setRenaming(null);
  };

  const removeSource = async (id: string) => {
    if (await sources.remove(id)) setRemoving(null);
  };

  return (
    <>
      <SectionTitle hint={`${count} source${count > 1 ? "s" : ""}`}>Calendriers</SectionTitle>
      <BlurFade delay={0.1}>
        <Card className="mx-5 overflow-hidden">
          <div className="grid gap-2.5 p-3.5">
            <label className="block">
              <span className={MOBILE_LABEL}>Nom</span>
              <input
                aria-label="Nom du nouveau calendrier"
                placeholder="Associatif"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") addLocal();
                }}
                className={cn(MOBILE_FIELD, "mt-1.5")}
              />
            </label>
            <div className="flex items-center justify-between gap-2">
              <span className={MOBILE_LABEL}>Ton</span>
              <ToneDots label="Ton du nouveau calendrier" value={draftTone} onPick={setDraftTone} />
            </div>
            <button
              type="button"
              onClick={addLocal}
              className="focus-ring min-h-11 rounded-full bg-accent px-4 text-[12.5px] font-bold text-accent-contrast"
            >
              Créer un calendrier local
            </button>

            <div className="mt-1 flex gap-1.5" role="group" aria-label="Type de source">
              {ADD_TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={tab === entry.id}
                  onClick={() => setTab(entry.id)}
                  className={cn(
                    "focus-ring min-h-10 flex-1 rounded-full text-[11.5px] font-bold transition-colors",
                    tab === entry.id
                      ? "bg-accent-soft text-accent-ink ring-1 ring-accent-ring/60"
                      : "border border-line bg-surface text-ink-soft",
                  )}
                >
                  {entry.label}
                </button>
              ))}
            </div>

            {tab === "ics" ? (
              <div className="grid gap-2">
                <label className="block">
                  <span className={MOBILE_LABEL}>Abonnement iCalendar · URL</span>
                  <input
                    aria-label="URL du calendrier ICS"
                    placeholder="https://exemple.tld/calendrier.ics"
                    value={draftUrl}
                    onChange={(event) => setDraftUrl(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void subscribe();
                    }}
                    className={cn(MOBILE_FIELD, "mt-1.5")}
                  />
                </label>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    disabled={sources.busy}
                    onClick={() => void subscribe()}
                    className="focus-ring inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-accent text-[12.5px] font-bold text-accent-contrast disabled:opacity-45"
                  >
                    <Link2 className="size-4" />
                    Abonner
                  </button>
                  <button
                    type="button"
                    disabled={sources.busy}
                    onClick={() => fileInput.current?.click()}
                    className={cn(SOURCE_ACTION, "min-h-11 flex-1 justify-center")}
                  >
                    <Upload className="size-4" />
                    Fichier .ics
                  </button>
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".ics,text/calendar"
                  hidden
                  data-testid="ics-file-input"
                  aria-label="Fichier iCalendar"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void importFile(file);
                  }}
                />
              </div>
            ) : null}

            {tab === "caldav" ? (
              <div className="grid gap-2">
                <label className="block">
                  <span className={MOBILE_LABEL}>Serveur CalDAV · URL</span>
                  <input
                    aria-label="URL du serveur CalDAV"
                    placeholder="https://caldav.exemple.tld/"
                    value={caldav.url}
                    onChange={(event) => setCaldav((current) => ({ ...current, url: event.target.value }))}
                    className={cn(MOBILE_FIELD, "mt-1.5")}
                  />
                </label>
                <label className="block">
                  <span className={MOBILE_LABEL}>Identifiant</span>
                  <input
                    aria-label="Identifiant CalDAV"
                    autoComplete="username"
                    autoCapitalize="none"
                    value={caldav.username}
                    onChange={(event) => setCaldav((current) => ({ ...current, username: event.target.value }))}
                    className={cn(MOBILE_FIELD, "mt-1.5")}
                  />
                </label>
                <label className="block">
                  <span className={MOBILE_LABEL}>Mot de passe</span>
                  <input
                    type="password"
                    aria-label="Mot de passe CalDAV"
                    autoComplete="new-password"
                    value={caldav.password}
                    onChange={(event) => setCaldav((current) => ({ ...current, password: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void connectCaldav();
                    }}
                    className={cn(MOBILE_FIELD, "mt-1.5")}
                  />
                </label>
                <button
                  type="button"
                  disabled={sources.busy}
                  onClick={() => void connectCaldav()}
                  className="focus-ring inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full bg-accent text-[12.5px] font-bold text-accent-contrast disabled:opacity-45"
                >
                  <PlugZap className="size-4" />
                  Connecter
                </button>
              </div>
            ) : null}

            {tab === "google" ? (
              <div className="grid gap-2">
                {sources.googleConnected.length === 0 ? (
                  <>
                    <p className="text-[12px] leading-relaxed font-medium text-ink-muted">
                      Aucun compte Google connecté : le consentement OAuth du compte ouvre aussi l'agenda.
                    </p>
                    {readOnly ? null : (
                      <button
                        type="button"
                        onClick={openConnect}
                        className={cn(SOURCE_ACTION, "min-h-11 justify-center")}
                      >
                        <PlugZap className="size-4" />
                        Connecter un compte Google
                      </button>
                    )}
                  </>
                ) : (
                  sources.googleConnected.map((account) => {
                    const list = sources.googleCalendars[account.id] ?? [];
                    const error = sources.googleErrors[account.id];
                    const busy = sources.googleBusy[account.id] === true;
                    return (
                      <div key={account.id} className="grid gap-1.5 rounded-2xl bg-surface-2/60 p-2.5">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[11.5px] font-bold text-ink">
                            {account.label} · {account.email}
                          </span>
                          <button
                            type="button"
                            aria-label={`Actualiser les calendriers Google de ${account.email}`}
                            disabled={busy}
                            onClick={() => void sources.loadGoogleCalendars(account.id)}
                            className={cn(SOURCE_ACTION, "ml-auto")}
                          >
                            <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />
                            Relire
                          </button>
                        </div>
                        {error ? (
                          <p role="alert" className="text-[11px] font-bold text-rose-700 dark:text-rose-300">
                            {error}
                          </p>
                        ) : null}
                        {!error && list.length === 0 ? (
                          <p className="text-[11px] font-medium text-ink-muted">
                            {busy ? "Lecture des calendriers…" : "Aucun calendrier sur ce compte."}
                          </p>
                        ) : null}
                        {list.map((calendar) => (
                          <div key={calendar.id} className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-ink">
                              {calendar.summary || calendar.id}
                            </span>
                            {sources.googleAttached(account.id, calendar.id) ? (
                              <span className="text-[10.5px] font-semibold text-ink-muted">Dans l'agenda</span>
                            ) : (
                              <button
                                type="button"
                                aria-label={`Ajouter le calendrier Google ${calendar.summary || calendar.id}`}
                                onClick={() => void addGoogle(account, calendar)}
                                className={SOURCE_ACTION}
                              >
                                <Plus className="size-3.5" strokeWidth={3} />
                                Ajouter
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    );
                  })
                )}
              </div>
            ) : null}

            {sources.error ? (
              <p
                role="alert"
                className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11.5px] font-bold text-rose-700 dark:text-rose-300"
              >
                {sources.error}
              </p>
            ) : null}
            <p className="text-[11.5px] leading-relaxed font-medium text-ink-muted">
              Aucun compte mail n'est requis. Les identifiants CalDAV partent au démon, qui les garde dans son
              coffre ; ils ne sont jamais rangés ici.
            </p>
          </div>
        </Card>
      </BlurFade>

      <SectionTitle hint="relire, renommer, supprimer">Sources</SectionTitle>
      <BlurFade delay={0.12}>
        <Card className="mx-5 divide-y divide-line/80 overflow-hidden">
          {sources.calendars.map((entry) => (
            <CalendarRow
              key={entry.id}
              entry={entry}
              count={sources.countOf(entry.id)}
              detail={sources.detailOf(entry)}
              paused={sources.paused(entry)}
              refreshing={sources.refreshing === entry.id}
              renaming={renaming === entry.id}
              removing={removing === entry.id}
              renameValue={renameValue}
              onRenameValue={setRenameValue}
              onStartRename={() => {
                setRemoving(null);
                setRenameValue(entry.name);
                setRenaming(entry.id);
              }}
              onCommitRename={() => commitRename(entry.id)}
              onCancelRename={() => setRenaming(null)}
              onTone={(tone) => sources.setTone(entry.id, tone)}
              onRefresh={() => void sources.refresh(entry)}
              onAskRemove={() => setRemoving(entry.id)}
              onCancelRemove={() => setRemoving(null)}
              onRemove={() => void removeSource(entry.id)}
            />
          ))}
          {count === 0 ? (
            <p className="px-3.5 py-3 text-[12px] font-medium text-ink-muted">
              Aucun calendrier : les événements gardent leur propre ton.
            </p>
          ) : null}
        </Card>
        <p className="mt-2 px-5 text-[12px] leading-relaxed font-medium text-ink-muted">
          Supprimer une source ICS, CalDAV ou Google retire ses événements de l'agenda ; une source CalDAV part aussi
          du démon.
        </p>
      </BlurFade>
    </>
  );
}

function CalendarRow({
  entry,
  count,
  detail,
  paused,
  refreshing,
  renaming,
  removing,
  renameValue,
  onRenameValue,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onTone,
  onRefresh,
  onAskRemove,
  onCancelRemove,
  onRemove,
}: {
  entry: CalendarDef;
  count: number;
  detail: string | undefined;
  paused: boolean;
  refreshing: boolean;
  renaming: boolean;
  removing: boolean;
  renameValue: string;
  onRenameValue: (value: string) => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onTone: (tone: number) => void;
  onRefresh: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}) {
  const external = isExternalCalendar(entry);
  const reloadable = external && (!isIcsCalendar(entry) || Boolean(icsUrlOf(entry)));
  return (
    <div className="px-3.5 py-2.5" data-testid={`calendar-source-${entry.id}`}>
      <div className="flex items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", TONE_DOT[entry.tone % TONE_DOT.length])} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-bold text-ink">{entry.name}</span>
        <span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold text-ink-muted">
          {calendarSourceKind(entry)}
        </span>
        {paused ? (
          <span className="shrink-0 rounded-md bg-amber-500/14 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300">
            En pause
          </span>
        ) : null}
      </div>
      {external ? (
        <p className="mt-0.5 truncate text-[11px] font-medium text-ink-muted">
          {detail ?? "URL inconnue"}
          <span className="tabular-nums">
            {" "}
            · {count} événement{count > 1 ? "s" : ""}
          </span>
          {paused ? " · agenda du compte coupé" : ""}
        </p>
      ) : null}
      {renaming ? (
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            aria-label={`Nouveau nom pour ${entry.name}`}
            value={renameValue}
            autoFocus
            onChange={(event) => onRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onCommitRename();
              if (event.key === "Escape") onCancelRename();
            }}
            className={cn(MOBILE_FIELD, "h-10")}
          />
          <button type="button" aria-label="Valider" onClick={onCommitRename} className={SOURCE_ACTION}>
            <Check className="size-3.5" strokeWidth={3} />
            Valider
          </button>
          <button type="button" aria-label="Annuler" onClick={onCancelRename} className={SOURCE_ACTION}>
            Annuler
          </button>
        </div>
      ) : (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <ToneDots label={`Ton de ${entry.name}`} value={entry.tone % TONE_DOT.length} onPick={onTone} />
          {reloadable ? (
            <button
              type="button"
              aria-label={`Actualiser le calendrier ${entry.name}`}
              disabled={refreshing}
              onClick={onRefresh}
              className={SOURCE_ACTION}
            >
              <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
              Actualiser
            </button>
          ) : null}
          <button
            type="button"
            aria-label={`Renommer le calendrier ${entry.name}`}
            onClick={onStartRename}
            className={SOURCE_ACTION}
          >
            <PenLine className="size-3.5" />
            Renommer
          </button>
          {removing ? (
            <>
              <span className="text-[10.5px] font-semibold text-ink-muted">Supprimer ?</span>
              <button
                type="button"
                aria-label="Confirmer"
                onClick={onRemove}
                className="focus-ring inline-flex min-h-10 items-center gap-1 rounded-full bg-rose-500/12 px-2.5 text-[11.5px] font-bold text-rose-700 dark:text-rose-300"
              >
                <Trash2 className="size-3.5" />
                Confirmer
              </button>
              <button type="button" aria-label="Annuler" onClick={onCancelRemove} className={SOURCE_ACTION}>
                Annuler
              </button>
            </>
          ) : (
            <button
              type="button"
              aria-label={`Supprimer le calendrier ${entry.name}`}
              onClick={onAskRemove}
              className="focus-ring inline-flex min-h-10 items-center gap-1 rounded-full border border-line bg-surface px-2.5 text-[11.5px] font-bold text-rose-700 transition-colors hover:border-rose-500/40 dark:text-rose-300"
            >
              <Trash2 className="size-3.5" />
              Supprimer
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  icon,
  label,
  hint,
  children,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-row flex w-full items-center gap-3 px-3.5 py-3 transition-colors hover:bg-surface-2/70"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-soft">{icon}</span>
      <span className="min-w-0 flex-1 text-left leading-tight">
        <span className="block text-[12.5px] font-bold text-ink">{label}</span>
        <span className="block text-[12px] font-medium text-ink-muted">{hint}</span>
      </span>
      {children}
    </button>
  );
}
