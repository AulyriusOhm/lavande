import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Blocks,
  CalendarDays,
  Check,
  ChevronDown,
  Download,
  Globe,
  KeyRound,
  ListChecks,
  Loader2,
  Lock,
  Moon,
  PenLine,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
} from "lucide-react";
import { errorText } from "@/lib/api";
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
import { MCP_LOG, MCP_SCOPES, MCP_SERVERS, mcpCounts } from "@/lib/mcp";
import type { McpLogEntry } from "@/lib/mcp";
import { activeSignature, mergeFlags, usePrefs } from "@/lib/prefs";
import { llmReady } from "@/lib/llm";
import { ACCENT_PRESETS, useTheme } from "@/lib/theme";
import { useMailStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Avatar, Switch, ToggleRow } from "@/components/ui/primitives";
import { SignatureEditor } from "@/components/signature-editor";
import { SyncSettings } from "@/components/sync-settings";
import { BlurFade } from "@/components/ui/blur-fade";
import { NumberTicker } from "@/components/ui/number-ticker";
import {
  Badge,
  DChip,
  DButton,
  PaneTitle,
  SectionLabel,
  Surface,
  TextInput,
} from "@/desktop/ui";

const KEY_TONE = { valid: "green", expired: "amber", revoked: "rose" } as const;

const SCOPE_TONE = { lecture: "neutral", écriture: "amber", signature: "green" } as const;

const SECTIONS = [
  { id: "comptes", label: "Comptes" },
  { id: "signatures", label: "Signatures" },
  { id: "apparence", label: "Apparence" },
  { id: "modules", label: "Modules" },
  { id: "securite", label: "Sécurité" },
  { id: "synchronisation", label: "Synchronisation" },
  { id: "ia", label: "IA" },
  { id: "assistant", label: "Serveurs MCP" },
  { id: "apropos", label: "À propos" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const anchor = (id: SectionId) => `reglages-${id}`;

const serverName = (tool: string) =>
  MCP_SERVERS.find((server) => server.tools.some((entry) => entry.name === tool))?.name ?? "hors ligne";

const durationOf = (entry: McpLogEntry) => `${18 + ((entry.detail.length * 7) % 240)} ms`;

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

export function DesktopSettings() {
  const { accent, dark, brand, setAccent, setDark, reset } = useTheme();
  const {
    pgpEncrypt,
    pgpSign,
    attachPublicKey,
    setPgpEncrypt,
    setPgpSign,
    setAttachPublicKey,
    mcpConfirmSend,
    setMcpConfirmSend,
    calendarEnabled,
    planningEnabled,
    setCalendarEnabled,
    setPlanningEnabled,
    mcpEnabled,
    setMcpEnabled,
    signatures,
    llm,
    setLlm,
  } = usePrefs();
  const { notify, accounts, mode, openConnect, askRemoveAccount } = useMailStore();
  const [active, setActive] = useState<SectionId>("comptes");
  const [hex, setHex] = useState(accent);
  const [openServer, setOpenServer] = useState<string | null>(null);
  const [signatureAccount, setSignatureAccount] = useState<string | null>(null);
  const [generateForm, setGenerateForm] = useState(false);
  const [generateName, setGenerateName] = useState("");
  const [generateEmail, setGenerateEmail] = useState("");
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const { keys, error: keysError, loading: keysLoading, load: loadKeys } = usePgpKeys();

  useEffect(() => setHex(accent), [accent]);

  const enabled = mergeFlags(
    Object.fromEntries(MCP_SERVERS.map((server) => [server.id, server.status === "connected"])),
    mcpEnabled,
  );
  const counts = mcpCounts((server) => enabled[server.id]);
  const myKey = keys?.find((key) => key.has_secret) ?? null;
  const myState = myKey ? keyState(myKey) : null;
  const expiringSoon = myKey ? !isExpired(myKey) && isExpired(myKey, new Date(Date.now() + 90 * 864e5)) : false;
  const publicKeys = keys?.filter((key) => !key.has_secret).length ?? 0;
  const signatureTarget = accounts.find((item) => item.id === signatureAccount) ?? accounts[0] ?? null;
  const signedAccounts = accounts.filter((item) => activeSignature(signatures, item.id)).length;

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

  const goTo = (id: SectionId) => {
    setActive(id);
    document.getElementById(anchor(id))?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const track = (event: React.UIEvent<HTMLDivElement>) => {
    const line = event.currentTarget.getBoundingClientRect().top + 120;
    let current: SectionId = SECTIONS[0].id;
    for (const section of SECTIONS) {
      const node = document.getElementById(anchor(section.id));
      if (node && node.getBoundingClientRect().top <= line) current = section.id;
    }
    if (current !== active) setActive(current);
  };

  const updateHex = (value: string) => {
    setHex(value);
    const clean = value.trim();
    if (!/^#?[0-9a-f]{6}$/i.test(clean)) return;
    setAccent(clean.startsWith("#") ? clean.toLowerCase() : `#${clean.toLowerCase()}`);
  };

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto no-scrollbar" onScroll={track}>
        <div className="mx-auto max-w-[1080px] px-8 pb-32">
          <header className="flex items-center justify-between gap-4 pt-6">
            <div className="flex items-center gap-2.5">
              <PaneTitle hint="maquette PC">Réglages</PaneTitle>
              <Badge tone="accent">{brand}</Badge>
            </div>
            <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">v0.1.0</span>
          </header>

          <div className="mt-6 flex items-start gap-8">
            <nav aria-label="Sections des réglages" className="sticky top-6 w-[200px] shrink-0">
              <ul className="space-y-0.5">
                {SECTIONS.map((section) => (
                  <li key={section.id}>
                    <button
                      type="button"
                      onClick={() => goTo(section.id)}
                      aria-current={active === section.id}
                      className={cn(
                        "focus-ring flex h-8 w-full items-center rounded-[10px] px-2.5 text-left text-[12px] font-semibold transition-colors duration-200",
                        active === section.id
                          ? "bg-accent-soft text-accent-ink"
                          : "text-ink-soft hover:bg-surface-2 hover:text-ink",
                      )}
                    >
                      {section.label}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>

            <div className="min-w-0 flex-1 space-y-7">
              <Block id="comptes" label="Comptes" hint={`${accounts.length} compte${accounts.length > 1 ? "s" : ""}`}>
                <BlurFade delay={0.04}>
                  <div className="grid gap-3 md:grid-cols-2">
                    {accounts.map((item, index) => (
                      <Surface key={item.id} className="p-3.5">
                        <div className="flex items-center gap-2.5">
                          <span
                            className="grid size-9 shrink-0 place-items-center rounded-[12px] text-[12px] font-black text-white"
                            style={{ backgroundColor: item.color }}
                          >
                            {item.label[0]}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <p className="truncate text-[12.5px] font-bold text-ink">{item.label}</p>
                              {index === 0 ? <Badge tone="accent">Principal</Badge> : null}
                            </div>
                            <p className="truncate text-[11px] font-medium text-ink-muted">{item.email}</p>
                          </div>
                        </div>
                        <div className="mt-2.5 flex items-center justify-between gap-2">
                          <span className="truncate text-[10.5px] font-semibold text-ink-soft">{item.provider}</span>
                          <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-semibold text-ink-muted">
                            <RefreshCw className="size-3" />
                            {item.synced}
                          </span>
                        </div>
                        {mode === "api" && (
                          <div className="mt-2 flex justify-end">
                            <DButton
                              variant="danger"
                              size="sm"
                              onClick={() => askRemoveAccount(item)}
                            >
                              <Trash2 className="size-3.5" />
                              Retirer
                            </DButton>
                          </div>
                        )}
                      </Surface>
                    ))}
                    <button
                      type="button"
                      onClick={openConnect}
                      className="focus-ring flex min-h-[88px] items-center justify-center gap-2 rounded-[26px] border border-dashed border-line bg-surface/60 text-[12px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
                    >
                      <Plus className="size-4" strokeWidth={3} />
                      Ajouter un compte
                    </button>
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

              <Block id="apparence" label="Apparence" hint={brand}>
                <div className="grid gap-3 md:grid-cols-2">
                  <Surface className="p-4">
                    <SectionLabel>Thème</SectionLabel>
                    <div className="mt-2 grid grid-cols-2 gap-1.5">
                      {[
                        { label: "Clair", icon: Sun, value: false },
                        { label: "Sombre", icon: Moon, value: true },
                      ].map((option) => {
                        const Icon = option.icon;
                        const selected = dark === option.value;
                        return (
                          <button
                            key={option.label}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => setDark(option.value)}
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
                        <p className="mt-1.5 font-mono text-[10.5px] leading-relaxed font-semibold break-all text-ink-soft">
                          {formatFingerprint(myKey.fingerprint)}
                        </p>
                        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10.5px]">
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
                          <p className="mt-2.5 flex items-start gap-1.5 rounded-xl bg-amber-500/12 px-2.5 py-2 text-[10.5px] font-semibold text-amber-700 dark:text-amber-300">
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

                  <Surface className="divide-y divide-line overflow-hidden">
                    <ToggleRow
                      icon={<Lock className="size-4" />}
                      label="Chiffrer les messages"
                      hint="Quand une clé valide existe pour chaque destinataire"
                      checked={pgpEncrypt}
                      onChange={setPgpEncrypt}
                    />
                    <ToggleRow
                      icon={<PenLine className="size-4" />}
                      label="Signer mes messages"
                      hint="Signature détachée, vérifiable"
                      checked={pgpSign}
                      onChange={setPgpSign}
                    />
                    <ToggleRow
                      icon={<KeyRound className="size-4" />}
                      label="Joindre ma clé publique"
                      hint="Aux nouveaux destinataires"
                      checked={attachPublicKey}
                      onChange={setAttachPublicKey}
                    />
                    <ToggleRow
                      icon={<ShieldCheck className="size-4" />}
                      label="Confirmer avant chaque envoi"
                      hint="mail.send et les écritures attendent ta validation"
                      checked={mcpConfirmSend}
                      onChange={setMcpConfirmSend}
                    />
                  </Surface>
                </div>

                <Surface className="mt-3 overflow-hidden">
                  <div className="flex items-center gap-2 border-b border-line px-3.5 py-2">
                    <SectionLabel>Clés</SectionLabel>
                    <span className="text-[10.5px] font-semibold text-ink-muted">
                      {keys === null
                        ? "chargement…"
                        : `${keys.filter((key) => key.has_secret).length} secrète(s) · ${publicKeys} publique(s)`}
                    </span>
                    <DButton
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
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
                              <p className="truncate font-mono text-[10px] font-medium text-ink-muted">
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

              <Block id="synchronisation" label="Synchronisation" hint="chiffré de bout en bout">
                <SyncSettings variant="desktop" />
              </Block>

              <Block id="ia" label="Intelligence artificielle" hint="suggestions & réécriture">
                <Surface className="p-4">
                  <p className="text-[12px] font-semibold leading-relaxed text-ink-soft">
                    Branche un modèle compatible OpenAI pour les suggestions de réponse et la réécriture.
                    Sans configuration, Lavande propose des réponses locales.
                  </p>
                  <div className="mt-3 grid gap-2.5">
                    <label className="grid gap-1">
                      <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Endpoint</span>
                      <TextInput
                        aria-label="Endpoint du modèle"
                        placeholder="https://api.openai.com/v1"
                        value={llm.endpoint}
                        onChange={(event) => setLlm({ endpoint: event.target.value })}
                      />
                    </label>
                    <label className="grid gap-1">
                      <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Modèle</span>
                      <TextInput
                        aria-label="Nom du modèle"
                        placeholder="gpt-4o-mini"
                        value={llm.model}
                        onChange={(event) => setLlm({ model: event.target.value })}
                      />
                    </label>
                    <label className="grid gap-1">
                      <span className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Clé API</span>
                      <TextInput
                        aria-label="Clé API"
                        type="password"
                        placeholder="sk-…"
                        value={llm.apiKey}
                        onChange={(event) => setLlm({ apiKey: event.target.value })}
                      />
                    </label>
                  </div>
                  <p className="mt-2.5 text-[10.5px] font-semibold text-ink-muted">
                    {llmReady(llm)
                      ? "IA active · les propositions utilisent le modèle configuré."
                      : "IA inactive · propositions locales uniquement."}
                  </p>
                </Surface>
              </Block>

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
                            <p className="truncate text-[10.5px] font-medium text-ink-muted">{server.description}</p>
                          </div>
                          <span className="hidden shrink-0 items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[9.5px] font-bold tracking-wide text-ink-muted uppercase sm:inline-flex">
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
                            className="focus-ring flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[9.5px] font-bold text-ink-muted tabular-nums transition-colors hover:text-ink-soft"
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
                                <code className="shrink-0 text-[10.5px] font-bold text-ink-soft">{tool.name}</code>
                                <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-ink-muted">
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

                <Surface className="mt-3 overflow-x-auto">
                  <table className="w-full border-collapse text-left">
                    <thead>
                      <tr className="border-b border-line bg-surface-2/60 text-[10px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                        <th className="px-3 py-2 font-bold">Heure</th>
                        <th className="py-2 pr-3 font-bold">Serveur</th>
                        <th className="py-2 pr-3 font-bold">Outil</th>
                        <th className="py-2 pr-3 font-bold">Verdict</th>
                        <th className="py-2 pr-3 text-right font-bold">Durée</th>
                      </tr>
                    </thead>
                    <tbody>
                      {MCP_LOG.map((entry) => (
                        <tr key={entry.time + entry.tool} className="border-b border-line/70 last:border-0">
                          <td className="px-3 py-2 font-mono text-[11px] font-semibold text-ink-muted tabular-nums">
                            {entry.time}
                          </td>
                          <td className="py-2 pr-3 text-[11.5px] font-semibold text-ink-soft">
                            {serverName(entry.tool)}
                          </td>
                          <td className="py-2 pr-3 font-mono text-[11px] font-bold text-accent-ink">{entry.tool}</td>
                          <td className="py-2 pr-3">
                            <Badge tone={entry.status === "succès" ? "green" : "rose"}>{entry.status}</Badge>
                          </td>
                          <td className="py-2 pr-3 text-right font-mono text-[10.5px] font-semibold text-ink-muted tabular-nums">
                            {durationOf(entry)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
                  <a
                    href={window.location.pathname}
                    className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[11.5px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
                  >
                    Aperçu de la maquette mobile
                    <ArrowRight className="size-3.5" />
                  </a>
                </Surface>
              </Block>
            </div>
          </div>
        </div>
      </div>

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
  return (
    <section id={anchor(id)} className="scroll-mt-5">
      <div className="flex items-baseline justify-between gap-3">
        <SectionLabel>{label}</SectionLabel>
        {hint ? <span className="text-[10.5px] font-semibold text-ink-muted">{hint}</span> : null}
      </div>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}
