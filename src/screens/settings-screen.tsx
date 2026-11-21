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
import {
  LLM_PROVIDERS,
  OPENAI_ENDPOINT,
  llmModels,
  llmProbe,
  llmReady,
  providerOf,
  type LlmProvider,
} from "@/lib/llm";
import {
  DECISION_PROVIDERS,
  THRESHOLD_PRESETS,
  applyDecisionProvider,
  decisionProbeDirect,
  decisionProviderPreset,
  decisionReady,
  detectThresholdPreset,
  type DecisionAuthHeader,
  type DecisionConfig,
  type DecisionProtocol,
  type DecisionProvider,
  type NotifFilterMode,
  type ThresholdPresetId,
} from "@/lib/decision";
import { toApiDecisionConfig } from "@/lib/triage";
import { CategoryManagerSheet, categoryColorStyle } from "@/components/category-manager-sheet";
import { mailApi } from "@/lib/api";
import { DEFAULT_COPILOT_CLIENT_ID, copilotModels, useCopilotSession } from "@/lib/copilot";
import { openExternal } from "@/lib/open-external";
import { formatTokens, lastDays, resetAiStats, topModels } from "@/lib/ai-stats";
import { useAiUsage } from "@/lib/ai-sync";
import {
  SWIPE_ACTIONS,
  CALENDAR_LEAD_MINUTES,
  CONTACTS_PENDING,
  THREAD_VIEWS,
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
import {
  EMPTY_TEAM_CONTEXT,
  TEAM_MEMBERS_MAX,
  teamContextOf,
  type AccountTeamContext,
  type TeamMember,
} from "@/lib/team";
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
import { useBackLayer } from "@/lib/back";

type LlmField = "endpoint" | "model" | "apiKey" | "copilotClientId";

const LLM_FIELDS: { key: LlmField; label: string; aria: string; placeholder: string; password?: boolean }[] = [
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

type GroupId =
  | "comptes"
  | "moi-equipe"
  | "apparence"
  | "synchronisation"
  | "securite"
  | "ia"
  | "mcp"
  | "application";

const GROUPS: { id: GroupId; label: string; hint: string; icon: typeof Sun }[] = [
  { id: "comptes", label: "Comptes", hint: "Boîtes mail, signatures, dossiers", icon: Users },
  { id: "moi-equipe", label: "Moi et mon équipe", hint: "Identité, rôle, équipe par boîte", icon: Users },
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
  const {
    accounts,
    mode,
    readOnly,
    openConnect,
    askRemoveAccount,
    folderOptions,
    hiddenFolderOptions,
    hideFolder,
    unhideFolder,
    deleteFolder,
    account: currentAccount,
    triageMails,
  } = useMailStore();
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
    decision,
    setDecision,
    aiReplyEnabled,
    setAiReplyEnabled,
    summary,
    setSummary,
    aiTasks,
    setAiTasks,
    perimeters,
    setAccountPerimeter,
    teamContext,
    setTeamContext,
    threadView,
    setThreadView,
  } = usePrefs();
  const [openGroup, setOpenGroup] = useState<GroupId | null>(null);
  const [teamAccount, setTeamAccount] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewMode>("unlocked");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null);
  const [decisionProbing, setDecisionProbing] = useState(false);
  const [decisionProbeState, setDecisionProbeState] = useState<{ ok: boolean; text: string } | null>(null);
  const [thresholdsOpen, setThresholdsOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const copilot = useCopilotSession(llm.copilotClientId);
  const copilotProvider = providerOf(llm) === "copilot";
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
  const teamTarget =
    accounts.find((entry) => entry.id === teamAccount) ??
    accounts.find((entry) => entry.id === account) ??
    accounts[0] ??
    null;
  const team = teamTarget ? teamContextOf({ teamContext }, teamTarget.id) : EMPTY_TEAM_CONTEXT;
  const updateTeam = (patch: Partial<AccountTeamContext>) => {
    if (!teamTarget) return;
    setTeamContext(teamTarget.id, { ...team, ...patch });
  };
  const patchMember = (index: number, patch: Partial<TeamMember>) =>
    updateTeam({
      members: team.members.map((member, position) =>
        position === index ? { ...member, ...patch } : member,
      ),
    });
  const addMember = () => updateTeam({ members: [...team.members, { name: "", scope: "" }] });
  const removeMember = (index: number) =>
    updateTeam({ members: team.members.filter((_, position) => position !== index) });
  const group = groups.find((entry) => entry.id === openGroup) ?? null;
  const enabled = mergeFlags(
    Object.fromEntries(MCP_SERVERS.map((server) => [server.id, server.status === "connected"])),
    mcpEnabled,
  );
  const mcp = mcpCounts((server) => enabled[server.id]);
  const mod = detectModKey();
  const shortcuts = shortcutCatalog();
  const customFolders = [
    ...folderOptions.filter((entry) => entry.id === "other").map((entry) => ({ entry, hidden: false })),
    ...hiddenFolderOptions.map((entry) => ({ entry, hidden: true })),
  ];
  const canHideFolders = currentAccount !== ALL_ACCOUNTS;
  const updater = useUpdater();
  const updateState = phaseLabel(updater.phase);
  const installedVersion = updater.current ?? APP_VERSION;

  const showGroup = (id: GroupId | null) => {
    setOpenGroup(id);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  useBackLayer(openGroup !== null, () => showGroup(null));

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

  const updateLlm = (key: LlmField, value: string) => {
    setProbe(null);
    if (key !== "model") {
      setModels([]);
      setModelsError(null);
    }
    setLlm({ ...llm, [key]: value });
  };

  const pickProvider = (provider: LlmProvider) => {
    setProbe(null);
    setModels([]);
    setModelsError(null);
    if (provider === "openai" && !llm.endpoint.trim()) {
      setLlm({ ...llm, provider, endpoint: OPENAI_ENDPOINT });
      return;
    }
    setLlm({ ...llm, provider });
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

  useEffect(() => {
    if (copilotProvider && copilot.connected) void loadModels();
  }, [copilot.connected, copilotProvider]);

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

  const pushDecisionDaemon = (next: DecisionConfig, apiKeyOverride?: string, clearApiKey = false) => {
    if (mode !== "api") return;
    void mailApi
      .saveDecisionConfig(
        toApiDecisionConfig(next, { apiKey: apiKeyOverride, clearApiKey }),
      )
      .then((saved) => {
        setDecision({
          daemonHasKey: saved.has_api_key,
          ...(saved.has_api_key && apiKeyOverride ? { apiKey: "" } : {}),
        });
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    if (mode !== "api" || openGroup !== "ia") return;
    let alive = true;
    void mailApi
      .decisionConfig()
      .then((remote) => {
        if (!alive) return;
        setDecision({ daemonHasKey: remote.has_api_key });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [mode, openGroup, setDecision]);

  const updateDecision = (patch: Partial<DecisionConfig>) => {
    setDecisionProbeState(null);
    const next = { ...decision, ...patch };
    setDecision(patch);
    const keyChanged = typeof patch.apiKey === "string" && patch.apiKey.trim() !== "";
    pushDecisionDaemon(next, keyChanged ? patch.apiKey : undefined);
  };

  const pickDecisionProvider = (provider: DecisionProvider) => {
    setDecisionProbeState(null);
    const next = applyDecisionProvider(decision, provider);
    setDecision(next);
    pushDecisionDaemon(next);
  };

  const applyThresholdPreset = (preset: ThresholdPresetId) => {
    const next = { ...decision, thresholds: { ...THRESHOLD_PRESETS[preset].values } };
    setDecision({ thresholds: next.thresholds });
    pushDecisionDaemon(next);
  };

  const runDecisionProbe = async () => {
    setDecisionProbing(true);
    setDecisionProbeState(null);
    try {
      const reply =
        mode === "api"
          ? await mailApi.decisionProbe({
              provider: decision.provider,
              protocol: decision.protocol,
              endpoint: decision.endpoint,
              model: decision.model,
              auth_header: decision.authHeader,
              ...(decision.apiKey.trim() ? { api_key: decision.apiKey.trim() } : {}),
            })
          : await decisionProbeDirect(decision);
      const latency = "latency_ms" in reply ? reply.latency_ms : reply.latencyMs;
      const energy =
        "energy" in reply && reply.energy
          ? "energy_joules" in reply.energy
            ? reply.energy.energy_joules
            : reply.energy.energyJoules
          : undefined;
      const energySuffix = typeof energy === "number" && energy > 0 ? ` · ${energy.toFixed(1)} J` : "";
      setDecisionProbeState({
        ok: true,
        text: `${reply.model} · ${latency} ms${energySuffix}`,
      });
    } catch (failure) {
      setDecisionProbeState({
        ok: false,
        text: failure instanceof Error ? failure.message : "échec inconnu",
      });
    } finally {
      setDecisionProbing(false);
    }
  };

  const decisionPreset = decisionProviderPreset(decision.provider);
  const activeThresholdPreset = detectThresholdPreset(decision.thresholds);
  const decisionAvgLatency =
    aiUsage.combined.decision.calls > 0
      ? Math.round(aiUsage.combined.decision.totalLatencyMs / aiUsage.combined.decision.calls)
      : 0;

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
                  {customFolders.map(({ entry, hidden }) => (
                    <div key={entry.path} className="px-1.5 py-1">
                      <FolderRow
                        label={entry.label}
                        variant="mobile"
                        onDelete={() => void deleteFolder(entry.path, entry.label)}
                        onHide={
                          canHideFolders && !hidden ? () => hideFolder(entry.path) : undefined
                        }
                        onUnhide={
                          canHideFolders && hidden ? () => unhideFolder(entry.path) : undefined
                        }
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
                          {hidden ? (
                            <span className="shrink-0 rounded-lg bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-ink-muted uppercase">
                              masqué
                            </span>
                          ) : null}
                        </div>
                      </FolderRow>
                    </div>
                  ))}
                </Card>
                <p className="mt-2 px-5 text-[12px] leading-relaxed font-medium text-ink-muted">
                  Masquer un dossier le retire de la liste sans rien effacer sur le serveur ; le
                  réafficher le remet. Le supprimer l'efface sur le serveur IMAP, avec les messages
                  qu'il contient.
                </p>
              </BlurFade>
            </>
          ) : null}
        </>
      ) : null}

      {openGroup === "moi-equipe" ? (
        <>
          <SectionTitle hint="par boîte">Moi et mon équipe</SectionTitle>
          <BlurFade delay={0.08}>
            <div role="group" aria-label="Boîte de la fiche" className="mx-5 flex gap-1.5 overflow-x-auto pb-1">
              {accounts.map((item) => {
                const selected = teamTarget?.id === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setTeamAccount(item.id)}
                    className={cn(
                      "focus-ring inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11.5px] font-bold transition-colors",
                      selected
                        ? "bg-accent text-accent-contrast"
                        : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
                    )}
                  >
                    <span className="size-2 rounded-full" style={{ backgroundColor: item.color }} />
                    {item.label}
                  </button>
                );
              })}
            </div>
            {teamTarget ? (
              <Card className="mx-5 mt-3 space-y-3 p-3.5">
                <label className="block">
                  <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                    Votre nom
                  </span>
                  <input
                    aria-label="Votre nom"
                    type="text"
                    autoComplete="off"
                    placeholder="Roman FELDEN"
                    value={team.identity}
                    onChange={(event) => updateTeam({ identity: event.target.value })}
                    className="focus-ring mt-1.5 h-11 w-full rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink placeholder:font-medium placeholder:text-ink-muted"
                  />
                </label>
                <label className="block">
                  <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                    Votre rôle
                  </span>
                  <input
                    aria-label="Votre rôle"
                    type="text"
                    autoComplete="off"
                    placeholder="DSI"
                    value={team.role}
                    onChange={(event) => updateTeam({ role: event.target.value })}
                    className="focus-ring mt-1.5 h-11 w-full rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink placeholder:font-medium placeholder:text-ink-muted"
                  />
                </label>
                <label className="block">
                  <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                    Contexte de la boîte
                  </span>
                  <textarea
                    aria-label="Contexte de la boîte"
                    rows={3}
                    placeholder="Je suis Roman FELDEN, DSI de l'ENSAG…"
                    value={team.context}
                    onChange={(event) => updateTeam({ context: event.target.value })}
                    className="focus-ring mt-1.5 w-full resize-none rounded-xl border border-line bg-surface px-3 py-2.5 text-[13px] leading-relaxed font-medium text-ink placeholder:font-medium placeholder:text-ink-muted"
                  />
                </label>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                      Équipe
                    </span>
                    <button
                      type="button"
                      disabled={team.members.length >= TEAM_MEMBERS_MAX}
                      onClick={addMember}
                      className="focus-ring inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[11.5px] font-bold text-ink-soft transition-colors disabled:opacity-40"
                    >
                      <Plus className="size-3.5" />
                      Ajouter un membre
                    </button>
                  </div>
                  {team.members.map((member, index) => (
                    <div key={index} className="flex items-center gap-1.5">
                      <input
                        aria-label={`Nom du membre ${index + 1}`}
                        type="text"
                        autoComplete="off"
                        placeholder="Camille"
                        value={member.name}
                        onChange={(event) => patchMember(index, { name: event.target.value })}
                        className="focus-ring h-11 min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink placeholder:font-medium placeholder:text-ink-muted"
                      />
                      <input
                        aria-label={`Périmètre du membre ${index + 1}`}
                        type="text"
                        autoComplete="off"
                        placeholder="Ateliers, planning"
                        value={member.scope}
                        onChange={(event) => patchMember(index, { scope: event.target.value })}
                        className="focus-ring h-11 min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink placeholder:font-medium placeholder:text-ink-muted"
                      />
                      <button
                        type="button"
                        aria-label={`Retirer le membre ${index + 1}`}
                        onClick={() => removeMember(index)}
                        className="focus-ring grid size-11 shrink-0 place-items-center rounded-full text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <p className="text-[12px] leading-relaxed font-medium text-ink-muted">
                  {`Chaque boîte garde sa propre fiche · ${TEAM_MEMBERS_MAX} membres au plus.`}
                </p>
              </Card>
            ) : (
              <Card className="mx-5 mt-3 p-3.5">
                <p className="text-[12px] font-medium text-ink-muted">
                  Aucun compte : la fiche se remplit après la connexion d'une boîte.
                </p>
              </Card>
            )}
            <p className="mt-2 px-5 text-[12px] leading-relaxed font-medium text-ink-muted">
              L'assistant reçoit cette fiche comme contexte fiable, en dehors des mails.
            </p>
          </BlurFade>
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

          <BlurFade delay={0.18}>
            <Card className="mx-5 mt-3 p-3.5">
              <p className="text-[12.5px] font-bold text-ink">Affichage des conversations</p>
              <p className="text-[10.5px] font-medium text-ink-muted">
                Dans la rédaction d'un brouillon ou d'une réponse
              </p>
              <div className="mt-2.5 flex gap-1.5">
                {THREAD_VIEWS.map((option) => {
                  const selected = threadView === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setThreadView(option.id)}
                      className={cn(
                        "focus-ring min-h-11 flex-1 rounded-xl px-1 text-[11.5px] font-bold transition-colors",
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
                {THREAD_VIEWS.find((option) => option.id === threadView)?.hint}
              </p>
            </Card>
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
          <SectionTitle hint={decisionReady(decision) ? "actif · rapide" : "inactif"}>
            Modèle de décision · Système 1
          </SectionTitle>
          <BlurFade delay={0.05}>
            <Card className="mx-5 space-y-3 p-3.5">
              <p className="text-[12px] leading-relaxed font-medium text-ink-muted">
                Triage ultra-rapide, catégories, détection TOTP, sécurité anti-phishing et filtrage avant
                LLM. Sans modèle de décision, les modes intelligents automatiques sont désactivés ; seules
                la réécriture, la correction et l'analyse manuelle LLM restent actives.
              </p>
              <ToggleRow
                icon={<Sparkles className="size-4" />}
                label="Activer le modèle de décision"
                hint={
                  decisionReady(decision)
                    ? `${decision.model} · triage et filtres actifs`
                    : "Configure un endpoint (ex. NeuralWatt mammoth-1)"
                }
                checked={decision.enabled}
                onChange={(value) => updateDecision({ enabled: value })}
              />
              <div role="group" aria-label="Fournisseur du modèle de décision" className="flex flex-wrap gap-1.5">
                {DECISION_PROVIDERS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    aria-pressed={decision.provider === entry.id}
                    onClick={() => pickDecisionProvider(entry.id)}
                    className={cn(
                      "focus-ring min-h-9 rounded-full border px-3 text-[12px] font-bold transition-colors",
                      decision.provider === entry.id
                        ? "border-accent bg-accent-soft text-accent-ink"
                        : "border-line bg-surface text-ink-soft",
                    )}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
              <label className="block">
                <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                  Endpoint décision
                </span>
                <input
                  aria-label="Endpoint du modèle de décision"
                  type="text"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="https://api.neuralwatt.com/v1/systemone"
                  value={decision.endpoint}
                  onChange={(event) => updateDecision({ endpoint: event.target.value })}
                  className="focus-ring mt-1.5 h-11 w-full rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink placeholder:font-medium placeholder:text-ink-muted"
                />
              </label>
              <label className="block">
                <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                  Modèle décision
                </span>
                <input
                  aria-label="Nom du modèle de décision"
                  type="text"
                  list="decision-models"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="mammoth-1"
                  value={decision.model}
                  onChange={(event) => updateDecision({ model: event.target.value })}
                  className="focus-ring mt-1.5 h-11 w-full rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink placeholder:font-medium placeholder:text-ink-muted"
                />
                <datalist id="decision-models">
                  {decisionPreset.models.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              </label>
              {decision.provider === "custom" ? (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                      Protocole
                    </span>
                    <div className="mt-1.5 flex gap-1">
                      {(["systemone", "jev"] as DecisionProtocol[]).map((proto) => (
                        <button
                          key={proto}
                          type="button"
                          aria-pressed={decision.protocol === proto}
                          onClick={() => updateDecision({ protocol: proto })}
                          className={cn(
                            "focus-ring min-h-9 flex-1 rounded-xl border px-2 text-[11.5px] font-bold",
                            decision.protocol === proto
                              ? "border-accent bg-accent-soft text-accent-ink"
                              : "border-line bg-surface text-ink-soft",
                          )}
                        >
                          {proto === "systemone" ? "SystemOne" : "Jev"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                      En-tête Auth
                    </span>
                    <div className="mt-1.5 flex gap-1">
                      {(
                        [
                          { id: "bearer", label: "Bearer" },
                          { id: "api_key", label: "Api-Key" },
                          { id: "none", label: "Aucune" },
                        ] as { id: DecisionAuthHeader; label: string }[]
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          aria-pressed={decision.authHeader === opt.id}
                          onClick={() => updateDecision({ authHeader: opt.id })}
                          className={cn(
                            "focus-ring min-h-9 flex-1 rounded-xl border px-1.5 text-[11px] font-bold",
                            decision.authHeader === opt.id
                              ? "border-accent bg-accent-soft text-accent-ink"
                              : "border-line bg-surface text-ink-soft",
                          )}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
              {decision.authHeader !== "none" ? (
                <label className="block">
                  <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                    {decision.daemonHasKey ? "Clé API décision (enregistrée au trousseau)" : "Clé API décision"}
                  </span>
                  <input
                    aria-label="Clé API du modèle de décision"
                    type="password"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder={decision.daemonHasKey ? "•••••••• (remplacer la clé)" : "nw-…"}
                    value={decision.apiKey}
                    onChange={(event) => updateDecision({ apiKey: event.target.value })}
                    className="focus-ring mt-1.5 h-11 w-full rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink placeholder:font-medium placeholder:text-ink-muted"
                  />
                </label>
              ) : null}
              <button
                type="button"
                disabled={!decisionReady({ ...decision, enabled: true }) || decisionProbing}
                onClick={() => void runDecisionProbe()}
                className="focus-ring min-h-11 w-full rounded-full bg-accent px-4 text-[12.5px] font-bold text-accent-contrast transition-opacity disabled:opacity-40"
              >
                {decisionProbing ? "Test en cours…" : "Tester le modèle de décision"}
              </button>
              {decisionProbeState ? (
                <p
                  className={cn(
                    "rounded-2xl px-3 py-2 text-[12px] leading-relaxed font-semibold break-words",
                    decisionProbeState.ok
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "bg-rose-500/10 text-rose-600 dark:text-rose-300",
                  )}
                >
                  {decisionProbeState.ok
                    ? `Modèle de décision · ${decisionProbeState.text}`
                    : `Échec décision · ${decisionProbeState.text}`}
                </p>
              ) : null}
              <div className="space-y-2 border-t border-line/70 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                    Seuils de confiance
                  </span>
                  <button
                    type="button"
                    onClick={() => setThresholdsOpen((open) => !open)}
                    className="focus-ring rounded-full border border-line px-2.5 py-1 text-[11px] font-bold text-ink-soft"
                  >
                    {thresholdsOpen ? "Masquer le détail" : "Ajuster"}
                  </button>
                </div>
                <div role="group" aria-label="Profil de seuils de décision" className="flex flex-wrap gap-1.5">
                  {(["prudent", "balanced", "strict"] as ThresholdPresetId[]).map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      aria-pressed={activeThresholdPreset === preset}
                      onClick={() => applyThresholdPreset(preset)}
                      className={cn(
                        "focus-ring min-h-9 rounded-full border px-3 text-[12px] font-bold transition-colors",
                        activeThresholdPreset === preset
                          ? "border-accent bg-accent-soft text-accent-ink"
                          : "border-line bg-surface text-ink-soft",
                      )}
                    >
                      {THRESHOLD_PRESETS[preset].label}
                    </button>
                  ))}
                  {activeThresholdPreset === "custom" ? (
                    <span className="inline-flex min-h-9 items-center rounded-full border border-accent/40 bg-accent-soft/50 px-3 text-[11.5px] font-bold text-accent-ink">
                      Personnalisé
                    </span>
                  ) : null}
                </div>
                {thresholdsOpen ? (
                  <div className="space-y-2.5 rounded-2xl bg-surface-2/60 p-3">
                    {(
                      [
                        { key: "llmEscalate", label: "Escalade vers le LLM", min: 0.2, max: 0.9 },
                        { key: "category", label: "Catégories & badges", min: 0.3, max: 0.95 },
                        { key: "security", label: "Bouclier sécurité", min: 0.5, max: 0.98 },
                        { key: "folder", label: "Suggestion de dossier", min: 0.5, max: 0.98 },
                      ] as const
                    ).map((slider) => (
                      <label key={slider.key} className="block space-y-1">
                        <div className="flex items-center justify-between text-[11.5px] font-semibold text-ink-soft">
                          <span>{slider.label}</span>
                          <span className="font-mono text-ink">
                            {`${Math.round(decision.thresholds[slider.key] * 100)} %`}
                          </span>
                        </div>
                        <input
                          aria-label={slider.label}
                          type="range"
                          min={slider.min}
                          max={slider.max}
                          step={0.05}
                          value={decision.thresholds[slider.key]}
                          onChange={(event) =>
                            updateDecision({
                              thresholds: {
                                ...decision.thresholds,
                                [slider.key]: Number(event.target.value),
                              },
                            })
                          }
                          className="w-full accent-[var(--accent)]"
                        />
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="space-y-1.5 border-t border-line/70 pt-3">
                <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                  Vue par défaut de la boîte
                </span>
                <div role="group" aria-label="Vue par défaut de la boîte" className="flex flex-wrap gap-1.5">
                  {[
                    { id: "all", label: "Tous" },
                    { id: "priority", label: "Prioritaire" },
                    { id: "needs_reply", label: "À répondre" },
                    ...decision.customCategories.map((cat) => ({
                      id: `custom:${cat.id}`,
                      label: cat.name,
                    })),
                  ].map((view) => (
                    <button
                      key={view.id}
                      type="button"
                      aria-pressed={decision.defaultInboxFilter === view.id}
                      onClick={() => updateDecision({ defaultInboxFilter: view.id })}
                      className={cn(
                        "focus-ring min-h-9 rounded-full border px-3 text-[12px] font-bold transition-colors",
                        decision.defaultInboxFilter === view.id
                          ? "border-accent bg-accent-soft text-accent-ink"
                          : "border-line bg-surface text-ink-soft",
                      )}
                    >
                      {view.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5 border-t border-line/70 pt-3">
                <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                  Filtrage des notifications
                </span>
                <div role="group" aria-label="Filtrage des notifications" className="flex flex-wrap gap-1.5">
                  {(
                    [
                      { id: "all", label: "Toutes" },
                      { id: "smart", label: "Intelligentes" },
                      { id: "urgent_only", label: "Urgentes & TOTP" },
                    ] as { id: NotifFilterMode; label: string }[]
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      aria-pressed={decision.notifMode === opt.id}
                      onClick={() => updateDecision({ notifMode: opt.id })}
                      className={cn(
                        "focus-ring min-h-9 rounded-full border px-3 text-[12px] font-bold transition-colors",
                        decision.notifMode === opt.id
                          ? "border-accent bg-accent-soft text-accent-ink"
                          : "border-line bg-surface text-ink-soft",
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="divide-y divide-line/70 overflow-hidden rounded-2xl border border-line">
                <ToggleRow
                  icon={<KeyRound className="size-4" />}
                  label="Popup TOTP instantané"
                  hint="Affiche les codes de vérification dès réception pour les copier en un clic"
                  checked={decision.totpPopup}
                  onChange={(value) => updateDecision({ totpPopup: value })}
                />
                <ToggleRow
                  icon={<Lock className="size-4" />}
                  label="Garde-fou avant envoi (Pre-send Guard)"
                  hint="Vérifie pièce jointe oubliée, question sans réponse et secrets en clair"
                  checked={decision.preSendGuard}
                  onChange={(value) => updateDecision({ preSendGuard: value })}
                />
              </div>
              <div className="space-y-2 border-t border-line/70 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                    Catégories personnalisées
                  </span>
                  <span className="text-[11px] font-semibold text-ink-muted">
                    {decision.customCategories.length} / 8
                  </span>
                </div>
                {decision.customCategories.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {decision.customCategories.map((cat) => {
                      const style = categoryColorStyle(cat.color);
                      return (
                        <span
                          key={cat.id}
                          className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold", style.pill)}
                        >
                          <span className={cn("size-2 rounded-full", style.dot)} />
                          {cat.name}
                        </span>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-[11.5px] font-medium text-ink-muted">
                    Aucune catégorie personnalisée · ajoute Factures, Colis, Banque…
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => setCategoriesOpen(true)}
                  className="focus-ring min-h-10 w-full rounded-full border border-line bg-surface px-4 text-[12px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
                >
                  Gérer les catégories personnalisées
                </button>
              </div>
            </Card>
          </BlurFade>

          <SectionTitle hint={llmReady(llm) ? "modèle configuré" : "local"}>
            Intelligence artificielle
          </SectionTitle>
          <BlurFade delay={0.08}>
            <Card className="mx-5 space-y-3 p-3.5">
              <p className="text-[12px] leading-relaxed font-medium text-ink-muted">
                {copilotProvider
                  ? "GitHub Copilot répond par le démon, qui garde les jetons : connecte ton compte GitHub, puis choisis un modèle."
                  : "Branche un modèle compatible OpenAI pour les suggestions de réponse, la réécriture et les résumés. Sans configuration, Lavande propose des réponses locales."}
              </p>
              <div role="group" aria-label="Fournisseur du modèle IA" className="flex flex-wrap gap-1.5">
                {LLM_PROVIDERS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    aria-pressed={providerOf(llm) === entry.id}
                    onClick={() => pickProvider(entry.id)}
                    className={cn(
                      "focus-ring min-h-9 rounded-full border px-3 text-[12px] font-bold transition-colors",
                      providerOf(llm) === entry.id
                        ? "border-accent bg-accent-soft text-accent-ink"
                        : "border-line bg-surface text-ink-soft",
                    )}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
              {copilotProvider ? (
                <div className="space-y-3">
                  <div className="rounded-2xl border border-line bg-surface-2/60 p-3">
                    {copilot.connected ? (
                      <div className="space-y-2">
                        <p className="text-[12.5px] font-semibold text-ink">
                          {`Connecté · ${copilot.login ?? "GitHub"}`}
                        </p>
                        <button
                          type="button"
                          disabled={copilot.busy}
                          onClick={() => copilot.disconnect()}
                          className="focus-ring min-h-11 w-full rounded-full border border-line bg-surface px-4 text-[12.5px] font-bold text-ink-soft disabled:opacity-40"
                        >
                          Se déconnecter
                        </button>
                      </div>
                    ) : copilot.userCode ? (
                      <div className="space-y-2">
                        <p className="text-[12px] font-semibold text-ink-soft">
                          Recopie ce code sur la page GitHub ouverte :
                        </p>
                        <p className="text-center font-mono text-[22px] font-bold tracking-[0.18em] text-ink">
                          {copilot.userCode}
                        </p>
                        <button
                          type="button"
                          onClick={() => copilot.verificationUri && openExternal(copilot.verificationUri)}
                          className="focus-ring min-h-11 w-full rounded-full border border-line bg-surface px-4 text-[12.5px] font-bold text-ink-soft"
                        >
                          Ouvrir la page GitHub
                        </button>
                        <p className="text-center text-[11.5px] font-semibold text-ink-muted">
                          en attente de validation…
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-[12px] font-semibold text-ink-soft">
                          Aucun compte GitHub connecté.
                        </p>
                        <button
                          type="button"
                          disabled={copilot.busy}
                          onClick={() => copilot.connect()}
                          className="focus-ring min-h-11 w-full rounded-full bg-accent px-4 text-[12.5px] font-bold text-accent-contrast disabled:opacity-40"
                        >
                          {copilot.busy ? "Connexion…" : "Se connecter à GitHub"}
                        </button>
                      </div>
                    )}
                    {copilot.error ? (
                      <p className="mt-2 rounded-2xl bg-rose-500/10 px-3 py-2 text-[12px] leading-relaxed font-semibold break-words text-rose-600 dark:text-rose-300">
                        {copilot.error}
                      </p>
                    ) : null}
                  </div>
                  <label className="block">
                    <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                      Modèle
                    </span>
                    <input
                      aria-label="Nom du modèle"
                      list="copilot-models"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="gpt-4o"
                      value={llm.model}
                      onChange={(event) => updateLlm("model", event.target.value)}
                      className="focus-ring mt-1.5 h-11 w-full rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink placeholder:font-medium placeholder:text-ink-muted"
                    />
                    <datalist id="copilot-models">
                      {(models.length > 0 ? models : copilotModels()).map((model) => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                  </label>
                  <label className="block">
                    <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                      Client ID GitHub Copilot
                    </span>
                    <input
                      aria-label="Client ID GitHub Copilot"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder={DEFAULT_COPILOT_CLIENT_ID}
                      value={llm.copilotClientId ?? ""}
                      onChange={(event) => updateLlm("copilotClientId", event.target.value)}
                      className="focus-ring mt-1.5 h-11 w-full rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink placeholder:font-medium placeholder:text-ink-muted"
                    />
                    <span className="mt-1 block text-[11px] font-medium text-ink-muted">
                      Vide · l'application Copilot par défaut est utilisée.
                    </span>
                  </label>
                </div>
              ) : (
                <>
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
                </>
              )}
              <button
                type="button"
                disabled={!llmReady(llm) || probing}
                onClick={() => void runProbe()}
                className="focus-ring min-h-11 w-full rounded-full bg-accent px-4 text-[12.5px] font-bold text-accent-contrast transition-opacity disabled:opacity-40"
              >
                {probing ? "Test en cours…" : "Tester la connexion"}
              </button>
              {copilotProvider ? null : (
                <button
                  type="button"
                  disabled={!llm.endpoint.trim() || !llm.apiKey.trim() || loadingModels}
                  onClick={() => void loadModels()}
                  className="focus-ring min-h-11 w-full rounded-full border border-line bg-surface px-4 text-[12.5px] font-bold text-ink-soft transition-colors disabled:opacity-40"
                >
                  {loadingModels ? "Chargement…" : "Charger les modèles"}
                </button>
              )}
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
                  {probe.ok
                    ? copilotProvider
                      ? probe.text
                      : `Réponse du modèle · ${probe.text}`
                    : `Échec · ${probe.text}`}
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
                  <dt className="text-[10px] font-bold tracking-[0.1em] text-ink-muted uppercase">Appels LLM</dt>
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
              <dl className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-accent-soft/45 px-2 py-2">
                  <dt className="text-[10px] font-bold tracking-[0.1em] text-accent-ink uppercase">Décisions</dt>
                  <dd className="text-[15px] font-extrabold text-ink">
                    {formatTokens(aiUsage.combined.decision.calls)}
                  </dd>
                </div>
                <div className="rounded-xl bg-accent-soft/45 px-2 py-2">
                  <dt className="text-[10px] font-bold tracking-[0.1em] text-accent-ink uppercase">LLM évités</dt>
                  <dd className="text-[15px] font-extrabold text-ink">
                    {formatTokens(aiUsage.combined.decision.llmSaved)}
                  </dd>
                </div>
                <div className="rounded-xl bg-accent-soft/45 px-2 py-2">
                  <dt className="text-[10px] font-bold tracking-[0.1em] text-accent-ink uppercase">
                    {aiUsage.combined.decision.energyJoules > 0 ? "Énergie" : "Latence"}
                  </dt>
                  <dd className="text-[15px] font-extrabold text-ink">
                    {aiUsage.combined.decision.energyJoules > 0
                      ? `${aiUsage.combined.decision.energyJoules.toFixed(0)} J`
                      : `${decisionAvgLatency} ms`}
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

      <CategoryManagerSheet
        open={categoriesOpen}
        onClose={() => setCategoriesOpen(false)}
        onRetriage={() => triageMails(mails, true)}
      />
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
  const [caldavAccount, setCaldavAccount] = useState("");
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

  const addAccountCalendar = async () => {
    const account = sources.accounts.find((entry) => entry.id === caldavAccount);
    if (!account) return;
    if (await sources.addCaldavFromAccount(account, { name: draftName, tone: draftTone })) {
      setDraftName("");
      setCaldavAccount("");
    }
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
                {sources.accounts.length > 0 ? (
                  <div className="grid gap-2 rounded-2xl bg-surface-2/60 p-2.5">
                    <span className={MOBILE_LABEL}>Agenda d'un compte mail · Zimbra</span>
                    <select
                      aria-label="Compte mail pour l'agenda"
                      value={caldavAccount}
                      onChange={(event) => setCaldavAccount(event.target.value)}
                      className={MOBILE_FIELD}
                    >
                      <option value="">Choisir un compte…</option>
                      {sources.accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.label} — {account.email}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      aria-label="Connecter l'agenda du compte sélectionné"
                      disabled={sources.busy || !caldavAccount}
                      onClick={() => void addAccountCalendar()}
                      className="focus-ring inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full bg-accent text-[12.5px] font-bold text-accent-contrast disabled:opacity-45"
                    >
                      <PlugZap className="size-4" />
                      Connecter l'agenda
                    </button>
                  </div>
                ) : null}
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
              coffre ; ils ne sont jamais rangés ici. L'agenda d'un compte mail (Zimbra) se lit avec le mot de passe
              du compte, sans le ressaisir.
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
