import {
  Activity,
  ArrowLeft,
  Blocks,
  Globe,
  Plug,
  RotateCcw,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import {
  MCP_ACTION_TYPES,
  MCP_SCOPES,
  MCP_SERVERS,
  mcpCallsLastDay,
  mcpCounts,
  mcpLogClock,
  mcpTypeAllowed,
  useMcpLog,
} from "@/lib/mcp";
import { mergeFlags, usePrefs } from "@/lib/prefs";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { BlurFade } from "@/components/ui/blur-fade";
import { MeshGlow } from "@/components/ui/backdrops";
import { NumberTicker } from "@/components/ui/number-ticker";
import { Switch, SwitchTrack } from "@/components/ui/primitives";
import { ShinyText } from "@/components/ui/animated-text";

export { McpApprovalDialog as McpApprovalHost } from "@/components/mcp-approval";

const SCOPE_STYLE: Record<string, string> = {
  lecture: "bg-surface-2 text-ink-soft",
  écriture: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  signature: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
};

const STATUS_STYLE: Record<string, string> = {
  succès: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  échec: "bg-red-500/12 text-red-700 dark:text-red-300",
  refusé: "bg-amber-500/14 text-amber-700 dark:text-amber-300",
};

export function McpScreen({ onClose }: { onClose?: () => void }) {
  const { brand } = useTheme();
  const {
    mcpEnabled,
    setMcpEnabled,
    mcpAlwaysAllow,
    setMcpAlwaysAllow,
    resetMcpAllowances,
    mcpConfirmSend,
  } = usePrefs();
  const log = useMcpLog();

  const enabled = mergeFlags(
    Object.fromEntries(MCP_SERVERS.map((server) => [server.id, server.status === "connected"])),
    mcpEnabled,
  );
  const counts = mcpCounts((server) => enabled[server.id]);
  const allowed = { alwaysAllow: mcpAlwaysAllow, confirmSend: mcpConfirmSend };

  return (
    <div className="relative h-full overflow-y-auto no-scrollbar pb-32">
      <MeshGlow className="h-48" />

      <header className="relative px-5 pt-4">
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Retour"
            className="focus-ring mb-3 grid size-11 place-items-center rounded-full border border-line bg-surface text-ink-soft"
          >
            <ArrowLeft className="size-4" />
          </button>
        ) : null}
        <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-muted uppercase">{brand} · MCP</p>
        <h1 className="mt-1.5 text-[27px] leading-none font-extrabold tracking-[-0.035em] text-ink">
          Assistant
        </h1>
        <p className="mt-2 text-[12px] leading-relaxed font-medium text-ink-soft">
          Ces serveurs exposent ta boîte et ton agenda aux agents IA, via{" "}
          <span className="font-bold text-ink">Model Context Protocol</span>.
        </p>
      </header>

      <BlurFade delay={0.05}>
        <div className="mx-5 mt-4 grid grid-cols-3 gap-2">
          {[
            { label: "Serveurs actifs", value: counts.activeServers, icon: Plug },
            { label: "Outils actifs", value: counts.activeTools, icon: Terminal },
            { label: "Appels / 24 h", value: mcpCallsLastDay(log), icon: Activity },
          ].map((stat) => {
            const Icon = stat.icon;
            return (
              <div key={stat.label} className="rounded-2xl border border-line bg-surface p-3">
                <Icon className="size-3.5 text-accent-ink" />
                <p className="mt-1.5 text-[19px] leading-none font-extrabold tracking-tight text-ink">
                  <NumberTicker value={stat.value} />
                </p>
                <p className="mt-0.5 text-[10px] font-semibold text-ink-muted">{stat.label}</p>
              </div>
            );
          })}
        </div>
        <p className="mx-5 mt-2 text-[10px] leading-relaxed font-medium text-ink-muted">
          {counts.activeTools} outils actifs sur {counts.installedTools} installés · les serveurs
          désactivés ne sont pas exposés.
        </p>
      </BlurFade>

      <div className="mt-5 flex items-baseline justify-between px-5">
        <h2 className="text-[10.5px] font-bold tracking-[0.16em] text-ink-soft uppercase">Serveurs</h2>
        <span className="text-[10.5px] font-medium text-ink-muted">
          <ShinyText>
            {counts.activeServers} serveurs actifs · {counts.activeTools} outils actifs
          </ShinyText>
        </span>
      </div>

      <div className="mx-4 mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        {MCP_SCOPES.map((scope) => (
          <span key={scope.id} className="inline-flex items-center gap-1.5">
            <span
              className={cn(
                "rounded-md px-1.5 py-0.5 text-[9.5px] font-bold",
                SCOPE_STYLE[scope.id],
              )}
            >
              {scope.id}
            </span>
            <span className="text-[10px] font-medium text-ink-muted">{scope.hint}</span>
          </span>
        ))}
      </div>

      <div className="mt-3 space-y-2 px-4">
        {MCP_SERVERS.map((server, index) => {
          const isOn = enabled[server.id];
          return (
            <BlurFade key={server.id} delay={0.05 * index} yOffset={12}>
              <div className="rounded-3xl border border-line bg-surface p-3.5">
                <div className="flex items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-ink">
                    <Blocks className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-[13px] font-bold text-ink">{server.name}</p>
                      <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[9.5px] font-bold tracking-wide text-ink-muted uppercase">
                        {server.transport === "stdio" ? (
                          <Terminal className="size-2.5" />
                        ) : (
                          <Globe className="size-2.5" />
                        )}
                        {server.transport}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] font-medium text-ink-muted">{server.description}</p>
                  </div>
                  <Switch
                    checked={isOn}
                    onChange={(value) => setMcpEnabled(server.id, value)}
                    label={server.name}
                  />
                </div>

                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {server.tools.map((tool) => (
                    <span
                      key={tool.name}
                      title={tool.description}
                      className={cn(
                        "rounded-lg px-2 py-0.5 font-mono text-[10px] font-semibold",
                        isOn ? SCOPE_STYLE[tool.scope] : "bg-surface-2/60 text-ink-muted",
                      )}
                    >
                      {tool.name}
                    </span>
                  ))}
                </div>
              </div>
            </BlurFade>
          );
        })}
      </div>

      <div className="mt-5 flex items-baseline justify-between px-5">
        <h2 className="text-[10.5px] font-bold tracking-[0.16em] text-ink-soft uppercase">Journal</h2>
        <span className="text-[10.5px] font-medium text-ink-muted">
          {log.length > 0 ? `${log.length} action${log.length > 1 ? "s" : ""}` : "à jour"}
        </span>
      </div>

      <BlurFade delay={0.25}>
        <div className="mx-4 mt-3 rounded-3xl border border-line bg-surface p-1">
          {log.length === 0 ? (
            <p className="px-3 py-4 text-center text-[11px] font-medium text-ink-muted">
              Aucune action journalisée.
            </p>
          ) : (
            log.map((entry, index) => (
              <div
                key={`${entry.time}-${index}`}
                className={cn("px-2.5 py-2.5", index > 0 && "border-t border-line/70")}
              >
                <div className="flex items-center gap-2.5">
                  <span className="w-9 shrink-0 font-mono text-[10px] font-semibold text-ink-muted tabular-nums">
                    {mcpLogClock(entry.time)}
                  </span>
                  <span className="shrink-0 rounded-lg bg-accent-soft px-1.5 py-0.5 font-mono text-[10px] font-bold text-accent-ink">
                    {entry.tool}
                  </span>
                  <span
                    className={cn(
                      "ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-bold",
                      STATUS_STYLE[entry.status],
                    )}
                  >
                    {entry.status}
                  </span>
                </div>
                <p className="mt-1 pl-[46px] text-[10.5px] leading-relaxed font-medium break-words text-ink-soft">
                  <span className="font-bold text-ink-muted">{entry.agent}</span> · {entry.detail}
                </p>
              </div>
            ))
          )}
        </div>
      </BlurFade>

      <BlurFade delay={0.3}>
        <div className="mx-4 mt-3 overflow-hidden rounded-3xl border border-line bg-surface">
          <div className="flex items-center gap-2 px-3.5 pt-3">
            <p className="text-[10.5px] font-bold tracking-[0.14em] text-ink-muted uppercase">
              Permissions
            </p>
            <button
              type="button"
              onClick={resetMcpAllowances}
              className="focus-ring ml-auto inline-flex min-h-11 items-center gap-1 rounded-full bg-surface-2 px-3 text-[11px] font-bold text-ink-soft"
            >
              <RotateCcw className="size-2.5" />
              Tout redemander
            </button>
          </div>
          <p className="px-3.5 pt-1.5 text-[10px] leading-relaxed font-medium text-ink-muted">
            Les lectures passent librement ; chaque écriture demande ton accord, sauf les types que tu
            autorises d'avance.
          </p>
          <div className="mt-1.5 divide-y divide-line/70">
            {MCP_ACTION_TYPES.map((action) => {
              const isAllowed = mcpTypeAllowed(action.id, allowed);
              return (
                <button
                  key={action.id}
                  type="button"
                  role="switch"
                  aria-checked={isAllowed}
                  onClick={() => setMcpAlwaysAllow(action.id, !isAllowed)}
                  className="focus-row flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2/70"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-soft">
                    <ShieldCheck className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block text-[12px] font-bold text-ink">Toujours autoriser · {action.id}</span>
                    <span className="block text-[10px] font-medium text-ink-muted">{action.hint}</span>
                  </span>
                  <SwitchTrack checked={isAllowed} />
                </button>
              );
            })}
          </div>
        </div>
      </BlurFade>
    </div>
  );
}
