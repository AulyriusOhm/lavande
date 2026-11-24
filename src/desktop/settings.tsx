import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  Blocks,
  CalendarDays,
  Check,
  ChevronDown,
  Download,
  FileText,
  FolderTree,
  Globe,
  Info,
  KeyRound,
  Keyboard,
  Link2,
  ListChecks,
  Loader2,
  Lock,
  Mail,
  Moon,
  Palette,
  PenLine,
  PlugZap,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  Sparkles,
  Sun,
  SunMoon,
  Terminal,
  Trash2,
  Upload,
  Users,
  type LucideIcon,
} from "lucide-react";
import { errorText, mailApi } from "@/lib/api";
import type { ApiAccount, ApiFolder, GoogleCalendar } from "@/lib/api";
import type { Account } from "@/lib/accounts";
import {
  PGP_STATE,
  formatFingerprint,
  formatKeyDate,
  isExpired,
  keyLabel,
  keyState,
  keyUsage,
  shortFingerprint,
  type PgpKey,
} from "@/lib/pgp";
import { exportKey, generateKey, listKeys } from "@/lib/pgp-api";
import {
  MCP_ACTION_TYPES,
  MCP_SCOPES,
  MCP_SERVERS,
  mcpActionType,
  mcpCounts,
  mcpLogClock,
  mcpTypeAllowed,
  useMcpLog,
} from "@/lib/mcp";
import {
  TONE_DOT,
  calendarSourceKind,
  icsUrlOf,
  isCaldavCalendar,
  isExternalCalendar,
  isGoogleCalendar,
  isIcsCalendar,
  type CalendarDef,
} from "@/lib/calendars";
import { useCalendarSources } from "@/lib/ics";
import {
  accountPgp,
  activeSignature,
  CALENDAR_LEAD_MINUTES,
  isFolderHidden,
  MAIL_DENSITIES,
  MAIL_PREVIEWS,
  MAIL_PREVIEW_STYLES,
  mergeFlags,
  UPDATE_INTERVALS,
  updateIntervalLabel,
  perimeterOf,
  THREAD_VIEWS,
  usePrefs,
  type MailPreviewStyle,
} from "@/lib/prefs";
import {
  EMPTY_TEAM_CONTEXT,
  TEAM_MEMBERS_MAX,
  teamContextOf,
  type AccountTeamContext,
  type TeamMember,
} from "@/lib/team";
import { requestNotifications } from "@/lib/notify";
import { APP_VERSION, phaseLabel, useUpdater } from "@/lib/updater";
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
  RECENT_MAILS_MAX,
  RECENT_MAILS_MIN,
  THRESHOLD_PRESETS,
  applyDecisionProvider,
  clampRecentMailCount,
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
import { INBOX_VIEWS, toApiDecisionConfig } from "@/lib/triage";
import { CategoryManagerSheet, categoryColorStyle } from "@/components/category-manager-sheet";
import { AiFoldersPicker } from "@/components/ai-folders-picker";
import { CaldavCollectionPicker } from "@/components/caldav-collection-picker";
import { ContactsSyncRow } from "@/components/contacts-sync-row";
import { ZimbraFiltersPanel } from "@/components/zimbra-filters";
import { ZimbraTagsPanel } from "@/components/zimbra-tags";
import { TrustedWhitelistSection } from "@/components/trusted-whitelist";
import { ImagesAllowedSection } from "@/components/images-allowed";
import { DEFAULT_COPILOT_CLIENT_ID, copilotModels, useCopilotSession } from "@/lib/copilot";
import { openExternal } from "@/lib/open-external";
import { formatTokens, lastDays, resetAiStats, topModels } from "@/lib/ai-stats";
import { useAiUsage } from "@/lib/ai-sync";
import { SUMMARY_MODES, type SummaryConfig } from "@/lib/summary";
import { ACCENT_PRESETS, accentContrast, useTheme, type ThemeMode } from "@/lib/theme";
import { useMailStore } from "@/lib/store";
import { detectModKey } from "@/lib/shortcuts";
import { shortcutCatalog } from "@/lib/app-shortcuts";
import { cn } from "@/lib/utils";
import { Avatar, Switch, ToggleRow } from "@/components/ui/primitives";
import { FolderRow } from "@/components/folder-row";
import { SignatureEditor } from "@/components/signature-editor";
import { SyncSettings } from "@/components/sync-settings";
import { ShortcutList } from "@/components/shortcut-list";
import { BlurFade } from "@/components/ui/blur-fade";
import { NumberTicker } from "@/components/ui/number-ticker";
import {
  Badge,
  DChip,
  DButton,
  PaneTitle,
  SectionLabel,
  Surface,
  TextArea,
  TextInput,
} from "@/desktop/ui";

const KEY_TONE = { valid: "green", expired: "amber", revoked: "rose" } as const;

const SCOPE_TONE = { lecture: "neutral", écriture: "amber", signature: "green" } as const;

const LOG_TONE = { succès: "green", échec: "rose", refusé: "amber" } as const;

const MCP_SECTIONS =
  import.meta.env.VITE_PLATFORM === "android" ? [] : ([{ id: "assistant", label: "Serveurs MCP" }] as const);

const SECTION_GROUPS = [
  {
    id: "comptes",
    label: "Comptes",
    sections: [
      { id: "comptes", label: "Comptes" },
      { id: "signatures", label: "Signatures" },
      { id: "messagerie", label: "Filtres & absence" },
    ],
  },
  {
    id: "moi-equipe",
    label: "Moi et mon équipe",
    sections: [{ id: "moi-equipe", label: "Moi et mon équipe" }],
  },
  {
    id: "apparence",
    label: "Apparence",
    sections: [
      { id: "apparence", label: "Apparence" },
      { id: "modules", label: "Modules" },
    ],
  },
  {
    id: "synchronisation",
    label: "Synchronisation",
    sections: [
      { id: "synchronisation", label: "Synchronisation" },
      { id: "calendriers", label: "Calendriers" },
      { id: "notifications", label: "Notifications" },
    ],
  },
  {
    id: "securite",
    label: "Sécurité",
    sections: [{ id: "securite", label: "Sécurité & PGP" }],
  },
  {
    id: "ia",
    label: "IA",
    sections: [
      { id: "ia", label: "Intelligence artificielle" },
      { id: "resumes", label: "Résumés" },
      { id: "taches-ia", label: "Suggestions de tâches" },
    ],
  },
  { id: "mcp", label: "MCP", sections: MCP_SECTIONS },
  {
    id: "application",
    label: "Application",
    sections: [
      { id: "clavier", label: "Raccourcis clavier" },
      { id: "mise-a-jour", label: "Mise à jour" },
      { id: "apropos", label: "À propos" },
    ],
  },
] as const;

type SectionId = (typeof SECTION_GROUPS)[number]["sections"][number]["id"];

type SectionEntry = { id: SectionId; label: string };

const NAV_GROUPS: readonly { id: string; label: string; sections: readonly SectionEntry[] }[] =
  SECTION_GROUPS.filter((group) => group.sections.length > 0);

const SECTIONS: readonly SectionEntry[] = NAV_GROUPS.flatMap((group) => group.sections);

const SECTION_ICONS: Record<SectionId, LucideIcon> = {
  comptes: Mail,
  signatures: PenLine,
  messagerie: SlidersHorizontal,
  "moi-equipe": Users,
  apparence: Palette,
  modules: Blocks,
  synchronisation: RefreshCw,
  calendriers: CalendarDays,
  notifications: Bell,
  securite: ShieldCheck,
  ia: Sparkles,
  resumes: FileText,
  "taches-ia": ListChecks,
  assistant: PlugZap,
  clavier: Keyboard,
  "mise-a-jour": Download,
  apropos: Info,
};

const SECTION_KEYWORDS: Record<SectionId, string> = {
  comptes: "imap smtp gmail google adresse ajouter boite bal",
  signatures: "signature pied de page editeur",
  messagerie: "filtres absence vacances sieve zimbra dossiers masquer",
  "moi-equipe": "profil identite role equipe collaborateurs",
  apparence: "theme sombre clair accent couleur densite apercu affichage conversations",
  modules: "agenda planif mails widgets activer",
  synchronisation: "sync e2ee chiffrement intervalle arriere-plan contacts",
  calendriers: "caldav google ics agenda calendrier externe",
  notifications: "notification rappel son alerte",
  securite: "pgp cle chiffrement openpgp empreinte confiance images",
  ia: "llm copilot openai modele decision triage providers",
  resumes: "resume digest matin midi soir",
  "taches-ia": "taches suggestions planif",
  assistant: "mcp serveurs outils droits journal",
  clavier: "raccourcis touches keyboard",
  "mise-a-jour": "update version installer mise a jour",
  apropos: "version a propos credits",
};

const ActiveSectionContext = createContext<SectionId>("comptes");

const normalize = (value: string) => value.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

const sectionMatches = (section: SectionEntry, needle: string) =>
  needle === "" || normalize(`${section.label} ${SECTION_KEYWORDS[section.id]}`).includes(needle);

const PREVIEW_EXAMPLES: readonly {
  id: MailPreviewStyle;
  tag: string;
  text: string;
}[] = [
  { id: "signaux", tag: "Signaux", text: "Réponse attendue · Tâche détectée" },
  { id: "phrase", tag: "Description rapide", text: "Avenant signé : confirmer le lancement de la phase 2 lundi." },
];

const anchor = (id: SectionId) => `reglages-${id}`;

const clampHours = (value: string, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(max, Math.max(0, Math.round(parsed)));
};

const clampDays = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(90, Math.max(1, Math.round(parsed)));
};

const clampWindowHours = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 48;
  return Math.min(168, Math.max(1, Math.round(parsed)));
};

type SummaryHourKey = "morningStart" | "middayStart" | "eveningStart";

const hourPatch = (key: SummaryHourKey, value: string): Partial<SummaryConfig> => ({
  [key]: clampHours(value, 23),
});

// Choix des dossiers synchronisés d'un compte : null = tous ceux à rôle connu,
// [] = aucun. Chaque changement est enregistré aussitôt et l'affichage reprend
// la sélection que le service vient de renvoyer.
function AccountFolderPicker({
  account,
  selection,
  onSelection,
  notify,
}: {
  account: Account;
  selection: string[] | null;
  onSelection: (next: string[] | null) => void;
  notify: (message: string) => void;
}) {
  const { deleteFolder } = useMailStore();
  const { hiddenFolders, setFolderHidden } = usePrefs();
  const [folders, setFolders] = useState<ApiFolder[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    mailApi
      .folders(account.id)
      .then((found) => {
        if (!cancelled) setFolders(found);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(errorText(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [account.id]);

  const paths = (folders ?? []).map((folder) => folder.path);
  const checked = selection === null ? paths : selection;
  const enabled = checked.length > 0;

  const save = (next: string[] | null) => {
    setSaving(true);
    setError(null);
    mailApi
      .setSyncFolders(account.id, next)
      .then((summary) => {
        onSelection(summary.synced_folders ?? null);
        notify(`Dossiers synchronisés · ${account.label}`);
      })
      .catch((failure: unknown) => setError(errorText(failure)))
      .finally(() => setSaving(false));
  };

  const togglePath = (path: string) => {
    const next = checked.includes(path)
      ? checked.filter((entry) => entry !== path)
      : [...checked, path];
    save(next.length === paths.length ? null : next);
  };

  const count =
    enabled && checked.length > 1
      ? `${checked.length} dossiers synchronisés`
      : enabled
        ? "1 dossier synchronisé"
        : "aucun dossier synchronisé automatiquement";

  const remove = (folder: ApiFolder) => {
    if (removing) return;
    setRemoving(folder.path);
    deleteFolder(folder.path, folder.name, account.id)
      .then((done) => {
        if (!done) return;
        setFolders((current) => (current ?? []).filter((entry) => entry.path !== folder.path));
        if (selection !== null && selection.includes(folder.path)) {
          onSelection(selection.filter((entry) => entry !== folder.path));
        }
      })
      .finally(() => setRemoving(null));
  };

  return (
    <div className="mt-2 rounded-2xl border border-line bg-surface-2/40 pb-1.5">
      <ToggleRow
        icon={<FolderTree className="size-4" />}
        label="Synchroniser les dossiers"
        hint={count}
        checked={enabled}
        onChange={(value) => save(value ? null : [])}
      />
      {enabled ? (
        <div className="mt-1 max-h-44 overflow-y-auto px-2">
          {folders === null ? (
            <p className="px-1.5 py-1.5 text-[11px] font-semibold text-ink-muted">Dossiers…</p>
          ) : (
            folders.map((folder) => {
              const row = (
                <label className="flex cursor-pointer items-center gap-2 rounded-xl px-1.5 py-1 text-[11.5px] font-semibold text-ink-soft hover:bg-surface-2">
                  <input
                    type="checkbox"
                    aria-label={`Synchroniser ${folder.name}`}
                    className="size-3.5 shrink-0 accent-[var(--accent)]"
                    checked={checked.includes(folder.path)}
                    disabled={saving || removing === folder.path}
                    onChange={() => togglePath(folder.path)}
                  />
                  <span className="truncate">{folder.name}</span>
                  <span className="ml-auto truncate text-[12px] font-medium text-ink-muted">
                    {folder.path}
                  </span>
                </label>
              );
              if (folder.role !== "other") return <div key={folder.path}>{row}</div>;
              const hidden = isFolderHidden(hiddenFolders, account.id, folder.path);
              return (
                <FolderRow
                  key={folder.path}
                  label={folder.name}
                  onDelete={() => remove(folder)}
                  onHide={
                    hidden ? undefined : () => setFolderHidden(account.id, folder.path, true)
                  }
                  onUnhide={
                    hidden ? () => setFolderHidden(account.id, folder.path, false) : undefined
                  }
                >
                  {row}
                </FolderRow>
              );
            })
          )}
        </div>
      ) : null}
      {error ? (
        <p className="px-3.5 pt-1 text-[11.5px] font-semibold text-rose-700 dark:text-rose-300">{error}</p>
      ) : null}
    </div>
  );
}

function usePgpKeys() {
  const [keys, setKeys] = useState<PgpKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    setLoading(true);
    try {
      const next = await listKeys(signal);
      if (!signal?.aborted) setKeys(next);
    } catch (failure) {
      if (signal?.aborted || (failure instanceof DOMException && failure.name === "AbortError")) return;
      setKeys([]);
      setError(errorText(failure));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return { keys, error, loading, load };
}

function TonePicker({
  label,
  value,
  onPick,
}: {
  label: string;
  value: number;
  onPick: (tone: number) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1.5">
      {TONE_DOT.map((dot, index) => (
        <button
          key={dot}
          type="button"
          aria-label={`${label} · ton ${index + 1}`}
          aria-pressed={value === index}
          onClick={() => onPick(index)}
          className={cn(
            "focus-ring grid size-7 place-items-center rounded-full transition-opacity duration-200",
            value === index ? "ring-2 ring-accent-ring" : "opacity-55 hover:opacity-100",
          )}
        >
          <span className={cn("size-4 rounded-full", dot)} />
        </button>
      ))}
    </div>
  );
}

function sourceTone(def: CalendarDef) {
  if (isIcsCalendar(def)) return "sky" as const;
  if (isCaldavCalendar(def)) return "green" as const;
  if (isGoogleCalendar(def)) return "amber" as const;
  return "neutral" as const;
}

function CalendarsSection() {
  const { notify, readOnly, openConnect } = useMailStore();
  const sources = useCalendarSources(notify);
  const { calendars } = sources;
  const [draftName, setDraftName] = useState("");
  const [draftTone, setDraftTone] = useState(0);
  const [draftUrl, setDraftUrl] = useState("");
  const [caldav, setCaldav] = useState({ url: "", username: "", password: "" });
  const [caldavHref, setCaldavHref] = useState("");
  const [caldavAccount, setCaldavAccount] = useState("");
  const [accountHref, setAccountHref] = useState("");
  const [collectionEditing, setCollectionEditing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const addCalendar = () => {
    if (sources.addLocal({ name: draftName, tone: draftTone })) setDraftName("");
  };

  const addIcsFromUrl = async () => {
    if (await sources.subscribeIcs({ url: draftUrl, name: draftName, tone: draftTone })) {
      setDraftName("");
      setDraftUrl("");
    }
  };

  const addIcsFromFile = async (file: File) => {
    if (await sources.importIcsFile({ file, name: draftName, tone: draftTone })) setDraftName("");
  };

  const addCaldav = async () => {
    const added = await sources.addCaldav({
      ...caldav,
      name: draftName,
      tone: draftTone,
      calendarHref: caldavHref,
    });
    if (!added) return;
    setDraftName("");
    setCaldav({ url: "", username: "", password: "" });
    setCaldavHref("");
  };

  const addAccountCalendar = async () => {
    const account = sources.accounts.find((entry) => entry.id === caldavAccount);
    if (!account) return;
    if (
      await sources.addCaldavFromAccount(account, {
        name: draftName,
        tone: draftTone,
        calendarHref: accountHref,
      })
    ) {
      setDraftName("");
      setCaldavAccount("");
      setAccountHref("");
    }
  };

  const addGoogleCalendar = async (account: ApiAccount, calendar: GoogleCalendar) => {
    if (await sources.addGoogle(account, calendar, { name: draftName, tone: draftTone })) setDraftName("");
  };

  const startRename = (id: string, name: string) => {
    setRemoving(null);
    setRenaming(id);
    setRenameValue(name);
  };

  const commitRename = (id: string) => {
    if (sources.rename(id, renameValue)) setRenaming(null);
  };

  const removeCalendar = async (id: string) => {
    if (await sources.remove(id)) setRemoving(null);
  };

  return (
    <Surface className="overflow-hidden">
      <div className="flex flex-wrap items-end gap-3 border-b border-line px-3.5 py-3">
        <label className="grid min-w-[150px] flex-1 gap-1">
          <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Nom</span>
          <TextInput
            aria-label="Nom du nouveau calendrier"
            placeholder="Associatif"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addCalendar();
            }}
            className="h-9 text-[12px] font-semibold"
          />
        </label>
        <div className="grid gap-1">
          <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Ton</span>
          <div className="flex h-9 items-center">
            <TonePicker label="Ton du nouveau calendrier" value={draftTone} onPick={setDraftTone} />
          </div>
        </div>
        <DButton variant="primary" size="sm" onClick={addCalendar}>
          <Plus className="size-3.5" strokeWidth={3} />
          Ajouter
        </DButton>
      </div>

      <div className="flex flex-wrap items-end gap-3 border-b border-line bg-surface-2/40 px-3.5 py-3">
        <label className="grid min-w-[220px] flex-1 gap-1">
          <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
            Abonnement iCalendar · URL
          </span>
          <TextInput
            aria-label="URL du calendrier ICS"
            placeholder="https://exemple.tld/calendrier.ics"
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void addIcsFromUrl();
            }}
            className="h-9 text-[12px] font-semibold"
          />
        </label>
        <DButton variant="soft" size="sm" disabled={sources.busy} onClick={() => void addIcsFromUrl()}>
          <Link2 className="size-3.5" strokeWidth={2.6} />
          Abonner
        </DButton>
        <DButton variant="ghost" size="sm" disabled={sources.busy} onClick={() => fileInput.current?.click()}>
          <Upload className="size-3.5" strokeWidth={2.6} />
          Fichier .ics
        </DButton>
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
            if (file) void addIcsFromFile(file);
          }}
        />
      </div>

      <div className="flex flex-wrap items-end gap-3 border-b border-line bg-surface-2/40 px-3.5 py-3">
        <label className="grid min-w-[200px] flex-1 gap-1">
          <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
            Serveur CalDAV · URL
          </span>
          <TextInput
            aria-label="URL du serveur CalDAV"
            placeholder="https://caldav.exemple.tld/"
            value={caldav.url}
            onChange={(event) => setCaldav((current) => ({ ...current, url: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter") void addCaldav();
            }}
            className="h-9 text-[12px] font-semibold"
          />
        </label>
        <label className="grid min-w-[140px] flex-1 gap-1">
          <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Identifiant</span>
          <TextInput
            aria-label="Identifiant CalDAV"
            placeholder="romain"
            autoComplete="username"
            value={caldav.username}
            onChange={(event) => setCaldav((current) => ({ ...current, username: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter") void addCaldav();
            }}
            className="h-9 text-[12px] font-semibold"
          />
        </label>
        <label className="grid min-w-[140px] flex-1 gap-1">
          <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Mot de passe</span>
          <TextInput
            type="password"
            aria-label="Mot de passe CalDAV"
            autoComplete="new-password"
            value={caldav.password}
            onChange={(event) => setCaldav((current) => ({ ...current, password: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter") void addCaldav();
            }}
            className="h-9 text-[12px] font-semibold"
          />
        </label>
        <DButton variant="soft" size="sm" disabled={sources.busy} onClick={() => void addCaldav()}>
          <PlugZap className="size-3.5" strokeWidth={2.6} />
          Connecter
        </DButton>
      </div>

      <div className="border-b border-line bg-surface-2/40 px-3.5 py-2.5">
        <CaldavCollectionPicker
          load={() => sources.discoverCollections(caldav)}
          href={caldavHref}
          onChoose={setCaldavHref}
          disabled={sources.busy}
          readOnly={readOnly}
        />
        <p className="mt-1 text-[10.5px] font-medium text-ink-muted">
          Facultatif : un calendrier du serveur, ou le chemin de celui d'un collègue. Sans choix, le démon lit
          tous les calendriers découverts.
        </p>
      </div>

      {sources.accounts.length > 0 ? (
        <div className="flex flex-wrap items-end gap-3 border-b border-line bg-surface-2/40 px-3.5 py-3">
          <label className="grid min-w-[220px] flex-1 gap-1">
            <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
              Agenda d'un compte mail · Zimbra
            </span>
            <select
              aria-label="Compte mail pour l'agenda"
              value={caldavAccount}
              onChange={(event) => setCaldavAccount(event.target.value)}
              className="h-9 rounded-lg border border-line bg-surface px-2 text-[12px] font-semibold text-ink"
            >
              <option value="">Choisir un compte…</option>
              {sources.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label} — {account.email}
                </option>
              ))}
            </select>
          </label>
          <DButton
            variant="soft"
            size="sm"
            aria-label="Connecter l'agenda du compte sélectionné"
            disabled={sources.busy || !caldavAccount}
            onClick={() => void addAccountCalendar()}
          >
            <PlugZap className="size-3.5" strokeWidth={2.6} />
            Connecter l'agenda
          </DButton>
          <div className="w-full">
            <CaldavCollectionPicker
              load={() =>
                caldavAccount ? sources.accountCollections(caldavAccount) : Promise.resolve(null)
              }
              href={accountHref}
              onChoose={setAccountHref}
              label="Choisir le calendrier du compte"
              pathLabel="Chemin du calendrier du compte"
              disabled={sources.busy || !caldavAccount}
              readOnly={readOnly}
            />
          </div>
        </div>
      ) : null}

      {sources.googleConnected.length > 0 ? (
        <div className="border-b border-line bg-surface-2/40">
          {sources.googleConnected.map((account) => {
            const list = sources.googleCalendars[account.id] ?? [];
            const error = sources.googleErrors[account.id];
            const busy = sources.googleBusy[account.id] === true;
            return (
              <div key={account.id} className="grid gap-1.5 px-3.5 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                    Compte Google
                  </span>
                  <span className="truncate text-[11.5px] font-bold text-ink">
                    {account.label} · {account.email}
                  </span>
                  <DButton
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    aria-label={`Actualiser les calendriers Google de ${account.email}`}
                    disabled={busy}
                    onClick={() => void sources.loadGoogleCalendars(account.id)}
                  >
                    <RefreshCw className={cn("size-3.5", busy && "animate-spin")} strokeWidth={2.4} />
                    Actualiser
                  </DButton>
                </div>
                {error ? (
                  <p role="alert" className="text-[11px] font-bold text-rose-700 dark:text-rose-300">
                    {error}
                  </p>
                ) : null}
                {!error && list.length === 0 ? (
                  <p className="text-[10.5px] font-semibold text-ink-muted">
                    {busy ? "Lecture des calendriers…" : "Aucun calendrier sur ce compte."}
                  </p>
                ) : null}
                {list.length > 0 ? (
                  <ul className="grid gap-1">
                    {list.map((calendar) => (
                      <li key={calendar.id} className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[11.5px] font-semibold text-ink">
                          {calendar.summary || calendar.id}
                        </span>
                        <span className="truncate text-[10.5px] font-medium text-ink-muted">{calendar.id}</span>
                        {sources.googleAttached(account.id, calendar.id) ? (
                          <span className="ml-auto text-[10.5px] font-semibold text-ink-muted">Dans l'agenda</span>
                        ) : (
                          <DButton
                            variant="soft"
                            size="sm"
                            className="ml-auto"
                            aria-label={`Ajouter le calendrier Google ${calendar.summary || calendar.id}`}
                            onClick={() => void addGoogleCalendar(account, calendar)}
                          >
                            <Plus className="size-3.5" strokeWidth={3} />
                            Ajouter
                          </DButton>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2/40 px-3.5 py-2.5">
          <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Agenda Google</span>
          <span className="min-w-0 flex-1 text-[10.5px] font-semibold text-ink-muted">
            Aucun compte Google connecté : le consentement OAuth ouvre aussi l'agenda.
          </span>
          {readOnly ? null : (
            <DButton variant="ghost" size="sm" aria-label="Connecter un compte Google" onClick={openConnect}>
              <PlugZap className="size-3.5" strokeWidth={2.6} />
              Connecter
            </DButton>
          )}
        </div>
      )}

      <p className="border-b border-line/70 px-3.5 py-2 text-[10.5px] leading-relaxed font-semibold text-ink-muted">
        Le nom et le ton saisis ci-dessus s'appliquent aussi aux sources externes ; sans nom, l'URL, le fichier ou le
        calendrier fait foi. Les identifiants CalDAV partent une seule fois au démon, qui les garde dans son coffre : ils
        ne sont jamais enregistrés ici. Un agenda Google se lit avec le jeton du compte connecté, aucun identifiant ne
        passe par ici ; celui d'un compte mail (Zimbra) avec le mot de passe du compte, sans le ressaisir. Aucun compte
        mail n'est requis pour CalDAV, ICS ou un agenda Google.
      </p>

      {sources.error ? (
        <p role="alert" className="border-b border-rose-500/30 bg-rose-500/10 px-3.5 py-2 text-[11px] font-bold text-rose-700 dark:text-rose-300">
          {sources.error}
        </p>
      ) : null}

      {calendars.length === 0 ? (
        <p className="px-3.5 py-4 text-[11px] font-medium text-ink-muted">
          Aucun calendrier : les événements gardent leur propre ton.
        </p>
      ) : (
        <div className="divide-y divide-line/70">
          {calendars.map((entry) => (
            <div key={entry.id} className="flex flex-wrap items-center gap-2 px-3.5 py-2">
              <span className={cn("size-2 shrink-0 rounded-full", TONE_DOT[entry.tone % TONE_DOT.length])} />
              {renaming === entry.id ? (
                <>
                  <TextInput
                    aria-label={`Nouveau nom pour ${entry.name}`}
                    value={renameValue}
                    autoFocus
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitRename(entry.id);
                      if (event.key === "Escape") setRenaming(null);
                    }}
                    className="h-8 max-w-[220px] text-[11.5px] font-semibold"
                  />
                  <DButton variant="primary" size="sm" onClick={() => commitRename(entry.id)}>
                    <Check className="size-3.5" />
                    Valider
                  </DButton>
                  <DButton variant="plain" size="sm" onClick={() => setRenaming(null)}>
                    Annuler
                  </DButton>
                </>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[12px] font-bold text-ink">{entry.name}</span>
                      <Badge tone={sourceTone(entry)}>{calendarSourceKind(entry)}</Badge>
                      {sources.paused(entry) ? <Badge tone="amber">En pause</Badge> : null}
                    </div>
                    {isExternalCalendar(entry) ? (
                      <span className="mt-0.5 flex items-center gap-1 text-[10.5px] font-semibold text-ink-muted">
                        <Link2 className="size-3 shrink-0" strokeWidth={2.2} />
                        <span className="truncate">{sources.detailOf(entry) ?? "URL inconnue"}</span>
                        <span className="shrink-0 tabular-nums">
                          · {sources.countOf(entry.id)} événement
                          {sources.countOf(entry.id) > 1 ? "s" : ""}
                        </span>
                        {sources.paused(entry) ? (
                          <span className="shrink-0">· agenda du compte coupé</span>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                  <TonePicker
                    label={`Ton de ${entry.name}`}
                    value={entry.tone % TONE_DOT.length}
                    onPick={(tone) => sources.setTone(entry.id, tone)}
                  />
                  {removing === entry.id ? (
                    <>
                      <span className="text-[10.5px] font-semibold text-ink-muted">Supprimer ?</span>
                      <DButton variant="danger" size="sm" onClick={() => void removeCalendar(entry.id)}>
                        <Trash2 className="size-3.5" />
                        Confirmer
                      </DButton>
                      <DButton variant="plain" size="sm" onClick={() => setRemoving(null)}>
                        Annuler
                      </DButton>
                    </>
                  ) : (
                    <>
                      {isExternalCalendar(entry) && (!isIcsCalendar(entry) || icsUrlOf(entry)) ? (
                        <DButton
                          variant="ghost"
                          size="sm"
                          aria-label={`Actualiser le calendrier ${entry.name}`}
                          disabled={sources.refreshing === entry.id}
                          onClick={() => void sources.refresh(entry)}
                        >
                          <RefreshCw
                            className={cn("size-3.5", sources.refreshing === entry.id && "animate-spin")}
                            strokeWidth={2.4}
                          />
                          Actualiser
                        </DButton>
                      ) : null}
                      <DButton
                        variant="ghost"
                        size="sm"
                        aria-label={`Renommer le calendrier ${entry.name}`}
                        onClick={() => startRename(entry.id, entry.name)}
                      >
                        <PenLine className="size-3.5" />
                        Renommer
                      </DButton>
                      <DButton
                        variant="danger"
                        size="sm"
                        aria-label={`Supprimer le calendrier ${entry.name}`}
                        onClick={() => setRemoving(entry.id)}
                      >
                        <Trash2 className="size-3.5" />
                        Supprimer
                      </DButton>
                    </>
                  )}
                </>
              )}
              {isCaldavCalendar(entry) ? (
                <div className="w-full">
                <button
                  type="button"
                  aria-label={`Changer de calendrier pour ${entry.name}`}
                  aria-expanded={collectionEditing === entry.id}
                  onClick={() =>
                    setCollectionEditing((current) => (current === entry.id ? null : entry.id))
                  }
                  className="focus-ring inline-flex h-7 items-center gap-1 rounded-lg px-1.5 text-[11px] font-bold text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <CalendarDays className="size-3.5" strokeWidth={2.4} />
                  Changer de calendrier
                </button>
                  {collectionEditing === entry.id ? (
                    <CaldavCollectionPicker
                      load={() => sources.sourceCollections(entry)}
                      href={sources.collectionOf(entry) ?? ""}
                      onChoose={(href) => void sources.setCollection(entry, href.trim() || null)}
                      label={`Calendrier de ${entry.name}`}
                      pathLabel={`Chemin du calendrier de ${entry.name}`}
                      disabled={sources.busy}
                      readOnly={readOnly}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <p className="border-t border-line/70 px-3.5 py-2 text-[10.5px] leading-relaxed font-semibold text-ink-muted">
        Enregistrés sur cet appareil : l'agenda les affiche aussitôt. Supprimer une source ICS, CalDAV ou Google retire
        ses événements de l'agenda ; une source CalDAV part aussi du démon.
      </p>
    </Surface>
  );
}

export function DesktopSettings({ onOpenPgp }: { onOpenPgp?: () => void }) {
  const updater = useUpdater();
  const updateState = phaseLabel(updater.phase);
  const installedVersion = updater.current ?? APP_VERSION;
  const { accent, mode: themeMode, brand, setAccent, setMode: setThemeMode, reset } = useTheme();
  const {
    pgpEncrypt,
    pgpSign,
    pgpAccounts,
    setAccountPerimeter,
    setAccountPgp,
    attachPublicKey,
    setAttachPublicKey,
    mcpConfirmSend,
    calendarEnabled,
    planningEnabled,
    setCalendarEnabled,
    setPlanningEnabled,
    mcpEnabled,
    setMcpEnabled,
    mcpAlwaysAllow,
    setMcpAlwaysAllow,
    resetMcpAllowances,
    signatures,
    teamContext,
    setTeamContext,
    llm,
    setLlm,
    decision,
    setDecision,
    aiReplyEnabled,
    setAiReplyEnabled,
    summary: summaryConfig,
    setSummary,
    aiTasks,
    setAiTasks,
    notifications,
    setNotifications,
    setAccountNotification,
    perimeters,
    threadView,
    setThreadView,
    mailDensity,
    setMailDensity,
    mailPreview,
    setMailPreview,
    mailPreviewStyle,
    setMailPreviewStyle,
    updates,
    setUpdates,
  } = usePrefs();
  const {
    notify,
    accounts,
    mails,
    mode,
    readOnly,
    openConnect,
    askRemoveAccount,
    renameAccount,
    reconnectAccount,
    triageMails,
    decisions,
  } = useMailStore();
  const smartActive = decisionReady(decision) || Object.keys(decisions).length > 0;
  const [active, setActive] = useState<SectionId>("comptes");
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hex, setHex] = useState(accent);
  const [openServer, setOpenServer] = useState<string | null>(null);
  const [signatureAccount, setSignatureAccount] = useState<string | null>(null);
  const [teamAccount, setTeamAccount] = useState<string | null>(null);
  const [pgpAccount, setPgpAccount] = useState<string | null>(null);
  const [notificationAccount, setNotificationAccount] = useState<string | null>(null);
  const [generateForm, setGenerateForm] = useState(false);
  const [generateName, setGenerateName] = useState("");
  const [generateEmail, setGenerateEmail] = useState("");
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const { keys, error: keysError, loading: keysLoading, load: loadKeys } = usePgpKeys();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [folderPanel, setFolderPanel] = useState<string | null>(null);
  const [aiPanel, setAiPanel] = useState<string | null>(null);
  const [perimeterPanel, setPerimeterPanel] = useState<string | null>(null);
  const [folderSelection, setFolderSelection] = useState<Record<string, string[] | null>>({});
  const [renameValue, setRenameValue] = useState("");
  const [savingRename, setSavingRename] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null);
  const [decisionProbing, setDecisionProbing] = useState(false);
  const [decisionProbeState, setDecisionProbeState] = useState<{ ok: boolean; text: string } | null>(null);
  const [thresholdsOpen, setThresholdsOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const copilot = useCopilotSession(llm.copilotClientId);
  const copilotProvider = providerOf(llm) === "copilot";
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const aiUsage = useAiUsage();
  const aiDays = lastDays(aiUsage.combined);
  const aiPeak = Math.max(...aiDays.map((day) => day.usage.calls), 1);
  const aiModels = topModels(aiUsage.combined);
  const mod = detectModKey();
  const shortcutList = shortcutCatalog();

  useEffect(() => setHex(accent), [accent]);

  const enabled = mergeFlags(
    Object.fromEntries(MCP_SERVERS.map((server) => [server.id, server.status === "connected"])),
    mcpEnabled,
  );
  const counts = mcpCounts((server) => enabled[server.id]);
  const log = useMcpLog();
  const allowances = { alwaysAllow: mcpAlwaysAllow, confirmSend: mcpConfirmSend };
  const myKey = keys?.find((key) => key.has_secret) ?? null;
  const myState = myKey ? keyState(myKey) : null;
  const expiringSoon = myKey ? !isExpired(myKey) && isExpired(myKey, new Date(Date.now() + 90 * 864e5)) : false;
  const publicKeys = keys?.filter((key) => !key.has_secret).length ?? 0;
  const analyzedAccounts = accounts.filter((item) => !aiTasks.excludedAccounts.includes(item.id));
  const notifyingAccounts = accounts.filter((item) => notifications.accounts[item.id] !== false).length;
  const notificationTarget = accounts.find((item) => item.id === notificationAccount) ?? accounts[0] ?? null;
  const signatureTarget = accounts.find((item) => item.id === signatureAccount) ?? accounts[0] ?? null;
  const signedAccounts = accounts.filter((item) => activeSignature(signatures, item.id)).length;
  const teamTarget = accounts.find((item) => item.id === teamAccount) ?? accounts[0] ?? null;
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
  const pgpSettings = { pgpEncrypt, pgpSign, pgpAccounts };
  const pgpTarget = accounts.find((item) => item.id === pgpAccount) ?? accounts[0] ?? null;
  const pgpEntry = pgpTarget ? accountPgp(pgpSettings, pgpTarget.id) : null;
  const pgpAccountsOn = accounts.filter((item) => accountPgp(pgpSettings, item.id).enabled).length;

  const openGenerate = () => {
    setGenerateName(accounts[0]?.label ?? "");
    setGenerateEmail(accounts[0]?.email ?? "");
    setGenerateForm(true);
  };

  const runGenerate = async () => {
    const name = generateName.trim();
    const email = generateEmail.trim();
    if (!name || !email) {
      notify("Nom et adresse e-mail requis pour générer une clé");
      return;
    }
    setGenerating(true);
    try {
      const result = await generateKey({ name, email });
      await loadKeys();
      setGenerateForm(false);
      notify(`Clé générée · ${keyLabel(result.key)}`);
    } catch (failure) {
      notify(`Génération impossible · ${errorText(failure)}`);
    } finally {
      setGenerating(false);
    }
  };

  const copyPublicKey = async (key: PgpKey) => {
    setExporting(key.fingerprint);
    try {
      const armored = await exportKey(key.fingerprint);
      try {
        await navigator.clipboard.writeText(armored);
        notify(`Clé publique de ${keyLabel(key)} copiée dans le presse-papiers`);
      } catch {
        notify("Export prêt, mais le presse-papiers est indisponible");
      }
    } catch (failure) {
      notify(`Export impossible · ${errorText(failure)}`);
    } finally {
      setExporting(null);
    }
  };

  const startRename = (id: string, label: string) => {
    setRenaming(id);
    setRenameValue(label);
  };

  const runRename = async (id: string) => {
    const label = renameValue.trim();
    if (!label) {
      notify("Nom de compte requis");
      return;
    }
    setSavingRename(true);
    try {
      await renameAccount(id, label);
      setRenaming(null);
    } finally {
      setSavingRename(false);
    }
  };

  const updateLlm = (patch: {
    endpoint?: string;
    model?: string;
    apiKey?: string;
    copilotClientId?: string;
  }) => {
    setProbe(null);
    if (patch.endpoint !== undefined || patch.apiKey !== undefined) {
      setModels([]);
      setModelsError(null);
    }
    setLlm(patch);
  };

  const pickProvider = (provider: LlmProvider) => {
    setProbe(null);
    setModels([]);
    setModelsError(null);
    if (provider === "openai" && !llm.endpoint.trim()) {
      setLlm({ provider, endpoint: OPENAI_ENDPOINT });
      return;
    }
    setLlm({ provider });
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
      const answer = await llmProbe(llm);
      setProbe({ ok: true, text: answer });
    } catch (failure) {
      setProbe({ ok: false, text: failure instanceof Error ? failure.message : "échec inconnu" });
    } finally {
      setProbing(false);
    }
  };

  const pushDecisionDaemon = (next: DecisionConfig, apiKeyOverride?: string, clearApiKey = false) => {
    if (mode !== "api") return;
    void mailApi
      .saveDecisionConfig(toApiDecisionConfig(next, { apiKey: apiKeyOverride, clearApiKey }))
      .then((saved) => {
        setDecision({
          daemonHasKey: saved.has_api_key,
          ...(saved.has_api_key && apiKeyOverride ? { apiKey: "" } : {}),
        });
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    if (mode !== "api") return;
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
  }, [mode, setDecision]);

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

  const goTo = (id: SectionId) => {
    setActive(id);
    setQuery("");
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  const updateHex = (value: string) => {
    setHex(value);
    const clean = value.trim();
    if (!/^#?[0-9a-f]{6}$/i.test(clean)) return;
    setAccent(clean.startsWith("#") ? clean.toLowerCase() : `#${clean.toLowerCase()}`);
  };

  const needle = normalize(query.trim());
  const visibleGroups = NAV_GROUPS.map((group) => ({
    ...group,
    sections: group.sections.filter((section) => sectionMatches(section, needle)),
  })).filter((group) => group.sections.length > 0);
  const firstMatch = visibleGroups[0]?.sections[0];

  return (
    <div className="relative h-full">
      <div className="mx-auto flex h-full max-w-[1080px] items-stretch gap-8 px-4 sm:px-8">
        <nav
          aria-label="Sections des réglages"
          className="hidden w-[220px] shrink-0 flex-col pt-6 pb-6 min-[900px]:flex"
        >
          <div className="relative mb-4">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-muted" />
            <TextInput
              aria-label="Rechercher un réglage"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && firstMatch) goTo(firstMatch.id);
                if (event.key === "Escape") setQuery("");
              }}
              placeholder="Rechercher…"
              className="h-8 pl-8 text-[12px] font-semibold"
            />
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto no-scrollbar pb-4">
            {visibleGroups.map((group) => (
              <div key={group.id} role="group" aria-label={group.label}>
                <p className="px-2.5 pb-1 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                  {group.label}
                </p>
                <ul className="space-y-0.5">
                  {group.sections.map((section) => {
                    const Icon = SECTION_ICONS[section.id];
                    return (
                      <li key={section.id}>
                        <button
                          type="button"
                          onClick={() => goTo(section.id)}
                          aria-current={active === section.id}
                          className={cn(
                            "focus-ring flex h-9 w-full items-center gap-2 rounded-[10px] px-2 text-left text-[12px] font-semibold transition-colors duration-200",
                            active === section.id
                              ? "bg-accent-soft text-accent-ink"
                              : "text-ink-soft hover:bg-surface-2 hover:text-ink",
                          )}
                        >
                          <span
                            className={cn(
                              "grid size-6 shrink-0 place-items-center rounded-[8px]",
                              active === section.id
                                ? "bg-accent text-accent-contrast"
                                : "bg-surface-2 text-ink-muted",
                            )}
                          >
                            <Icon className="size-3.5" />
                          </span>
                          {section.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {visibleGroups.length === 0 ? (
              <p className="px-2.5 text-[12px] font-medium text-ink-muted">Aucun réglage ne correspond.</p>
            ) : null}
          </div>
        </nav>

        <div ref={scrollRef} className="h-full min-w-0 flex-1 overflow-y-auto no-scrollbar">
          <header className="flex items-center justify-between gap-4 pt-6">
            <div className="flex items-center gap-2.5">
              <PaneTitle hint={import.meta.env.VITE_DISTRIBUTION === "1" ? undefined : "maquette PC"}>
                Réglages
              </PaneTitle>
              <Badge tone="accent">{brand}</Badge>
            </div>
            <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">v0.1.0</span>
          </header>

          <div
            role="navigation"
            aria-label="Sections des réglages · compact"
            className="-mx-4 mt-4 flex gap-1.5 overflow-x-auto no-scrollbar px-4 pb-1 min-[900px]:hidden"
          >
            {SECTIONS.map((section) => {
              const Icon = SECTION_ICONS[section.id];
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => goTo(section.id)}
                  aria-current={active === section.id}
                  className={cn(
                    "focus-ring flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[11.5px] font-bold transition-colors duration-200",
                    active === section.id
                      ? "border-accent-ring bg-accent-soft text-accent-ink"
                      : "border-line bg-surface text-ink-soft hover:text-ink",
                  )}
                >
                  <Icon className="size-3.5" />
                  {section.label}
                </button>
              );
            })}
          </div>

          <ActiveSectionContext.Provider value={active}>
            <BlurFade key={active} duration={0.3} yOffset={8} className="mt-6 space-y-7 pb-32">
              <Block id="comptes" label="Comptes" hint={`${accounts.length} compte${accounts.length > 1 ? "s" : ""}`}>
                <BlurFade delay={0.04}>
                  <div className="grid gap-3 md:grid-cols-2">
                    {accounts.map((item, index) => (
                      <Surface key={item.id} className="min-w-0 p-3.5">
                        <div className="flex items-center gap-2.5">
                          <span
                            className="grid size-9 shrink-0 place-items-center rounded-[12px] text-[12px] font-black"
                            style={{ backgroundColor: item.color, color: accentContrast(item.color) }}
                          >
                            {item.label[0]}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <p className="truncate text-[12.5px] font-bold text-ink">{item.label}</p>
                              {index === 0 ? <Badge tone="accent">Principal</Badge> : null}
                              {item.needsReauth ? (
                                <Badge tone="amber">Connexion expirée</Badge>
                              ) : null}
                            </div>
                            <p className="truncate text-[11px] font-medium text-ink-muted">{item.email}</p>
                          </div>
                        </div>
                        <div className="mt-2.5 flex items-center justify-between gap-2">
                          <span className="truncate text-[12px] font-semibold text-ink-soft">{item.provider}</span>
                          <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold text-ink-muted">
                            <RefreshCw className="size-3" />
                            {item.synced}
                          </span>
                        </div>
                        {mode === "api" &&
                          (renaming === item.id ? (
                            <div className="mt-2 flex items-center gap-1.5">
                              <TextInput
                                aria-label={`Nouveau nom pour ${item.email}`}
                                value={renameValue}
                                autoFocus
                                onChange={(event) => setRenameValue(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") void runRename(item.id);
                                  if (event.key === "Escape") setRenaming(null);
                                }}
                                className="h-8 text-[11.5px] font-semibold"
                              />
                              <DButton
                                variant="primary"
                                size="sm"
                                disabled={savingRename}
                                onClick={() => void runRename(item.id)}
                              >
                                {savingRename ? (
                                  <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                  <Check className="size-3.5" />
                                )}
                                Valider
                              </DButton>
                              <DButton
                                variant="plain"
                                size="sm"
                                disabled={savingRename}
                                onClick={() => setRenaming(null)}
                              >
                                Annuler
                              </DButton>
                            </div>
                          ) : (
                            <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                              <DButton
                                variant="ghost"
                                size="sm"
                                aria-label={`Renommer ${item.label}`}
                                onClick={() => startRename(item.id, item.label)}
                              >
                                <PenLine className="size-3.5" />
                                Renommer
                              </DButton>
                              <DButton
                                variant="ghost"
                                size="sm"
                                aria-label={`Dossiers synchronisés de ${item.label}`}
                                aria-pressed={folderPanel === item.id}
                                onClick={() =>
                                  setFolderPanel((current) => (current === item.id ? null : item.id))
                                }
                              >
                                <FolderTree className="size-3.5" />
                                Dossiers
                              </DButton>
                              {mode === "api" ? (
                                <DButton
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`Dossiers analysés par l'IA de ${item.label}`}
                                  aria-pressed={aiPanel === item.id}
                                  onClick={() =>
                                    setAiPanel((current) => (current === item.id ? null : item.id))
                                  }
                                >
                                  <Sparkles className="size-3.5" />
                                  IA
                                </DButton>
                              ) : null}
                              <DButton
                                variant="ghost"
                                size="sm"
                                aria-label={`Périmètre de synchronisation de ${item.label}`}
                                aria-pressed={perimeterPanel === item.id}
                                onClick={() =>
                                  setPerimeterPanel((current) => (current === item.id ? null : item.id))
                                }
                              >
                                <SlidersHorizontal className="size-3.5" />
                                Périmètre
                              </DButton>
                              {item.oauth ? (
                                <DButton
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`Reconnecter ${item.label}`}
                                  onClick={() => void reconnectAccount(item)}
                                >
                                  <RefreshCw className="size-3.5" />
                                  Reconnecter
                                </DButton>
                              ) : null}
                              {readOnly ? null : (
                                <DButton variant="danger" size="sm" onClick={() => askRemoveAccount(item)}>
                                  <Trash2 className="size-3.5" />
                                  Retirer
                                </DButton>
                              )}
                            </div>
                          ))}
                        {mode === "api" && folderPanel === item.id ? (
                          <AccountFolderPicker
                            account={item}
                            selection={folderSelection[item.id] ?? item.syncedFolders ?? null}
                            onSelection={(next) =>
                              setFolderSelection((current) => ({ ...current, [item.id]: next }))
                            }
                            notify={notify}
                          />
                        ) : null}
                        {aiPanel === item.id ? (
                          <div className="mt-2 rounded-2xl border border-line bg-surface-2/40 pb-1.5">
                            <AiFoldersPicker account={item} />
                          </div>
                        ) : null}
                        {perimeterPanel === item.id ? (
                          <div
                            role="group"
                            aria-label={`Périmètre de synchronisation de ${item.label}`}
                            className="mt-2 overflow-hidden rounded-2xl border border-line bg-surface-2/50"
                          >
                            <p className="px-3.5 pt-2.5 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                              Périmètre de synchronisation
                            </p>
                            <ToggleRow
                              icon={<Mail className="size-4" />}
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
                            <ContactsSyncRow accountId={item.id} />
                          </div>
                        ) : null}
                      </Surface>
                    ))}
                    {readOnly ? null : (
                      <button
                        type="button"
                        onClick={openConnect}
                        className="focus-ring flex min-h-[88px] items-center justify-center gap-2 rounded-[26px] border border-dashed border-line bg-surface/60 text-[12px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
                      >
                        <Plus className="size-4" strokeWidth={3} />
                        Ajouter un compte
                      </button>
                    )}
                  </div>
                </BlurFade>
              </Block>

              <Block
                id="signatures"
                label="Signatures"
                hint={`${signedAccounts} sur ${accounts.length} compte${accounts.length > 1 ? "s" : ""}`}
              >
                {signatureTarget ? (
                  <BlurFade delay={0.04}>
                    <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
                      {accounts.map((item) => (
                        <DChip
                          key={item.id}
                          active={signatureTarget.id === item.id}
                          onClick={() => setSignatureAccount(item.id)}
                        >
                          <span className="size-2 rounded-full" style={{ backgroundColor: item.color }} />
                          {item.label}
                          {activeSignature(signatures, item.id) ? <Check className="size-3" strokeWidth={3} /> : null}
                        </DChip>
                      ))}
                    </div>
                    <SignatureEditor account={signatureTarget} />
                  </BlurFade>
                ) : (
                  <Surface className="p-4">
                    <p className="text-[12.5px] font-bold text-ink">Aucun compte</p>
                    <p className="mt-0.5 text-[11.5px] font-medium text-ink-muted">
                      Ajoute un compte pour lui donner sa propre signature.
                    </p>
                  </Surface>
                )}
              </Block>

              <Block id="messagerie" label="Filtres & absence" hint="sur le serveur Zimbra">
                <ZimbraFiltersPanel />
                <div className="mt-3">
                  <ZimbraTagsPanel />
                </div>
              </Block>

              <Block id="moi-equipe" label="Moi et mon équipe" hint="identité, rôle, équipe par boîte">
                {teamTarget ? (
                  <BlurFade delay={0.04}>
                    <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
                      {accounts.map((item) => (
                        <DChip
                          key={item.id}
                          active={teamTarget.id === item.id}
                          onClick={() => setTeamAccount(item.id)}
                        >
                          <span className="size-2 rounded-full" style={{ backgroundColor: item.color }} />
                          {item.label}
                        </DChip>
                      ))}
                    </div>
                    <Surface className="space-y-2.5 p-3.5">
                      <div className="grid gap-2.5 md:grid-cols-2">
                        <label className="grid gap-1">
                          <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                            Votre nom
                          </span>
                          <TextInput
                            aria-label="Votre nom"
                            placeholder="Roman FELDEN"
                            value={team.identity}
                            onChange={(event) => updateTeam({ identity: event.target.value })}
                          />
                        </label>
                        <label className="grid gap-1">
                          <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                            Votre rôle
                          </span>
                          <TextInput
                            aria-label="Votre rôle"
                            placeholder="DSI"
                            value={team.role}
                            onChange={(event) => updateTeam({ role: event.target.value })}
                          />
                        </label>
                      </div>
                      <label className="grid gap-1">
                        <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                          Contexte de la boîte
                        </span>
                        <TextArea
                          aria-label="Contexte de la boîte"
                          rows={3}
                          placeholder="Je suis Roman FELDEN, DSI de l'ENSAG…"
                          value={team.context}
                          onChange={(event) => updateTeam({ context: event.target.value })}
                        />
                      </label>
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                            Équipe
                          </span>
                          <DButton
                            variant="ghost"
                            size="sm"
                            disabled={team.members.length >= TEAM_MEMBERS_MAX}
                            onClick={addMember}
                          >
                            <Plus className="size-3.5" />
                            Ajouter un membre
                          </DButton>
                        </div>
                        {team.members.map((member, index) => (
                          <div key={index} className="flex items-center gap-1.5">
                            <TextInput
                              aria-label={`Nom du membre ${index + 1}`}
                              placeholder="Camille"
                              value={member.name}
                              onChange={(event) => patchMember(index, { name: event.target.value })}
                            />
                            <TextInput
                              aria-label={`Périmètre du membre ${index + 1}`}
                              placeholder="Ateliers, planning"
                              value={member.scope}
                              onChange={(event) => patchMember(index, { scope: event.target.value })}
                            />
                            <DButton
                              variant="plain"
                              size="sm"
                              aria-label={`Retirer le membre ${index + 1}`}
                              onClick={() => removeMember(index)}
                            >
                              <Trash2 className="size-3.5" />
                            </DButton>
                          </div>
                        ))}
                      </div>
                      <p className="text-[11.5px] leading-relaxed font-medium text-ink-muted">
                        L'assistant reçoit cette fiche comme contexte fiable, en dehors des mails.
                      </p>
                    </Surface>
                  </BlurFade>
                ) : (
                  <Surface className="p-4">
                    <p className="text-[12.5px] font-bold text-ink">Aucun compte</p>
                    <p className="mt-0.5 text-[11.5px] font-medium text-ink-muted">
                      Ajoute un compte pour lui donner sa propre fiche.
                    </p>
                  </Surface>
                )}
              </Block>

              <Block id="apparence" label="Apparence" hint={brand}>
                <div className="grid gap-3 md:grid-cols-2">
                  <Surface className="p-4">
                    <SectionLabel>Thème</SectionLabel>
                    <div className="mt-2 grid grid-cols-3 gap-1.5">
                      {([
                        { label: "Clair", icon: Sun, value: "light" },
                        { label: "Sombre", icon: Moon, value: "dark" },
                        { label: "Auto", icon: SunMoon, value: "auto" },
                      ] as { label: string; icon: typeof Sun; value: ThemeMode }[]).map((option) => {
                        const Icon = option.icon;
                        const selected = themeMode === option.value;
                        return (
                          <button
                            key={option.label}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => setThemeMode(option.value)}
                            className={cn(
                              "focus-ring flex h-10 items-center justify-center gap-1.5 rounded-[14px] text-[12px] font-bold transition-colors duration-200",
                              selected
                                ? "bg-accent-soft text-accent-ink ring-1 ring-accent-ring/60"
                                : "border border-line bg-surface text-ink-soft hover:text-ink",
                            )}
                          >
                            <Icon className="size-4" />
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-1.5 text-[12.5px] leading-snug font-medium text-ink-muted">
                      Auto : suit le thème du système.
                    </p>

                    <SectionLabel className="mt-4">Couleur d'accent</SectionLabel>
                    <div className="mt-2 grid grid-cols-3 gap-1.5">
                      {ACCENT_PRESETS.map((preset) => {
                        const selected = preset.value.toLowerCase() === accent.toLowerCase();
                        return (
                          <button
                            key={preset.value}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => setAccent(preset.value)}
                            className={cn(
                              "focus-ring flex h-9 items-center gap-1.5 rounded-[12px] border px-2 text-[11px] font-bold transition-colors duration-200",
                              selected
                                ? "border-accent-ring bg-accent-soft text-accent-ink"
                                : "border-line bg-surface text-ink-soft hover:border-accent-ring hover:text-ink",
                            )}
                          >
                            <span
                              className="size-3.5 shrink-0 rounded-full"
                              style={{ backgroundColor: preset.value }}
                            />
                            <span className="truncate">{preset.name}</span>
                            {selected ? <Check className="ml-auto size-3 shrink-0" strokeWidth={3} /> : null}
                          </button>
                        );
                      })}
                    </div>

                    <div className="mt-2.5 flex items-center gap-2">
                      <label
                        title="Couleur personnalisée"
                        className="relative grid size-9 shrink-0 cursor-pointer place-items-center rounded-xl border border-line bg-surface"
                      >
                        <span
                          className="size-5 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)]"
                          style={{ backgroundColor: accent }}
                        />
                        <input
                          type="color"
                          value={accent}
                          aria-label="Couleur personnalisée"
                          onChange={(event) => setAccent(event.target.value)}
                          className="absolute inset-0 cursor-pointer opacity-0"
                        />
                      </label>
                      <TextInput
                        aria-label="Code hexadécimal"
                        value={hex}
                        onChange={(event) => updateHex(event.target.value)}
                        className="h-9 font-mono text-[11.5px] font-semibold uppercase"
                      />
                      <DButton variant="ghost" size="sm" className="h-9" onClick={reset}>
                        <RotateCcw className="size-3.5" />
                        Réinitialiser
                      </DButton>
                    </div>
                  </Surface>

                  <Surface className="p-4">
                    <SectionLabel>Aperçu</SectionLabel>
                    <div className="mt-3 space-y-3">
                      <div className="flex items-center gap-2">
                        <span className="size-7 shrink-0 rounded-full bg-accent shadow-[0_8px_20px_-8px_var(--accent)]" />
                        <span className="rounded-md bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent-ink">
                          badge accent
                        </span>
                        <span className="text-[12px] font-bold text-accent-ink">texte accent-ink</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <DButton variant="primary" size="sm">
                          Bouton principal
                        </DButton>
                        <DButton variant="soft" size="sm">
                          Secondaire
                        </DButton>
                      </div>
                      <div className="flex items-center gap-2 rounded-[16px] border border-accent-ring/50 bg-accent-soft/40 px-2.5 py-2">
                        <Lock className="size-3.5 shrink-0 text-accent-ink" />
                        <span className="truncate text-[10.5px] font-semibold text-accent-ink">
                          ligne accentuée · {accent}
                        </span>
                      </div>
                    </div>
                  </Surface>
                </div>

                <Surface className="mt-3 p-4">
                  <SectionLabel>Affichage des conversations</SectionLabel>
                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    {THREAD_VIEWS.map((option) => {
                      const selected = threadView === option.id;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setThreadView(option.id)}
                          className={cn(
                            "focus-ring flex h-10 items-center justify-center rounded-[14px] text-[12px] font-bold transition-colors duration-200",
                            selected
                              ? "bg-accent-soft text-accent-ink ring-1 ring-accent-ring/60"
                              : "border border-line bg-surface text-ink-soft hover:text-ink",
                          )}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1.5 text-[12.5px] leading-snug font-medium text-ink-muted">
                    {THREAD_VIEWS.find((option) => option.id === threadView)?.hint}
                  </p>
                </Surface>

                <Surface className="mt-3 p-4">
                  <SectionLabel>Affichage des mails</SectionLabel>
                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    {MAIL_DENSITIES.map((option) => {
                      const selected = mailDensity === option.id;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setMailDensity(option.id)}
                          className={cn(
                            "focus-ring flex h-10 items-center justify-center rounded-[14px] text-[12px] font-bold transition-colors duration-200",
                            selected
                              ? "bg-accent-soft text-accent-ink ring-1 ring-accent-ring/60"
                              : "border border-line bg-surface text-ink-soft hover:text-ink",
                          )}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1.5 text-[12.5px] leading-snug font-medium text-ink-muted">
                    {MAIL_DENSITIES.find((option) => option.id === mailDensity)?.hint}
                  </p>
                </Surface>

                <Surface className="mt-3 p-4">
                  <SectionLabel>Aperçu de la liste</SectionLabel>
                  <div className="mt-2 grid grid-cols-3 gap-1.5">
                    {MAIL_PREVIEWS.map((option) => {
                      const selected = mailPreview === option.id;
                      const unavailable = option.id === "ai" && !smartActive;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          aria-pressed={selected}
                          aria-disabled={unavailable || undefined}
                          disabled={unavailable}
                          onClick={() => setMailPreview(option.id)}
                          className={cn(
                            "focus-ring flex h-10 items-center justify-center rounded-[14px] text-[12px] font-bold transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-55",
                            selected
                              ? "bg-accent-soft text-accent-ink ring-1 ring-accent-ring/60"
                              : "border border-line bg-surface text-ink-soft hover:text-ink",
                          )}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1.5 text-[12.5px] leading-snug font-medium text-ink-muted">
                    {smartActive
                      ? MAIL_PREVIEWS.find((option) => option.id === mailPreview)?.hint
                      : "Modèle de décision non configuré : l'aperçu reste l'extrait du message."}
                  </p>
                </Surface>

                {mailPreview === "ai" && smartActive ? (
                  <Surface className="mt-3 p-4">
                    <SectionLabel>Style de description</SectionLabel>
                    <div className="mt-2 grid grid-cols-2 gap-1.5">
                      {MAIL_PREVIEW_STYLES.map((option) => {
                        const selected = mailPreviewStyle === option.id;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => setMailPreviewStyle(option.id)}
                            className={cn(
                              "focus-ring flex h-10 items-center justify-center rounded-[14px] text-[12px] font-bold transition-colors duration-200",
                              selected
                                ? "bg-accent-soft text-accent-ink ring-1 ring-accent-ring/60"
                                : "border border-line bg-surface text-ink-soft hover:text-ink",
                            )}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-1.5 text-[12.5px] leading-snug font-medium text-ink-muted">
                      {MAIL_PREVIEW_STYLES.find((option) => option.id === mailPreviewStyle)?.hint}
                    </p>

                    <SectionLabel className="mt-3">Exemple — mail de Marc Delaunay</SectionLabel>
                    <p className="mt-1 text-[13px] font-semibold text-ink">
                      Devis signé — retour de ma part
                    </p>
                    {PREVIEW_EXAMPLES.map((example) => {
                      const active = mailPreviewStyle === example.id;
                      return (
                        <button
                          key={example.id}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setMailPreviewStyle(example.id)}
                          className={cn(
                            "mt-1.5 flex w-full items-baseline gap-1.5 rounded-[12px] border px-2.5 py-2 text-left transition-colors duration-200",
                            active
                              ? "border-transparent bg-accent-soft ring-1 ring-accent-ring/60"
                              : "border-line bg-surface hover:border-accent-ring",
                          )}
                        >
                          <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[9.5px] font-extrabold text-ink-muted">
                            {example.tag}
                          </span>
                          <Sparkles className="size-3 shrink-0 text-accent-ink" strokeWidth={2.4} />
                          <span className="text-[12.5px] font-medium text-accent-ink">
                            {example.text}
                          </span>
                        </button>
                      );
                    })}
                  </Surface>
                ) : null}
              </Block>

              <Block id="modules" label="Modules">
                <Surface className="divide-y divide-line overflow-hidden">
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
                </Surface>
              </Block>

              <Block id="synchronisation" label="Synchronisation" hint="chiffré de bout en bout">
                <SyncSettings variant="desktop" />
              </Block>

              <Block id="calendriers" label="Calendriers">
                <CalendarsSection />
              </Block>

              <Block
                id="notifications"
                label="Notifications"
                hint={notifications.enabled ? "actives" : "coupées"}
              >
                <div className="grid gap-3 md:grid-cols-2">
                  <Surface className="divide-y divide-line overflow-hidden">
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
                    <ToggleRow
                      icon={<CalendarDays className="size-4" />}
                      label="Rappels d'agenda"
                      hint="Un rendez-vous du calendrier commence bientôt"
                      checked={notifications.calendar}
                      onChange={(value) => setNotifications({ calendar: value })}
                    />
                  </Surface>

                  <Surface className="p-4">
                    <SectionLabel>Délai du rappel</SectionLabel>
                    <div className="mt-2 grid grid-cols-5 gap-1.5">
                      {CALENDAR_LEAD_MINUTES.map((minutes) => {
                        const selected = notifications.calendarMinutes === minutes;
                        return (
                          <button
                            key={minutes}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            disabled={!notifications.calendar}
                            onClick={() => setNotifications({ calendarMinutes: minutes })}
                            className={cn(
                              "focus-ring flex h-9 items-center justify-center gap-1 rounded-[12px] text-[11px] font-bold transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-55",
                              selected
                                ? "border border-accent-ring bg-accent-soft text-accent-ink"
                                : "border border-line bg-surface text-ink-soft hover:border-accent-ring hover:text-ink",
                            )}
                          >
                            {minutes === 0 ? "À l'heure" : `${minutes} min`}
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-3 text-[10.5px] font-semibold text-ink-muted">
                      Avant le début du rendez-vous · un seul rappel par événement, et uniquement tant que
                      l'application tourne.
                    </p>
                  </Surface>
                </div>

                <Surface className="mt-3 overflow-hidden">
                  <div className="border-b border-line px-3.5 py-2">
                    <div className="flex items-center gap-1.5">
                      <SectionLabel>Par compte</SectionLabel>
                      <span className="text-[12px] font-semibold text-ink-muted">
                        {notifyingAccounts} sur {accounts.length}
                      </span>
                    </div>
                    {accounts.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {accounts.map((item) => (
                          <DChip
                            key={item.id}
                            active={notificationTarget?.id === item.id}
                            onClick={() => setNotificationAccount(item.id)}
                          >
                            <span className="size-2 rounded-full" style={{ backgroundColor: item.color }} />
                            {item.label}
                            {notifications.accounts[item.id] !== false ? (
                              <Check className="size-3" strokeWidth={3} />
                            ) : null}
                          </DChip>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-1 text-[11px] font-medium text-ink-muted">
                        Ajoute un compte pour régler ses notifications.
                      </p>
                    )}
                  </div>
                  {notificationTarget ? (
                    <ToggleRow
                      icon={<Bell className="size-4" />}
                      label={`Notifier ${notificationTarget.label}`}
                      hint={`Nouveaux mails de ${notificationTarget.email} · sans effet si l'interrupteur général est coupé`}
                      checked={notifications.accounts[notificationTarget.id] !== false}
                      onChange={(value) => setAccountNotification(notificationTarget.id, value)}
                    />
                  ) : null}
                </Surface>
              </Block>

              <Block
                id="securite"
                label="Sécurité & PGP"
                hint={
                  keysError
                    ? "clés indisponibles"
                    : keys === null
                      ? "chargement…"
                      : `${keys.length} clé${keys.length > 1 ? "s" : ""}`
                }
              >
                <div className="grid gap-3 md:grid-cols-2">
                  <Surface className={cn("p-4", expiringSoon && "border-amber-500/40 bg-amber-500/[0.04]")}>
                    <div className="flex items-center gap-1.5">
                      <SectionLabel>Ma clé</SectionLabel>
                      {myKey && myState ? (
                        <Badge tone={KEY_TONE[myState]} className="ml-auto">
                          {PGP_STATE[myState].label}
                        </Badge>
                      ) : null}
                    </div>

                    {keys === null ? (
                      <div className="mt-3 space-y-2">
                        <div className="h-3.5 w-2/3 animate-pulse rounded-full bg-surface-2" />
                        <div className="h-3 w-full animate-pulse rounded-full bg-surface-2" />
                        <div className="h-3 w-1/2 animate-pulse rounded-full bg-surface-2" />
                        <p className="sr-only">Chargement des clés PGP…</p>
                      </div>
                    ) : myKey && myState ? (
                      <>
                        <p className="mt-2.5 text-[13px] font-bold text-ink">
                          {keyLabel(myKey)}
                          {myKey.email ? (
                            <span className="font-medium text-ink-soft">{` <${myKey.email}>`}</span>
                          ) : null}
                        </p>
                        <p className="mt-1.5 font-mono text-[11.5px] leading-relaxed font-semibold break-all text-ink-soft">
                          {formatFingerprint(myKey.fingerprint)}
                        </p>
                        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px]">
                          <div className="col-span-2">
                            <dt className="font-semibold text-ink-muted">Algorithme</dt>
                            <dd className="font-bold text-ink">{myKey.algorithm}</dd>
                          </div>
                          <div>
                            <dt className="font-semibold text-ink-muted">Créée le</dt>
                            <dd className="font-bold text-ink">{formatKeyDate(myKey.created_at)}</dd>
                          </div>
                          <div>
                            <dt className="font-semibold text-ink-muted">Expire le</dt>
                            <dd className="font-bold text-ink">
                              {myKey.expires_at ? formatKeyDate(myKey.expires_at) : "jamais"}
                            </dd>
                          </div>
                          <div>
                            <dt className="font-semibold text-ink-muted">Usage</dt>
                            <dd className="font-bold text-ink">{keyUsage(myKey)} · signature</dd>
                          </div>
                          <div>
                            <dt className="font-semibold text-ink-muted">Identifiant</dt>
                            <dd className="font-mono font-bold text-ink">{myKey.key_id}</dd>
                          </div>
                        </dl>
                        {myState !== "valid" || expiringSoon ? (
                          <p className="mt-2.5 flex items-start gap-1.5 rounded-xl bg-amber-500/12 px-2.5 py-2 text-[12px] leading-snug font-semibold text-amber-700 dark:text-amber-300">
                            <AlertTriangle className="mt-px size-3.5 shrink-0" />
                            {PGP_STATE[myState].hint}
                          </p>
                        ) : null}
                        <DButton
                          variant="ghost"
                          size="sm"
                          className="mt-3"
                          disabled={exporting === myKey.fingerprint}
                          onClick={() => void copyPublicKey(myKey)}
                        >
                          {exporting === myKey.fingerprint ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Download className="size-3.5" />
                          )}
                          Exporter la clé publique
                        </DButton>
                      </>
                    ) : (
                      <>
                        <p className="mt-2.5 text-[12.5px] font-bold text-ink">Aucune clé secrète</p>
                        <p className="mt-0.5 text-[11px] font-medium text-ink-muted">
                          Génère une paire de clés pour chiffrer et signer tes messages depuis ce compte.
                        </p>
                        {keysError ? (
                          <div className="mt-2.5 rounded-xl bg-rose-500/10 px-2.5 py-2">
                            <p className="flex items-start gap-1.5 text-[10.5px] font-semibold text-rose-600 dark:text-rose-300">
                              <AlertTriangle className="mt-px size-3.5 shrink-0" />
                              {keysError}
                            </p>
                            <DButton
                              variant="plain"
                              size="sm"
                              className="-ml-2 mt-0.5"
                              disabled={keysLoading}
                              onClick={() => void loadKeys()}
                            >
                              <RefreshCw className={cn("size-3.5", keysLoading && "animate-spin")} />
                              Réessayer
                            </DButton>
                          </div>
                        ) : null}
                        {generateForm ? (
                          <div className="mt-3 space-y-1.5">
                            <TextInput
                              aria-label="Nom de la clé"
                              placeholder="Nom"
                              value={generateName}
                              onChange={(event) => setGenerateName(event.target.value)}
                            />
                            <TextInput
                              aria-label="Adresse e-mail de la clé"
                              type="email"
                              placeholder="adresse@exemple.fr"
                              value={generateEmail}
                              onChange={(event) => setGenerateEmail(event.target.value)}
                            />
                            <div className="flex items-center gap-1.5">
                              <DButton
                                variant="primary"
                                size="sm"
                                disabled={generating}
                                onClick={() => void runGenerate()}
                              >
                                {generating ? (
                                  <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                  <KeyRound className="size-3.5" />
                                )}
                                {generating ? "Génération…" : "Générer"}
                              </DButton>
                              <DButton
                                variant="plain"
                                size="sm"
                                disabled={generating}
                                onClick={() => setGenerateForm(false)}
                              >
                                Annuler
                              </DButton>
                            </div>
                          </div>
                        ) : (
                          <DButton variant="soft" size="sm" className="mt-3" onClick={openGenerate}>
                            <Sparkles className="size-3.5" />
                            Générer ma clé
                          </DButton>
                        )}
                      </>
                    )}
                  </Surface>

                  <Surface className="overflow-hidden">
                    <div className="border-b border-line px-3.5 py-2">
                      <div className="flex items-center gap-1.5">
                        <SectionLabel>Par compte</SectionLabel>
                        <span className="text-[12px] font-semibold text-ink-muted">
                          {pgpAccountsOn} sur {accounts.length}
                        </span>
                      </div>
                      {accounts.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {accounts.map((item) => (
                            <DChip
                              key={item.id}
                              active={pgpTarget?.id === item.id}
                              onClick={() => setPgpAccount(item.id)}
                            >
                              <span
                                className="size-2 rounded-full"
                                style={{ backgroundColor: item.color }}
                              />
                              {item.label}
                              {accountPgp(pgpSettings, item.id).enabled ? (
                                <Check className="size-3" strokeWidth={3} />
                              ) : null}
                            </DChip>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-1 text-[11px] font-medium text-ink-muted">
                          Ajoute un compte pour régler son PGP.
                        </p>
                      )}
                    </div>
                    {pgpTarget && pgpEntry ? (
                      <div className="divide-y divide-line">
                        <ToggleRow
                          icon={<ShieldCheck className="size-4" />}
                          label={`PGP pour ${pgpTarget.label}`}
                          hint="Chiffrer, signer et déchiffrer ses messages"
                          checked={pgpEntry.enabled}
                          onChange={(value) => setAccountPgp(pgpTarget.id, { enabled: value })}
                        />
                        <ToggleRow
                          icon={<PenLine className="size-4" />}
                          label="Signer ses messages"
                          hint="Signature détachée, vérifiable"
                          checked={pgpEntry.sign}
                          onChange={(value) => setAccountPgp(pgpTarget.id, { sign: value })}
                        />
                        <ToggleRow
                          icon={<Lock className="size-4" />}
                          label="Chiffrer ses messages"
                          hint="Quand une clé valide existe pour chaque destinataire"
                          checked={pgpEntry.encrypt}
                          onChange={(value) => setAccountPgp(pgpTarget.id, { encrypt: value })}
                        />
                        {pgpEntry.enabled ? null : (
                          <p className="px-3.5 py-2 text-[12.5px] leading-snug font-semibold text-ink-muted">
                            PGP désactivé : ce compte ne signe pas, ne chiffre pas et ne déchiffre pas.
                          </p>
                        )}
                      </div>
                    ) : null}
                  </Surface>
                </div>

                <Surface className="mt-3 overflow-hidden">
                  <ToggleRow
                    icon={<KeyRound className="size-4" />}
                    label="Joindre ma clé publique"
                    hint="Aux nouveaux destinataires · tous les comptes"
                    checked={attachPublicKey}
                    onChange={setAttachPublicKey}
                  />
                </Surface>

                <Surface className="mt-3 overflow-hidden">
                  <div className="flex items-center gap-2 border-b border-line px-3.5 py-2">
                    <SectionLabel>Clés</SectionLabel>
                    <span className="text-[12px] font-semibold text-ink-muted">
                      {keys === null
                        ? "chargement…"
                        : `${keys.filter((key) => key.has_secret).length} secrète(s) · ${publicKeys} publique(s)`}
                    </span>
                    {onOpenPgp ? (
                      <DButton variant="soft" size="sm" className="ml-auto" onClick={onOpenPgp}>
                        <KeyRound className="size-3.5" />
                        Gérer mes clés PGP
                      </DButton>
                    ) : null}
                    <DButton
                      variant="ghost"
                      size="sm"
                      className={onOpenPgp ? undefined : "ml-auto"}
                      disabled={keysLoading}
                      onClick={() => void loadKeys()}
                    >
                      <RefreshCw className={cn("size-3.5", keysLoading && "animate-spin")} />
                      Rafraîchir
                    </DButton>
                  </div>
                  <div className="divide-y divide-line">
                    {keys === null ? (
                      <p className="px-3.5 py-3 text-[11.5px] font-medium text-ink-muted">Chargement des clés…</p>
                    ) : keys.length === 0 ? (
                      <p className="px-3.5 py-3 text-[11.5px] font-medium text-ink-muted">
                        {keysError ? "Clés PGP indisponibles pour le moment." : "Aucune clé PGP."}
                      </p>
                    ) : (
                      keys.map((key, index) => {
                        const state = keyState(key);
                        const pending = exporting === key.fingerprint;
                        return (
                          <div key={key.fingerprint} className="flex items-center gap-2.5 px-3.5 py-2.5">
                            <Avatar name={keyLabel(key)} size={28} tone={index % 4} rounded="rounded-[10px]" />
                            <div className="min-w-0 flex-1 leading-tight">
                              <p className="truncate text-[12px] font-bold text-ink">{keyLabel(key)}</p>
                              <p className="truncate font-mono text-[11.5px] font-medium text-ink-muted">
                                {shortFingerprint(key.fingerprint)}
                              </p>
                            </div>
                            <span className="hidden shrink-0 text-[10.5px] font-semibold text-ink-muted lg:block">
                              {key.algorithm}
                            </span>
                            <span className="hidden shrink-0 text-[10.5px] font-semibold text-ink-muted xl:block">
                              {key.expires_at
                                ? `${isExpired(key) ? "expirée" : "expire"} le ${formatKeyDate(key.expires_at)}`
                                : "sans expiration"}
                            </span>
                            <Badge tone={key.has_secret ? "accent" : "neutral"}>{keyUsage(key)}</Badge>
                            <Badge tone={KEY_TONE[state]}>{PGP_STATE[state].label}</Badge>
                            <DButton
                              variant="plain"
                              size="sm"
                              className="size-8 px-0"
                              aria-label={`Exporter la clé publique de ${keyLabel(key)}`}
                              disabled={pending}
                              onClick={() => void copyPublicKey(key)}
                            >
                              {pending ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Download className="size-3.5" />
                              )}
                            </DButton>
                          </div>
                        );
                      })
                    )}
                  </div>
                </Surface>
              </Block>

              <Block id="ia" label="Intelligence artificielle" hint="suggestions & réécriture">
                <Surface className="space-y-3 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <SectionLabel>Modèle de décision · Système 1</SectionLabel>
                    <Badge tone={decisionReady(decision) ? "green" : "neutral"}>
                      {decisionReady(decision) ? "actif · rapide" : "inactif"}
                    </Badge>
                  </div>
                  <p className="text-[12px] font-semibold leading-relaxed text-ink-soft">
                    Triage ultra-rapide, catégories, détection TOTP, sécurité anti-phishing et filtrage avant
                    LLM. Sans modèle de décision, les modes intelligents automatiques sont désactivés ; seules
                    la réécriture, la correction et l'analyse manuelle LLM restent actives.
                  </p>
                  <div className="overflow-hidden rounded-2xl border border-line">
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
                  </div>
                  <div
                    role="group"
                    aria-label="Fournisseur du modèle de décision"
                    className="flex flex-wrap gap-1.5"
                  >
                    {DECISION_PROVIDERS.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        aria-pressed={decision.provider === entry.id}
                        onClick={() => pickDecisionProvider(entry.id)}
                        className={cn(
                          "focus-ring h-8 rounded-full border px-3 text-[12px] font-bold transition-colors",
                          decision.provider === entry.id
                            ? "border-accent bg-accent-soft text-accent-ink"
                            : "border-line bg-surface text-ink-soft hover:bg-surface-2",
                        )}
                      >
                        {entry.label}
                      </button>
                    ))}
                  </div>
                  <div className="grid gap-2.5">
                    <label className="grid gap-1">
                      <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                        Endpoint décision
                      </span>
                      <TextInput
                        aria-label="Endpoint du modèle de décision"
                        placeholder="https://api.neuralwatt.com/v1/systemone"
                        value={decision.endpoint}
                        onChange={(event) => updateDecision({ endpoint: event.target.value })}
                      />
                    </label>
                    <label className="grid gap-1">
                      <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                        Modèle décision
                      </span>
                      <TextInput
                        aria-label="Nom du modèle de décision"
                        list="decision-models"
                        placeholder="mammoth-1"
                        value={decision.model}
                        onChange={(event) => updateDecision({ model: event.target.value })}
                      />
                      <datalist id="decision-models">
                        {decisionPreset.models.map((model) => (
                          <option key={model} value={model} />
                        ))}
                      </datalist>
                    </label>
                    {decision.provider === "custom" ? (
                      <div className="grid gap-2.5 md:grid-cols-2">
                        <div>
                          <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                            Protocole
                          </span>
                          <div className="mt-1.5 flex gap-1.5">
                            {(["systemone", "jev"] as DecisionProtocol[]).map((proto) => (
                              <button
                                key={proto}
                                type="button"
                                aria-pressed={decision.protocol === proto}
                                onClick={() => updateDecision({ protocol: proto })}
                                className={cn(
                                  "focus-ring h-9 flex-1 rounded-xl border px-2 text-[11.5px] font-bold",
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
                          <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                            En-tête Auth
                          </span>
                          <div className="mt-1.5 flex gap-1.5">
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
                                  "focus-ring h-9 flex-1 rounded-xl border px-2 text-[11.5px] font-bold",
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
                      <label className="grid gap-1">
                        <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                          {decision.daemonHasKey
                            ? "Clé API décision (enregistrée au trousseau)"
                            : "Clé API décision"}
                        </span>
                        <TextInput
                          aria-label="Clé API du modèle de décision"
                          type="password"
                          placeholder={decision.daemonHasKey ? "•••••••• (remplacer la clé)" : "nw-…"}
                          value={decision.apiKey}
                          onChange={(event) => updateDecision({ apiKey: event.target.value })}
                        />
                      </label>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <DButton
                      variant="primary"
                      size="sm"
                      disabled={!decisionReady({ ...decision, enabled: true }) || decisionProbing}
                      onClick={() => void runDecisionProbe()}
                    >
                      {decisionProbing ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <PlugZap className="size-3.5" />
                      )}
                      {decisionProbing ? "Test en cours…" : "Tester le modèle de décision"}
                    </DButton>
                    {decisionProbeState ? (
                      <Badge tone={decisionProbeState.ok ? "green" : "rose"}>
                        {decisionProbeState.ok ? "connexion établie" : "échec"}
                      </Badge>
                    ) : null}
                  </div>
                  {decisionProbeState ? (
                    <p
                      className={cn(
                        "rounded-xl px-2.5 py-2 text-[12.5px] leading-relaxed font-semibold break-words",
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
                      <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                        Seuils de confiance
                      </span>
                      <button
                        type="button"
                        onClick={() => setThresholdsOpen((open) => !open)}
                        className="focus-ring rounded-full border border-line px-2.5 py-1 text-[11px] font-bold text-ink-soft hover:bg-surface-2"
                      >
                        {thresholdsOpen ? "Masquer le détail" : "Ajuster"}
                      </button>
                    </div>
                    <div
                      role="group"
                      aria-label="Profil de seuils de décision"
                      className="flex flex-wrap gap-1.5"
                    >
                      {(["prudent", "balanced", "strict"] as ThresholdPresetId[]).map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          aria-pressed={activeThresholdPreset === preset}
                          onClick={() => applyThresholdPreset(preset)}
                          className={cn(
                            "focus-ring h-8 rounded-full border px-3 text-[12px] font-bold transition-colors",
                            activeThresholdPreset === preset
                              ? "border-accent bg-accent-soft text-accent-ink"
                              : "border-line bg-surface text-ink-soft hover:bg-surface-2",
                          )}
                        >
                          {THRESHOLD_PRESETS[preset].label}
                        </button>
                      ))}
                      {activeThresholdPreset === "custom" ? (
                        <span className="inline-flex h-8 items-center rounded-full border border-accent/40 bg-accent-soft/50 px-3 text-[11.5px] font-bold text-accent-ink">
                          Personnalisé
                        </span>
                      ) : null}
                    </div>
                    {thresholdsOpen ? (
                      <div className="grid gap-2.5 rounded-2xl bg-surface-2/60 p-3 md:grid-cols-2">
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
                    <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                      Vue par défaut de la boîte
                    </span>
                    <div role="group" aria-label="Vue par défaut de la boîte" className="flex flex-wrap gap-1.5">
                      {[
                        ...INBOX_VIEWS,
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
                            "focus-ring h-8 rounded-full border px-3 text-[12px] font-bold transition-colors",
                            decision.defaultInboxFilter === view.id
                              ? "border-accent bg-accent-soft text-accent-ink"
                              : "border-line bg-surface text-ink-soft hover:bg-surface-2",
                          )}
                        >
                          {view.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1.5 border-t border-line/70 pt-3">
                    <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
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
                            "focus-ring h-8 rounded-full border px-3 text-[12px] font-bold transition-colors",
                            decision.notifMode === opt.id
                              ? "border-accent bg-accent-soft text-accent-ink"
                              : "border-line bg-surface text-ink-soft hover:bg-surface-2",
                          )}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1.5 border-t border-line/70 pt-3">
                    <label className="grid gap-1">
                      <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                        Mails récents analysés
                      </span>
                      <TextInput
                        aria-label="Nombre de mails récents analysés par le modèle de décision"
                        type="number"
                        min={RECENT_MAILS_MIN}
                        max={RECENT_MAILS_MAX}
                        value={decision.recentMailCount}
                        onChange={(event) =>
                          updateDecision({
                            recentMailCount: clampRecentMailCount(Number(event.target.value)),
                          })
                        }
                      />
                    </label>
                    <p className="text-[10.5px] font-semibold text-ink-muted">
                      Les {decision.recentMailCount} mails les plus récents passés au modèle de décision
                      (10–200)
                    </p>
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
                    <ToggleRow
                      icon={<ShieldOff className="size-4" />}
                      label="Catégorisation spam"
                      hint="Autoriser le modèle à classer des mails en spam (désactivé : moins de faux positifs)"
                      checked={decision.spamEnabled}
                      onChange={(value) => updateDecision({ spamEnabled: value })}
                    />
                  </div>
                  <div className="space-y-2 border-t border-line/70 pt-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
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
                              className={cn(
                                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold",
                                style.pill,
                              )}
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
                    <DButton
                      variant="ghost"
                      size="sm"
                      onClick={() => setCategoriesOpen(true)}
                    >
                      Gérer les catégories personnalisées
                    </DButton>
                  </div>
                  <TrustedWhitelistSection
                    trustedSenders={decision.trustedSenders}
                    trustedDomains={decision.trustedDomains}
                    onUpdate={updateDecision}
                  />
                  <ImagesAllowedSection readOnly={readOnly} />
                </Surface>

                <Surface className="mt-3 p-4">
                  <p className="text-[12px] font-semibold leading-relaxed text-ink-soft">
                    {copilotProvider
                      ? "GitHub Copilot répond par le démon, qui garde les jetons : connecte ton compte GitHub, puis choisis un modèle."
                      : "Branche un modèle compatible OpenAI pour les suggestions de réponse et la réécriture. Sans configuration, Lavande propose des réponses locales."}
                  </p>
                  <div
                    role="group"
                    aria-label="Fournisseur du modèle IA"
                    className="mt-3 flex flex-wrap gap-1.5"
                  >
                    {LLM_PROVIDERS.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        aria-pressed={providerOf(llm) === entry.id}
                        onClick={() => pickProvider(entry.id)}
                        className={cn(
                          "focus-ring h-8 rounded-full border px-3 text-[12px] font-bold transition-colors",
                          providerOf(llm) === entry.id
                            ? "border-accent bg-accent-soft text-accent-ink"
                            : "border-line bg-surface text-ink-soft hover:bg-surface-2",
                        )}
                      >
                        {entry.label}
                      </button>
                    ))}
                  </div>
                  {copilotProvider ? (
                    <div className="mt-3 grid gap-2.5">
                      <div className="rounded-xl border border-line bg-surface-2/60 p-3">
                        {copilot.connected ? (
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-[12.5px] font-semibold text-ink">
                              {`Connecté · ${copilot.login ?? "GitHub"}`}
                            </p>
                            <DButton
                              variant="soft"
                              size="sm"
                              disabled={copilot.busy}
                              onClick={() => copilot.disconnect()}
                            >
                              Se déconnecter
                            </DButton>
                          </div>
                        ) : copilot.userCode ? (
                          <div className="grid gap-2">
                            <p className="text-[12.5px] font-semibold text-ink-soft">
                              Recopie ce code sur la page GitHub ouverte :
                            </p>
                            <p className="font-mono text-[20px] font-bold tracking-[0.18em] text-ink">
                              {copilot.userCode}
                            </p>
                            <div className="flex flex-wrap items-center gap-2">
                              <DButton
                                variant="soft"
                                size="sm"
                                onClick={() =>
                                  copilot.verificationUri && openExternal(copilot.verificationUri)
                                }
                              >
                                Ouvrir la page GitHub
                              </DButton>
                              <Badge tone="sky">en attente de validation…</Badge>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-[12.5px] font-semibold text-ink-soft">
                              Aucun compte GitHub connecté.
                            </p>
                            <DButton
                              variant="primary"
                              size="sm"
                              disabled={copilot.busy}
                              onClick={() => copilot.connect()}
                            >
                              {copilot.busy ? "Connexion…" : "Se connecter à GitHub"}
                            </DButton>
                          </div>
                        )}
                        {copilot.error ? (
                          <p className="mt-2 rounded-xl bg-rose-500/10 px-2.5 py-2 text-[12.5px] leading-relaxed font-semibold break-words text-rose-600 dark:text-rose-300">
                            {copilot.error}
                          </p>
                        ) : null}
                      </div>
                      <label className="grid gap-1">
                        <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Modèle</span>
                        <TextInput
                          aria-label="Nom du modèle"
                          list="copilot-models"
                          placeholder="gpt-4o"
                          value={llm.model}
                          onChange={(event) => updateLlm({ model: event.target.value })}
                        />
                        <datalist id="copilot-models">
                          {(models.length > 0 ? models : copilotModels()).map((model) => (
                            <option key={model} value={model} />
                          ))}
                        </datalist>
                      </label>
                      <label className="grid gap-1">
                        <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                          Client ID GitHub Copilot
                        </span>
                        <TextInput
                          aria-label="Client ID GitHub Copilot"
                          placeholder={DEFAULT_COPILOT_CLIENT_ID}
                          value={llm.copilotClientId ?? ""}
                          onChange={(event) => updateLlm({ copilotClientId: event.target.value })}
                        />
                        <span className="text-[11px] font-medium text-ink-muted">
                          Vide · l'application Copilot par défaut est utilisée.
                        </span>
                      </label>
                    </div>
                  ) : (
                    <div className="mt-3 grid gap-2.5">
                      <label className="grid gap-1">
                        <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Endpoint</span>
                        <TextInput
                          aria-label="Endpoint du modèle"
                          placeholder="https://api.openai.com/v1"
                          value={llm.endpoint}
                          onChange={(event) => updateLlm({ endpoint: event.target.value })}
                        />
                      </label>
                      <label className="grid gap-1">
                        <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Modèle</span>
                        <TextInput
                          aria-label="Nom du modèle"
                          list="llm-models"
                          placeholder="gpt-4o-mini"
                          value={llm.model}
                          onChange={(event) => updateLlm({ model: event.target.value })}
                        />
                        <datalist id="llm-models">
                          {models.map((model) => (
                            <option key={model} value={model} />
                          ))}
                        </datalist>
                      </label>
                      <label className="grid gap-1">
                        <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Clé API</span>
                        <TextInput
                          aria-label="Clé API"
                          type="password"
                          placeholder="sk-…"
                          value={llm.apiKey}
                          onChange={(event) => updateLlm({ apiKey: event.target.value })}
                        />
                      </label>
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <DButton
                      variant="primary"
                      size="sm"
                      disabled={!llmReady(llm) || probing}
                      onClick={() => void runProbe()}
                    >
                      {probing ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <PlugZap className="size-3.5" />
                      )}
                      {probing ? "Test en cours…" : "Tester la connexion"}
                    </DButton>
                    {copilotProvider ? null : (
                      <DButton
                        variant="soft"
                        size="sm"
                        disabled={!llm.endpoint.trim() || !llm.apiKey.trim() || loadingModels}
                        onClick={() => void loadModels()}
                      >
                        {loadingModels ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="size-3.5" />
                        )}
                        {loadingModels ? "Chargement…" : "Charger les modèles"}
                      </DButton>
                    )}
                    {probe ? (
                      <Badge tone={probe.ok ? "green" : "rose"}>
                        {probe.ok ? "connexion établie" : "échec"}
                      </Badge>
                    ) : null}
                    {models.length > 0 ? (
                      <Badge tone="sky">{`${models.length} modèle(s) disponible(s)`}</Badge>
                    ) : null}
                  </div>
                  {modelsError ? (
                    <p className="mt-2 rounded-xl bg-rose-500/10 px-2.5 py-2 text-[12.5px] leading-relaxed font-semibold break-words text-rose-600 dark:text-rose-300">
                      {`Liste indisponible · ${modelsError}`}
                    </p>
                  ) : null}
                  {probe ? (
                    <p
                      className={cn(
                        "mt-2 rounded-xl px-2.5 py-2 text-[12.5px] leading-relaxed font-semibold break-words",
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
                  <p className="mt-2.5 text-[12.5px] leading-snug font-semibold text-ink-muted">
                    {llmReady(llm)
                      ? "IA active · les propositions utilisent le modèle configuré."
                      : "IA inactive · propositions locales uniquement."}
                  </p>
                </Surface>

                <Surface className="mt-3 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Consommation</p>
                    <Badge tone={aiUsage.devices > 1 ? "accent" : "neutral"}>
                      {aiUsage.devices > 1 ? `tous appareils · ${aiUsage.devices}` : "cet appareil"}
                    </Badge>
                  </div>
                  <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-xl bg-surface-2 px-2 py-2">
                      <dt className="text-[10px] font-bold tracking-[0.1em] text-ink-muted uppercase">Appels LLM</dt>
                      <dd className="text-[15px] font-extrabold text-ink">
                        {formatTokens(aiUsage.combined.total.calls)}
                      </dd>
                    </div>
                    <div className="rounded-xl bg-surface-2 px-2 py-2">
                      <dt className="text-[10px] font-bold tracking-[0.1em] text-ink-muted uppercase">Entrée</dt>
                      <dd className="text-[15px] font-extrabold text-ink">
                        {formatTokens(aiUsage.combined.total.prompt)}
                      </dd>
                    </div>
                    <div className="rounded-xl bg-surface-2 px-2 py-2">
                      <dt className="text-[10px] font-bold tracking-[0.1em] text-ink-muted uppercase">Sortie</dt>
                      <dd className="text-[15px] font-extrabold text-ink">
                        {formatTokens(aiUsage.combined.total.completion)}
                      </dd>
                    </div>
                  </dl>
                  <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
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
                    <ul className="mt-3 space-y-1">
                      {aiModels.map((entry) => (
                        <li key={entry.model} className="flex items-center justify-between gap-2 text-[12px] font-semibold text-ink-soft">
                          <span className="truncate">{entry.model}</span>
                          <span className="shrink-0 text-ink-muted">
                            {`${formatTokens(entry.usage.calls)} appel(s) · ${formatTokens(entry.usage.prompt + entry.usage.completion)} tokens`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-[12px] font-semibold text-ink-muted">
                      Aucun appel enregistré · les tokens sont comptés à chaque réponse du modèle.
                    </p>
                  )}
                  <div className="mt-3 flex items-end justify-between gap-1.5">
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
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <span className="text-[11.5px] font-semibold text-ink-muted">7 derniers jours · 90 jours conservés</span>
                    <DButton
                      variant="ghost"
                      size="sm"
                      aria-label="Réinitialiser la consommation"
                      onClick={() => resetAiStats()}
                    >
                      <RotateCcw className="size-3.5" />
                      Réinitialiser
                    </DButton>
                  </div>
                </Surface>

                <Surface className="mt-3 divide-y divide-line overflow-hidden">
                  <ToggleRow
                    icon={<Sparkles className="size-4" />}
                    label="Suggestions de réponse IA"
                    hint="Le modèle lit toute la conversation du fil · désactivable, repli sur les réponses locales"
                    checked={aiReplyEnabled}
                    onChange={setAiReplyEnabled}
                  />
                </Surface>
              </Block>

              <Block
                id="resumes"
                label="Résumés"
                hint={
                  summaryConfig.enabled
                    ? summaryConfig.mode === "rolling"
                      ? `non lus · ${summaryConfig.rollingDays} j`
                      : "matin · midi · soir"
                    : "désactivés"
                }
              >
                <Surface className="divide-y divide-line overflow-hidden">
                  <ToggleRow
                    icon={<Sparkles className="size-4" />}
                    label={summaryConfig.mode === "rolling" ? "Résumé des non lus" : "Résumés périodiques"}
                    hint={
                      summaryConfig.mode === "rolling"
                        ? "Les mails non lus des N derniers jours"
                        : "Un résumé de la boîte de réception matin, midi et soir"
                    }
                    checked={summaryConfig.enabled}
                    onChange={(value) => setSummary({ enabled: value })}
                  />
                  <ToggleRow
                    icon={<Lock className="size-4" />}
                    label="Autoriser l'analyse de mes mails par le LLM"
                    hint="Sans accord, le résumé reste local (compteurs et expéditeurs)"
                    checked={summaryConfig.llmConsent}
                    onChange={(value) => setSummary({ llmConsent: value })}
                  />
                </Surface>

                <Surface className="mt-3 p-4">
                  <SectionLabel>Fenêtre du résumé</SectionLabel>
                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    {SUMMARY_MODES.map((option) => {
                      const selected = summaryConfig.mode === option.id;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setSummary({ mode: option.id })}
                          className={cn(
                            "focus-ring flex h-10 items-center justify-center rounded-[14px] text-[12px] font-bold transition-colors duration-200",
                            selected
                              ? "bg-accent-soft text-accent-ink ring-1 ring-accent-ring/60"
                              : "border border-line bg-surface text-ink-soft hover:text-ink",
                          )}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1.5 text-[12.5px] leading-snug font-medium text-ink-muted">
                    {SUMMARY_MODES.find((option) => option.id === summaryConfig.mode)?.hint}
                  </p>
                </Surface>

                <Surface className="mt-3 p-4">
                  <p className="text-[12px] leading-relaxed font-semibold text-ink-soft">
                    Avec votre accord, seuls l'expéditeur, l'objet et les premières lignes des messages de
                    la période sont envoyés au modèle configuré, sans pièce jointe ni action possible. Le
                    texte renvoyé est affiché tel quel, et les tâches qu'il propose restent des suggestions
                    à valider.
                  </p>
                  {summaryConfig.mode === "rolling" ? (
                    <label className="mt-3 grid gap-1">
                      <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                        Mails non lus depuis
                      </span>
                      <TextInput
                        aria-label="Nombre de jours de mails non lus"
                        type="number"
                        min={1}
                        max={90}
                        value={summaryConfig.rollingDays}
                        onChange={(event) => setSummary({ rollingDays: clampDays(event.target.value) })}
                      />
                    </label>
                  ) : (
                    <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                      {([
                        { key: "morningStart", label: "Matin" },
                        { key: "middayStart", label: "Midi" },
                        { key: "eveningStart", label: "Soir" },
                      ] as const).map((field) => (
                        <label key={field.key} className="grid gap-1">
                          <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                            {field.label} · début (h)
                          </span>
                          <TextInput
                            aria-label={`Heure de début du résumé ${field.label.toLowerCase()}`}
                            type="number"
                            min={0}
                            max={23}
                            value={summaryConfig[field.key]}
                            onChange={(event) => setSummary(hourPatch(field.key, event.target.value))}
                          />
                        </label>
                      ))}
                      <label className="grid gap-1">
                        <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                          Fenêtre (h)
                        </span>
                        <TextInput
                          aria-label="Fenêtre du résumé du matin en heures"
                          type="number"
                          min={1}
                          max={72}
                          value={summaryConfig.lookbackHours}
                          onChange={(event) =>
                            setSummary({ lookbackHours: clampHours(event.target.value, 72) })
                          }
                        />
                      </label>
                    </div>
                  )}
                  <p className="mt-3 text-[10.5px] font-semibold text-ink-muted">
                    {llmReady(llm)
                      ? summaryConfig.llmConsent
                        ? "Modèle configuré · les résumés sont analysés par l'IA."
                        : "Modèle configuré · en attente de votre accord pour l'analyse."
                      : "Aucun modèle configuré · les résumés restent locaux (section IA)."}
                  </p>
                </Surface>
              </Block>

              <Block
                id="taches-ia"
                label="Suggestions de tâches"
                hint={aiTasks.enabled ? `mails des ${aiTasks.windowHours} h` : "désactivées"}
              >
                <Surface className="divide-y divide-line overflow-hidden">
                  <ToggleRow
                    icon={<ListChecks className="size-4" />}
                    label="Suggestions de tâches IA"
                    hint="Extraire des tâches actionnables des mails de la fenêtre · tout reste à valider"
                    checked={aiTasks.enabled}
                    onChange={(value) => setAiTasks({ enabled: value })}
                  />
                  <ToggleRow
                    icon={<CalendarDays className="size-4" />}
                    label="Suggestions de rendez-vous IA"
                    hint="Extraire aussi des RDV (titre, date, heure, lieu) des mêmes mails · à valider dans l'agenda"
                    checked={aiTasks.events}
                    onChange={(value) => setAiTasks({ events: value })}
                  />
                </Surface>

                <Surface className="mt-3 p-4">
                  <label className="grid gap-1">
                    <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
                      Fenêtre des mails (heures)
                    </span>
                    <TextInput
                      aria-label="Fenêtre des mails analysés pour les suggestions de tâches"
                      type="number"
                      min={1}
                      max={168}
                      value={aiTasks.windowHours}
                      onChange={(event) => setAiTasks({ windowHours: clampWindowHours(event.target.value) })}
                    />
                  </label>
                  <p className="mt-3 text-[10.5px] font-semibold text-ink-muted">
                    Le LLM analyse vos mails récents pour proposer des tâches ; aucune tâche n'est créée sans
                    votre validation.
                  </p>
                  <p className="mt-1.5 text-[10.5px] font-semibold text-ink-muted">
                    {llmReady(llm)
                      ? aiTasks.enabled
                        ? "Modèle configuré · les suggestions sont générées à partir des mails de la fenêtre."
                        : "Modèle configuré · suggestions de tâches désactivées."
                      : "Aucun modèle configuré · aucune suggestion générée (section IA)."}
                  </p>
                </Surface>

                <Surface className="mt-3 divide-y divide-line overflow-hidden">
                  <div className="flex items-center gap-2 px-3.5 py-2">
                    <SectionLabel>Par compte</SectionLabel>
                    <span className="text-[12px] font-semibold text-ink-muted">
                      {analyzedAccounts.length} sur {accounts.length}
                    </span>
                  </div>
                  {accounts.length === 0 ? (
                    <p className="px-3.5 py-2 text-[12px] leading-snug font-semibold text-ink-muted">
                      Ajoute un compte pour l'exclure des suggestions.
                    </p>
                  ) : (
                    accounts.map((item) => (
                      <ToggleRow
                        key={item.id}
                        icon={<span className="size-2 rounded-full" style={{ backgroundColor: item.color }} />}
                        label={item.label}
                        hint={
                          aiTasks.excludedAccounts.includes(item.id)
                            ? "Exclu · ses mails ne produisent aucune suggestion"
                            : "Analysé par l'IA"
                        }
                        checked={!aiTasks.excludedAccounts.includes(item.id)}
                        onChange={(value) =>
                          setAiTasks({
                            excludedAccounts: value
                              ? aiTasks.excludedAccounts.filter((id) => id !== item.id)
                              : [...aiTasks.excludedAccounts, item.id],
                          })
                        }
                      />
                    ))
                  )}
                </Surface>
              </Block>

              {import.meta.env.VITE_PLATFORM === "android" ? null : (
                <Block
                  id="assistant"
                  label="Serveurs MCP"
                  hint={`${counts.activeServers} actifs · ${counts.activeTools} outils`}
                >
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { label: "Serveurs actifs", value: counts.activeServers, icon: Blocks },
                      { label: "Outils actifs", value: counts.activeTools, icon: Terminal },
                      { label: "Outils installés", value: counts.installedTools, icon: Globe },
                    ].map((stat) => {
                      const Icon = stat.icon;
                      return (
                        <Surface key={stat.label} className="p-3">
                          <Icon className="size-3.5 text-accent-ink" />
                          <p className="mt-1.5 text-[19px] leading-none font-extrabold tracking-[-0.035em] text-ink">
                            <NumberTicker value={stat.value} />
                          </p>
                          <p className="mt-0.5 text-[10.5px] font-semibold text-ink-muted">{stat.label}</p>
                        </Surface>
                      );
                    })}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    {MCP_SCOPES.map((scope) => (
                      <span key={scope.id} className="inline-flex items-center gap-1.5">
                        <Badge tone={SCOPE_TONE[scope.id]}>{scope.id}</Badge>
                        <span className="text-[10.5px] font-medium text-ink-muted">{scope.hint}</span>
                      </span>
                    ))}
                  </div>

                  <Surface className="mt-3 divide-y divide-line overflow-hidden">
                    {MCP_SERVERS.map((server) => {
                      const isOn = enabled[server.id];
                      const openTools = openServer === server.id;
                      return (
                        <div key={server.id}>
                          <div className="flex items-center gap-3 px-3.5 py-2.5">
                            <span
                              className={cn(
                                "size-2 shrink-0 rounded-full",
                                isOn ? "bg-emerald-500" : "bg-ink-muted/40",
                              )}
                            />
                            <div className="min-w-0 flex-1 leading-tight">
                              <p className="truncate text-[12px] font-bold text-ink">{server.name}</p>
                              <p className="line-clamp-2 text-[12px] leading-snug font-medium text-ink-muted">{server.description}</p>
                            </div>
                            <span className="hidden shrink-0 items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-bold tracking-wide text-ink-muted uppercase sm:inline-flex">
                              {server.transport === "stdio" ? (
                                <Terminal className="size-2.5" />
                              ) : (
                                <Globe className="size-2.5" />
                              )}
                              {server.transport}
                            </span>
                            <button
                              type="button"
                              aria-expanded={openTools}
                              onClick={() => setOpenServer(openTools ? null : server.id)}
                              className="focus-ring flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-bold text-ink-muted tabular-nums transition-colors hover:text-ink-soft"
                            >
                              {server.tools.length} outils
                              <ChevronDown
                                className={cn("size-2.5 transition-transform duration-200", openTools && "rotate-180")}
                              />
                            </button>
                            <Switch
                              checked={isOn}
                              onChange={(value) => setMcpEnabled(server.id, value)}
                              label={server.name}
                            />
                          </div>
                          {openTools ? (
                            <ul className="space-y-1 border-t border-line/70 bg-surface-2/40 px-3.5 py-2 pl-9">
                              {server.tools.map((tool) => (
                                <li key={tool.name} className="flex items-baseline gap-2">
                                  <code className="shrink-0 text-[11.5px] font-bold text-ink-soft">{tool.name}</code>
                                  <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-ink-muted">
                                    {tool.description}
                                  </span>
                                  <Badge tone={SCOPE_TONE[tool.scope]}>{tool.scope}</Badge>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      );
                    })}
                  </Surface>

                  <Surface className="mt-3 overflow-hidden">
                    <div className="flex items-center gap-2 border-b border-line px-3.5 py-2">
                      <SectionLabel>Toujours autoriser</SectionLabel>
                      <span className="text-[10.5px] font-semibold text-ink-muted">
                        par type d'action
                      </span>
                      <DButton variant="plain" size="sm" className="ml-auto" onClick={resetMcpAllowances}>
                        <RotateCcw className="size-3" />
                        Tout redemander
                      </DButton>
                    </div>
                    <div className="divide-y divide-line/70">
                      {MCP_ACTION_TYPES.map((action) => {
                        const isAllowed = mcpTypeAllowed(action.id, allowances);
                        return (
                          <div key={action.id} className="flex items-center gap-3 px-3.5 py-2">
                            <div className="min-w-0 flex-1 leading-tight">
                              <p className="text-[11.5px] font-bold text-ink">{action.id}</p>
                              <p className="text-[10.5px] font-medium text-ink-muted">{action.hint}</p>
                            </div>
                            <Switch
                              checked={isAllowed}
                              onChange={(value) => setMcpAlwaysAllow(action.id, value)}
                              label={`Toujours autoriser · ${action.id}`}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </Surface>

                  <Surface className="mt-3 overflow-x-auto">
                    {log.length === 0 ? (
                      <p className="px-3.5 py-4 text-[11px] font-medium text-ink-muted">
                        Aucune action journalisée.
                      </p>
                    ) : (
                      <table className="w-full border-collapse text-left">
                        <thead>
                          <tr className="border-b border-line bg-surface-2/60 text-[10px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                            <th className="px-3 py-2 font-bold">Heure</th>
                            <th className="py-2 pr-3 font-bold">Serveur</th>
                            <th className="py-2 pr-3 font-bold">Outil</th>
                            <th className="py-2 pr-3 font-bold">Verdict</th>
                            <th className="py-2 pr-3 font-bold">Type</th>
                            <th className="py-2 pr-3 font-bold">Détail</th>
                          </tr>
                        </thead>
                        <tbody>
                          {log.map((entry, index) => (
                            <tr key={`${entry.time}-${index}`} className="border-b border-line/70 last:border-0">
                              <td className="px-3 py-2 font-mono text-[11px] font-semibold text-ink-muted tabular-nums">
                                {mcpLogClock(entry.time)}
                              </td>
                              <td className="py-2 pr-3 text-[11.5px] font-semibold text-ink-soft">
                                <span className="block truncate">{entry.server}</span>
                                <span className="block truncate text-[10px] font-medium text-ink-muted">
                                  {entry.agent}
                                </span>
                              </td>
                              <td className="py-2 pr-3 font-mono text-[11px] font-bold text-accent-ink">{entry.tool}</td>
                              <td className="py-2 pr-3">
                                <Badge tone={LOG_TONE[entry.status]}>{entry.status}</Badge>
                              </td>
                              <td className="py-2 pr-3 text-[10.5px] font-semibold text-ink-muted">
                                {mcpActionType(entry.tool) ?? "lecture"}
                              </td>
                              <td className="min-w-[220px] py-2 pr-3 text-[11px] font-medium break-words text-ink-soft">
                                {entry.detail}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </Surface>
                </Block>
              )}

              <Block id="clavier" label="Raccourcis clavier" hint={mod === "meta" ? "⌘ sur Mac" : "Ctrl sur cet appareil"}>
                <Surface className="px-1 py-1">
                  <ShortcutList shortcuts={shortcutList} mod={mod} />
                </Surface>
              </Block>

              <Block
                id="mise-a-jour"
                label="Mise à jour"
                hint={`v${installedVersion}`}
              >
                <Surface className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="leading-tight">
                      <SectionLabel>Version installée</SectionLabel>
                      <p className="mt-1 text-[15px] font-extrabold tracking-[-0.02em] text-ink tabular-nums">
                        v{installedVersion}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <DButton
                        variant="soft"
                        size="sm"
                        disabled={!updater.supported || updater.busy}
                        onClick={() => void updater.check()}
                      >
                        <RefreshCw
                          className={cn("size-3.5", updater.phase.kind === "checking" && "animate-spin")}
                        />
                        Vérifier les mises à jour
                      </DButton>
                      {updater.canInstall ? (
                        <DButton
                          variant="primary"
                          size="sm"
                          disabled={updater.busy}
                          onClick={() => void updater.install()}
                        >
                          <Download className="size-3.5" />
                          Installer et redémarrer
                        </DButton>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Badge tone={updateState.tone}>{updateState.label}</Badge>
                    {updater.phase.kind === "current" ? (
                      <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-ink-muted">
                        <Check className="size-3" strokeWidth={3} />
                        Aucune version plus récente sur le serveur.
                      </span>
                    ) : null}
                  </div>

                  {updater.phase.kind === "downloading" ? (
                    <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
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
                    <p className="mt-2.5 max-h-40 overflow-y-auto rounded-xl bg-surface-2/70 px-2.5 py-2 text-[11px] leading-relaxed font-medium whitespace-pre-line text-ink-soft">
                      {updater.phase.notes}
                    </p>
                  ) : null}

                  {updater.phase.kind === "error" ? (
                    <p className="mt-2.5 flex items-start gap-1.5 rounded-xl bg-rose-500/10 px-2.5 py-2 text-[10.5px] font-semibold text-rose-600 dark:text-rose-300">
                      <AlertTriangle className="mt-px size-3.5 shrink-0" />
                      {updater.phase.message}
                    </p>
                  ) : null}

                  <div className="mt-3 border-t border-line/70 pt-2">
                    <ToggleRow
                      icon={<RefreshCw className="size-4" />}
                      label="Vérification automatique"
                      hint="Fréquence de vérification ci-dessous"
                      checked={updates.autoCheck}
                      onChange={(value) => setUpdates({ autoCheck: value })}
                    />
                    {updates.autoCheck ? (
                      <div className="px-3.5 pt-2">
                        <SectionLabel>Fréquence de vérification</SectionLabel>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {UPDATE_INTERVALS.map((hours) => (
                            <DChip
                              key={hours}
                              active={updates.intervalHours === hours}
                              onClick={() => setUpdates({ intervalHours: hours })}
                            >
                              {updateIntervalLabel(hours)}
                            </DChip>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <p className="mt-3 text-[10.5px] leading-relaxed font-semibold text-ink-muted">
                    {updater.supported
                      ? "Le paquet est signé et vérifié avant installation ; l'application redémarre ensuite sur la nouvelle version."
                      : "La mise à jour automatique n'existe que dans l'application installée (bureau ou Android), pas dans le navigateur."}
                  </p>
                </Surface>
              </Block>

              <Block id="apropos" label="À propos">
                <Surface className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="leading-tight">
                    <p className="text-[12.5px] font-bold text-ink">{brand} · v0.1.0</p>
                    <p className="mt-0.5 text-[11.5px] font-medium text-ink-muted">
                      React 19 · Vite 7 · Tailwind 4 · Tauri v2
                    </p>
                  </div>
                  {import.meta.env.VITE_DISTRIBUTION === "1" ? null : (
                    <a
                      href={window.location.pathname}
                      className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[11.5px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
                    >
                      Aperçu de la maquette mobile
                      <ArrowRight className="size-3.5" />
                    </a>
                  )}
                </Surface>
              </Block>
            </BlurFade>
          </ActiveSectionContext.Provider>
        </div>
      </div>

      <CategoryManagerSheet
        open={categoriesOpen}
        onClose={() => setCategoriesOpen(false)}
        onRetriage={() => triageMails(mails, true)}
      />
    </div>
  );
}

function Block({
  id,
  label,
  hint,
  children,
}: {
  id: SectionId;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const active = useContext(ActiveSectionContext);
  if (id !== active) return null;
  return (
    <section id={anchor(id)}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[19px] font-extrabold tracking-[-0.03em] text-ink">{label}</h2>
        {hint ? <span className="text-[10.5px] font-semibold text-ink-muted">{hint}</span> : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}
