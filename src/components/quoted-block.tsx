import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { sanitizeHtml } from "@/lib/rich-text";
import { cn } from "@/lib/utils";

/** L'historique cité dans le brouillon : replié, en lecture seule, jamais éditable. */
export function QuotedBlock({ quoted }: { quoted?: string }) {
  const [open, setOpen] = useState(false);
  if (!quoted?.trim()) return null;

  return (
    <div className="mt-2" data-testid="compose-quoted-block">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "Masquer la conversation précédente" : "Voir la conversation précédente"}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-accent-soft px-3 text-[11.5px] font-bold text-accent-ink transition-colors"
      >
        <ChevronDown
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
          strokeWidth={2.6}
        />
        {open ? "Masquer la conversation précédente" : "Voir la conversation précédente"}
      </button>
      {open && (
        <div
          data-testid="compose-quoted"
          className="pointer-events-none mt-2 rounded-2xl border border-line bg-surface-2 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-soft [&_a]:text-accent-ink [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-2.5 [&_img]:max-w-full"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(quoted) }}
        />
      )}
    </div>
  );
}
