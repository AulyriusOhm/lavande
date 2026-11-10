import { useState } from "react";
import { Activity, ArrowLeft, Blocks, ChevronRight, Plug, ShieldCheck, Terminal, Wifi } from "lucide-react";
import { MCP_LOG, MCP_SERVERS } from "@/lib/mcp";
import { cn } from "@/lib/utils";
import { BlurFade } from "@/components/ui/blur-fade";
import { MeshGlow } from "@/components/ui/backdrops";
import { NumberTicker } from "@/components/ui/number-ticker";
import { Switch } from "@/components/ui/primitives";
import { ShinyText } from "@/components/ui/animated-text";

const SCOPE_STYLE: Record<string, string> = {
  lecture: "bg-surface-2 text-ink-soft",
  écriture: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  signature: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
};

export function McpScreen({ onClose }: { onClose?: () => void }) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>(
    Object.fromEntries(MCP_SERVERS.map((server) => [server.id, server.status === "connected"])),
  );

  const toolCount = MCP_SERVERS.reduce((total, server) => total + server.tools.length, 0);
  const connected = MCP_SERVERS.filter((server) => enabled[server.id]).length;

  return (
    <div className="relative h-full overflow-y-auto no-scrollbar pb-32">
      <MeshGlow className="h-48" />

      <header className="relative px-5 pt-4">
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Retour"
            className="mb-3 grid size-9 place-items-center rounded-full border border-line bg-surface text-ink-soft"
          >
            <ArrowLeft className="size-4" />
          </button>
        ) : null}
        <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-muted uppercase">Lavande · MCP</p>
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
            { label: "Serveurs", value: connected, icon: Plug },
            { label: "Outils", value: toolCount, icon: Terminal },
            { label: "Appels / 24 h", value: 42, icon: Activity },
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
      </BlurFade>

      <div className="mt-5 flex items-baseline justify-between px-5">
        <h2 className="text-[10.5px] font-bold tracking-[0.16em] text-ink-soft uppercase">Serveurs</h2>
        <span className="text-[10.5px] font-medium text-ink-muted">
          <ShinyText>{connected} actifs</ShinyText>
        </span>
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
                        <Wifi className="size-2.5" />
                        {server.transport}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[11px] font-medium text-ink-muted">{server.description}</p>
                  </div>
                  <Switch
                    checked={isOn}
                    onChange={(value) => setEnabled((current) => ({ ...current, [server.id]: value }))}
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
                        isOn ? SCOPE_STYLE[tool.scope] : "bg-surface-2/60 text-ink-muted/60",
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
        <span className="text-[10.5px] font-medium text-ink-muted">aujourd'hui</span>
      </div>

      <BlurFade delay={0.25}>
        <div className="mx-4 mt-3 rounded-3xl border border-line bg-surface p-1">
          {MCP_LOG.map((entry, index) => (
            <div
              key={entry.time + entry.tool}
              className={cn("flex items-center gap-2.5 px-2.5 py-2.5", index > 0 && "border-t border-line/70")}
            >
              <span className="w-9 shrink-0 font-mono text-[10px] font-semibold text-ink-muted">{entry.time}</span>
              <span className="shrink-0 rounded-lg bg-accent-soft px-1.5 py-0.5 font-mono text-[10px] font-bold text-accent-ink">
                {entry.tool}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink-soft">{entry.detail}</span>
            </div>
          ))}
        </div>
      </BlurFade>

      <BlurFade delay={0.3}>
        <button
          type="button"
          className="mx-4 mt-3 flex w-[calc(100%-2rem)] items-center gap-3 rounded-3xl border border-dashed border-line p-3.5 text-left transition-colors hover:border-accent-ring"
        >
          <span className="grid size-9 place-items-center rounded-xl bg-surface-2 text-ink-soft">
            <ShieldCheck className="size-4" />
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block text-[12.5px] font-bold text-ink">Jetons et permissions</span>
            <span className="block text-[10.5px] font-medium text-ink-muted">
              Un jeton par agent, portée limitée, révocable
            </span>
          </span>
          <ChevronRight className="size-4 text-ink-muted" />
        </button>
      </BlurFade>
    </div>
  );
}
