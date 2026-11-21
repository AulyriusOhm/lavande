import { useState } from "react";
import { ShieldCheck, X } from "lucide-react";
import { normalizeTrustedDomain, normalizeTrustedSender } from "@/lib/triage";

export function TrustedWhitelistSection({
  trustedSenders,
  trustedDomains,
  onUpdate,
}: {
  trustedSenders: readonly string[];
  trustedDomains: readonly string[];
  onUpdate: (patch: { trustedSenders?: string[]; trustedDomains?: string[] }) => void;
}) {
  const [entry, setEntry] = useState("");

  const addEntry = () => {
    const trimmed = entry.trim();
    if (!trimmed) return;
    if (trimmed.includes("@") && !trimmed.startsWith("@")) {
      const sender = normalizeTrustedSender(trimmed);
      if (sender && !trustedSenders.includes(sender)) {
        onUpdate({ trustedSenders: [...trustedSenders, sender] });
      }
    } else {
      const domain = normalizeTrustedDomain(trimmed);
      if (domain && !trustedDomains.includes(domain)) {
        onUpdate({ trustedDomains: [...trustedDomains, domain] });
      }
    }
    setEntry("");
  };

  const removeSender = (sender: string) => {
    onUpdate({ trustedSenders: trustedSenders.filter((item) => item !== sender) });
  };

  const removeDomain = (domain: string) => {
    onUpdate({ trustedDomains: trustedDomains.filter((item) => item !== domain) });
  };

  const empty = trustedSenders.length === 0 && trustedDomains.length === 0;

  return (
    <div className="space-y-2 border-t border-line/70 pt-3">
      <div className="flex items-center gap-1.5">
        <ShieldCheck className="size-3.5 text-accent-ink" strokeWidth={2.2} />
        <span className="text-[10.5px] font-bold tracking-[0.14em] text-ink-muted uppercase">
          Expéditeurs &amp; domaines de confiance
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          aria-label="Expéditeur ou domaine de confiance"
          placeholder="alice@banque.fr ou banque.fr"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          value={entry}
          onChange={(event) => setEntry(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addEntry();
            }
          }}
          className="focus-ring h-9 min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 text-[12px] font-medium text-ink placeholder:text-ink-muted"
        />
        <button
          type="button"
          onClick={addEntry}
          disabled={!entry.trim()}
          className="focus-ring h-9 shrink-0 rounded-full border border-line bg-surface px-3 text-[12px] font-bold text-ink transition-colors hover:border-accent-ring hover:text-accent-ink disabled:opacity-40"
        >
          Approuver
        </button>
      </div>
      {empty ? (
        <p className="text-[11px] font-medium text-ink-muted">
          Aucun expéditeur ou domaine approuvé · évite les faux positifs phishing/spam.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {trustedSenders.map((sender) => (
            <span
              key={`sender:${sender}`}
              className="inline-flex items-center gap-1 rounded-full border border-accent-ring/50 bg-accent-soft px-2.5 py-0.5 text-[11px] font-bold text-accent-ink"
            >
              <span>{sender}</span>
              <button
                type="button"
                aria-label={`Retirer ${sender}`}
                onClick={() => removeSender(sender)}
                className="focus-ring grid size-4 place-items-center rounded-full hover:bg-surface/60"
              >
                <X className="size-3" strokeWidth={2.5} />
              </button>
            </span>
          ))}
          {trustedDomains.map((domain) => (
            <span
              key={`domain:${domain}`}
              className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-[11px] font-bold text-ink-soft"
            >
              <span>{`@${domain}`}</span>
              <button
                type="button"
                aria-label={`Retirer @${domain}`}
                onClick={() => removeDomain(domain)}
                className="focus-ring grid size-4 place-items-center rounded-full hover:bg-surface"
              >
                <X className="size-3" strokeWidth={2.5} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
