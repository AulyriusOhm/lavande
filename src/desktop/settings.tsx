import { useEffect, useState } from "react";
import { motion } from "motion/react";
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
  Lock,
  Moon,
  PenLine,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sun,
  Terminal,
  X,
} from "lucide-react";
import { ACCOUNTS } from "@/lib/accounts";
import { CONTACT_KEYS, MY_KEY, PGP_STATE, isExpired, keyState } from "@/lib/pgp";
import { MCP_LOG, MCP_SCOPES, MCP_SERVERS, mcpCounts } from "@/lib/mcp";
import type { McpLogEntry } from "@/lib/mcp";
import { mergeFlags, usePrefs } from "@/lib/prefs";
import { ACCENT_PRESETS, useTheme } from "@/lib/theme";
import { useMailStore } from "@/lib/store";
import { useEscapeLayer } from "@/desktop/escape";
import { cn } from "@/lib/utils";
import { Avatar, Switch, ToggleRow } from "@/components/ui/primitives";
import { SyncSettings } from "@/components/sync-settings";
import { BlurFade } from "@/components/ui/blur-fade";
import { NumberTicker } from "@/components/ui/number-ticker";
import {
  Badge,
  DButton,
  DIconButton,
  PaneTitle,
  SectionLabel,
  Surface,
  TextInput,
} from "@/desktop/ui";

const TRUST_LABEL = { ultimate: "ultime", full: "complète", marginal: "marginale" } as const;

const KEY_TONE = { valid: "green", expired: "amber", revoked: "rose", invalid: "rose" } as const;

const SCOPE_TONE = { lecture: "neutral", écriture: "amber", signature: "green" } as const;

const LABEL = "block text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase";

const SECTIONS = [
  { id: "comptes", label: "Comptes" },
  { id: "apparence", label: "Apparence" },
  { id: "modules", label: "Modules" },
  { id: "securite", label: "Sécurité" },
  { id: "synchronisation", label: "Synchronisation" },
  { id: "assistant", label: "Serveurs MCP" },
  { id: "apropos", label: "À propos" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const anchor = (id: SectionId) => `reglages-${id}`;

const serverName = (tool: string) =>
  MCP_SERVERS.find((server) => server.tools.some((entry) => entry.name === tool))?.name ?? "hors ligne";

const durationOf = (entry: McpLogEntry) => `${18 + ((entry.detail.length * 7) % 240)} ms`;

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
  } = usePrefs();
  const { notify } = useMailStore();
  const [active, setActive] = useState<SectionId>("comptes");
  const [hex, setHex] = useState(accent);
  const [adding, setAdding] = useState(false);
  const [openServer, setOpenServer] = useState<string | null>(null);

  useEffect(() => setHex(accent), [accent]);

  const enabled = mergeFlags(
    Object.fromEntries(MCP_SERVERS.map((server) => [server.id, server.status === "connected"])),
    mcpEnabled,
  );
  const counts = mcpCounts((server) => enabled[server.id]);
  const myState = keyState(MY_KEY);
  const expiringSoon = !isExpired(MY_KEY) && isExpired(MY_KEY, new Date(Date.now() + 90 * 864e5));

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
              <Block id="comptes" label="Comptes" hint={`${ACCOUNTS.length} comptes`}>
                <BlurFade delay={0.04}>
                  <div className="grid gap-3 md:grid-cols-2">
                    {ACCOUNTS.map((item, index) => (
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
                      </Surface>
                    ))}
                    <button
                      type="button"
                      onClick={() => setAdding(true)}
                      className="focus-ring flex min-h-[88px] items-center justify-center gap-2 rounded-[26px] border border-dashed border-line bg-surface/60 text-[12px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
                    >
                      <Plus className="size-4" strokeWidth={3} />
                      Ajouter un compte
                    </button>
                  </div>
                </BlurFade>
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

              <Block id="securite" label="Sécurité & PGP" hint={`${CONTACT_KEYS.length} clés de contact`}>
                <div className="grid gap-3 md:grid-cols-2">
                  <Surface className={cn("p-4", expiringSoon && "border-amber-500/40 bg-amber-500/[0.04]")}>
                    <div className="flex items-center gap-1.5">
                      <SectionLabel>Ma clé</SectionLabel>
                      <Badge tone={KEY_TONE[myState]} className="ml-auto">
                        {PGP_STATE[myState].label}
                      </Badge>
                    </div>
                    <p className="mt-2.5 text-[13px] font-bold text-ink">
                      {MY_KEY.name}{" "}
                      <span className="font-medium text-ink-soft">{"<" + (MY_KEY.email ?? "") + ">"}</span>
                    </p>
                    <p className="mt-1.5 font-mono text-[10.5px] leading-relaxed font-semibold break-all text-ink-soft">
                      {MY_KEY.fingerprint}
                    </p>
                    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10.5px]">
                      <div className="col-span-2">
                        <dt className="font-semibold text-ink-muted">Algorithme</dt>
                        <dd className="font-bold text-ink">{MY_KEY.algorithm}</dd>
                      </div>
                      <div>
                        <dt className="font-semibold text-ink-muted">Créée le</dt>
                        <dd className="font-bold text-ink">{MY_KEY.created}</dd>
                      </div>
                      <div>
                        <dt className="font-semibold text-ink-muted">Expire le</dt>
                        <dd className="font-bold text-ink">{MY_KEY.expires}</dd>
                      </div>
                      <div>
                        <dt className="font-semibold text-ink-muted">Confiance</dt>
                        <dd className="font-bold text-ink">{TRUST_LABEL[MY_KEY.trust]}</dd>
                      </div>
                      <div>
                        <dt className="font-semibold text-ink-muted">Usage</dt>
                        <dd className="font-bold text-ink">secrète · signature</dd>
                      </div>
                    </dl>
                    {expiringSoon || myState !== "valid" ? (
                      <p className="mt-2.5 flex items-start gap-1.5 rounded-xl bg-amber-500/12 px-2.5 py-2 text-[10.5px] font-semibold text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="mt-px size-3.5 shrink-0" />
                        {PGP_STATE[myState].hint}
                      </p>
                    ) : null}
                    <DButton
                      variant="ghost"
                      size="sm"
                      className="mt-3"
                      onClick={() => notify("Clé publique exportée — maquette")}
                    >
                      <Download className="size-3.5" />
                      Exporter la clé publique
                    </DButton>
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

                <Surface className="mt-3 divide-y divide-line overflow-hidden">
                  {CONTACT_KEYS.map((key) => {
                    const state = keyState(key);
                    return (
                      <div key={key.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
                        <Avatar name={key.name} size={28} tone={key.tone ?? 0} rounded="rounded-[10px]" />
                        <div className="min-w-0 flex-1 leading-tight">
                          <p className="truncate text-[12px] font-bold text-ink">{key.name}</p>
                          <p className="truncate font-mono text-[10px] font-medium text-ink-muted">
                            {key.fingerprint.slice(0, 27)}…
                          </p>
                        </div>
                        <span className="hidden shrink-0 text-[10.5px] font-semibold text-ink-muted lg:block">
                          {isExpired(key) ? `expirée le ${key.expires}` : `expire le ${key.expires}`}
                        </span>
                        <Badge tone={KEY_TONE[state]}>{PGP_STATE[state].label}</Badge>
                      </div>
                    );
                  })}
                </Surface>
              </Block>

              <Block id="synchronisation" label="Synchronisation" hint="chiffré de bout en bout">
                <SyncSettings variant="desktop" />
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

      {adding ? <AddAccountDialog onClose={() => setAdding(false)} /> : null}
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

function AddAccountDialog({ onClose }: { onClose: () => void }) {
  const { notify } = useMailStore();
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [provider, setProvider] = useState("");

  useEscapeLayer(true, onClose);

  const valid = label.trim().length > 0 && email.trim().length > 0;

  const submit = () => {
    if (!valid) return;
    setLabel("");
    setEmail("");
    setProvider("");
    notify("Compte ajouté — maquette");
    onClose();
  };

  return (
    <div className="absolute inset-0 z-40 grid place-items-center px-6">
      <button
        type="button"
        aria-label="Fermer la fenêtre"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/25 backdrop-blur-[2px]"
      />
      <motion.div
        role="dialog"
        aria-modal
        aria-label="Ajouter un compte"
        initial={{ opacity: 0, y: 10, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-[460px] max-w-full rounded-[26px] border border-line bg-surface p-5 shadow-[0_44px_96px_-48px_var(--accent)]"
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[19px] leading-tight font-extrabold tracking-[-0.035em] text-ink">
            Ajouter un compte
          </h2>
          <DIconButton label="Fermer" className="size-8" onClick={onClose}>
            <X className="size-4" />
          </DIconButton>
        </div>

        <label htmlFor="account-label" className={cn(LABEL, "mt-3")}>
          Libellé
        </label>
        <TextInput
          id="account-label"
          autoFocus
          className="mt-1.5"
          value={label}
          placeholder="Perso"
          onChange={(event) => setLabel(event.target.value)}
        />

        <label htmlFor="account-email" className={cn(LABEL, "mt-4")}>
          E-mail
        </label>
        <TextInput
          id="account-email"
          type="email"
          className="mt-1.5"
          value={email}
          placeholder="nom@domaine.fr"
          onChange={(event) => setEmail(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />

        <label htmlFor="account-provider" className={cn(LABEL, "mt-4")}>
          Fournisseur
        </label>
        <TextInput
          id="account-provider"
          className="mt-1.5"
          value={provider}
          placeholder="IMAP · OVH"
          onChange={(event) => setProvider(event.target.value)}
        />

        <div className="mt-5 flex items-center justify-end gap-2">
          <DButton variant="plain" onClick={onClose}>
            Annuler
          </DButton>
          <DButton variant="primary" onClick={submit} disabled={!valid}>
            <Check className="size-4" strokeWidth={3} />
            Ajouter
          </DButton>
        </div>
      </motion.div>
    </div>
  );
}
