import { useState } from "react";
import { Check, Image, Link2, Lock, Minus, Paperclip, Send, ShieldCheck, Smile, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/primitives";
import { ShimmerButton } from "@/components/ui/shimmer-button";

export function ComposeScreen({ onClose }: { onClose: () => void }) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [pgpEncrypt, setPgpEncrypt] = useState(true);
  const [pgpSign, setPgpSign] = useState(true);

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-line" />
      <div className="flex items-center gap-2 px-3 pt-2 pb-2">
        <IconButton aria-label="Fermer" onClick={onClose}>
          <X className="size-5" />
        </IconButton>
        <h2 className="text-[15px] font-bold tracking-tight text-ink">Nouveau message</h2>
        <div className="ml-auto flex items-center gap-1">
          <IconButton aria-label="Joindre">
            <Paperclip className="size-4.5" />
          </IconButton>
          <IconButton aria-label="Ajouter une image">
            <Image className="size-4.5" />
          </IconButton>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto no-scrollbar px-5">
        <div className="flex items-center gap-2 border-b border-line py-3">
          <span className="text-[12px] font-bold tracking-[0.1em] text-ink-muted uppercase">À</span>
          <input
            value={to}
            onChange={(event) => setTo(event.target.value)}
            placeholder="destinataire@mail.com"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] font-medium text-ink outline-none placeholder:text-ink-muted/70"
          />
          <button
            type="button"
            className="rounded-full bg-accent-soft px-2.5 py-1 text-[10.5px] font-bold text-accent-ink"
          >
            Cci
          </button>
        </div>

        <div className="border-b border-line py-3">
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Objet du message"
            className="w-full bg-transparent text-[15px] font-bold tracking-tight text-ink outline-none placeholder:font-semibold placeholder:text-ink-muted/70"
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setPgpEncrypt((value) => !value)}
            aria-pressed={pgpEncrypt}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10.5px] font-bold transition-colors",
              pgpEncrypt
                ? "bg-accent-soft text-accent-ink ring-1 ring-accent-ring/60"
                : "border border-line text-ink-muted",
            )}
          >
            <Lock className="size-3" strokeWidth={2.6} />
            Chiffré
          </button>
          <button
            type="button"
            onClick={() => setPgpSign((value) => !value)}
            aria-pressed={pgpSign}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10.5px] font-bold transition-colors",
              pgpSign
                ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500/30"
                : "border border-line text-ink-muted",
            )}
          >
            <ShieldCheck className="size-3" strokeWidth={2.6} />
            Signé
          </button>
        </div>

        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Écris ton message…"
          className="mt-3 min-h-40 w-full flex-1 resize-none bg-transparent text-[13.5px] leading-[1.7] font-medium text-ink outline-none placeholder:text-ink-muted/70"
        />

        <div className="flex flex-wrap items-center gap-2 pb-4">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5 text-[11.5px] font-bold text-accent-ink">
            <Check className="size-3.5" strokeWidth={3} />
            Signature « Roman »
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[11.5px] font-semibold text-ink-soft"
          >
            <Link2 className="size-3.5" />
            Lien
          </button>
        </div>
      </div>

      <div className="border-t border-line/80 px-5 py-3 glass safe-bottom sm:pb-5">
        <div className="flex items-center gap-2">
          <ShimmerButton
            className="flex-1"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClose}
          >
            <Send className="size-4" />
            Envoyer
          </ShimmerButton>
          <button
            type="button"
            className="grid size-11 place-items-center rounded-full border border-line bg-surface text-ink-soft"
            aria-label="Emoji"
          >
            <Smile className="size-4.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className={cn(
              "grid size-11 place-items-center rounded-full border border-line bg-surface text-ink-soft",
            )}
            aria-label="Réduire"
          >
            <Minus className="size-4.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
