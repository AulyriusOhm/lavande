import { ShieldCheck } from "lucide-react";
import { resolveMcpApproval, useMcpApprovals } from "@/lib/mcp";
import { usePrefs } from "@/lib/prefs";

const ACTIONS = {
  refuse: "focus-ring inline-flex h-10 items-center justify-center rounded-full border border-line bg-surface px-4 text-[12px] font-bold text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink",
  remember: "focus-ring inline-flex h-10 items-center justify-center rounded-full bg-accent-soft px-4 text-[12px] font-bold text-accent-ink transition-colors hover:bg-accent-ring/40",
  allow: "focus-ring inline-flex h-10 items-center justify-center rounded-full bg-accent px-4 text-[12px] font-bold text-accent-contrast shadow-[0_10px_26px_-14px_var(--accent)] transition-colors hover:brightness-[1.04]",
};

export function McpApprovalDialog() {
  const requests = useMcpApprovals();
  const { setMcpAlwaysAllow } = usePrefs();
  const request = requests[0];

  if (!request) return null;

  const remember = () => {
    setMcpAlwaysAllow(request.type, true);
    resolveMcpApproval(request.id, true);
  };

  return (
    <div className="absolute inset-0 z-[70] grid place-items-center bg-ink/25 p-5 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`mcp-approval-title-${request.id}`}
        aria-describedby={`mcp-approval-detail-${request.id}`}
        className="w-full max-w-[440px] rounded-[28px] border border-line bg-surface p-4 shadow-[0_44px_96px_-48px_var(--accent)]"
      >
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent-ink">
            <ShieldCheck className="size-5" />
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
              Autorisation MCP
            </p>
            <h2 id={`mcp-approval-title-${request.id}`} className="mt-1 text-[17px] leading-tight font-extrabold tracking-[-0.03em] text-ink">
              {request.serverName}
            </h2>
            <p className="mt-1 font-mono text-[11.5px] font-bold text-accent-ink">{request.tool}</p>
          </div>
          <span className="shrink-0 rounded-md bg-amber-500/14 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300">
            {request.type}
          </span>
        </div>

        <p
          id={`mcp-approval-detail-${request.id}`}
          className="mt-3 rounded-2xl bg-surface-2 px-3 py-2.5 text-[11.5px] leading-relaxed font-medium break-words text-ink-soft"
        >
          {request.detail}
        </p>

        <p className="mt-2 text-[10.5px] font-medium text-ink-muted">
          Demandé par <span className="font-bold text-ink-soft">{request.agent}</span> · l'action reste en
          attente de ta réponse.
        </p>

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" autoFocus className={ACTIONS.refuse} onClick={() => resolveMcpApproval(request.id, false)}>
            Refuser
          </button>
          <button type="button" className={ACTIONS.remember} onClick={remember}>
            Toujours autoriser ce type
          </button>
          <button type="button" className={ACTIONS.allow} onClick={() => resolveMcpApproval(request.id, true)}>
            Autoriser
          </button>
        </div>
      </div>
    </div>
  );
}
