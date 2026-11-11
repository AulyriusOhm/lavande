import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { WandSparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { aiRewrite, replaceUserPart, rewriteBody, rewriteOptions, userPart, type ReplySuggestion, type RewriteOption } from "@/lib/assist";
import { llmReady } from "@/lib/llm";
import { usePrefs } from "@/lib/prefs";

const wordCount = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

function Sheet({
  open,
  title,
  subtitle,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div key="assist-sheet" className="absolute inset-0 z-50" initial={false}>
          <motion.div
            className="absolute inset-0 bg-canvas/60 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.24 }}
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className="absolute inset-x-0 bottom-0 max-h-[88%] overflow-y-auto no-scrollbar rounded-t-[32px] border-t border-line bg-surface px-5 pt-2.5 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] shadow-[0_-20px_60px_-20px_rgba(40,20,80,0.35)]"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="mx-auto h-1 w-10 rounded-full bg-line" />
            <div className="mt-3 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-bold tracking-tight text-ink">{title}</h2>
                <p className="mt-1 text-[11.5px] font-semibold text-ink-muted">{subtitle}</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Fermer"
                className="grid size-8 shrink-0 place-items-center rounded-full border border-line bg-surface-2 text-ink-soft"
              >
                <X className="size-4" />
              </button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function OptionCard({
  active,
  label,
  badge,
  text,
  onSelect,
}: {
  active: boolean;
  label?: string;
  badge?: string;
  text: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "block w-full rounded-2xl border p-3 text-left transition-colors",
        active ? "border-accent-ring bg-accent-soft/40" : "border-line bg-surface-2",
      )}
    >
      {badge && (
        <span className="inline-flex items-center rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold tracking-[0.12em] text-accent-ink uppercase">
          {badge}
        </span>
      )}
      {label && <span className="block text-[12.5px] font-bold text-ink">{label}</span>}
      {text}
    </button>
  );
}

export function ReplySuggestSheet({
  open,
  suggestions,
  generate,
  onPick,
  onClose,
}: {
  open: boolean;
  suggestions: ReplySuggestion[];
  generate: (brief: string) => ReplySuggestion | Promise<ReplySuggestion>;
  onPick: (suggestion: ReplySuggestion) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [generating, setGenerating] = useState(false);
  const [custom, setCustom] = useState<ReplySuggestion | null>(null);
  const timer = useRef<number | null>(null);

  const options = custom ? [custom, ...suggestions] : suggestions;
  const picked = options.find((entry) => entry.id === selected) ?? null;

  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setBrief("");
    setGenerating(false);
    setCustom(null);
  }, [open]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const run = () => {
    if (!brief.trim() || generating) return;
    if (timer.current) window.clearTimeout(timer.current);
    setGenerating(true);
    setCustom(null);
    setSelected(null);
    timer.current = window.setTimeout(() => {
      void Promise.resolve(generate(brief))
        .then((result) => {
          setCustom(result);
          setSelected("custom");
        })
        .catch(() => {})
        .finally(() => {
          setGenerating(false);
          timer.current = null;
        });
    }, 450);
  };

  return (
    <Sheet
      open={open}
      title="Suggestion de réponse"
      subtitle="Propositions à partir du fil · générées localement pour la maquette"
      onClose={onClose}
    >
      <div className="mt-3 rounded-2xl border border-line bg-surface-2/60 p-3">
        <label htmlFor="assist-brief" className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
          Ta consigne
        </label>
        <textarea
          id="assist-brief"
          value={brief}
          onChange={(event) => {
            setBrief(event.target.value);
            setCustom(null);
            if (selected === "custom") setSelected(null);
          }}
          rows={3}
          placeholder="Dis ce que tu veux répondre : « confirmer pour mardi 10 h », « demander le devis avant vendredi »…"
          className="mt-1.5 w-full resize-none bg-transparent text-[12.5px] leading-[1.6] font-medium text-ink outline-none placeholder:text-ink-muted/70"
        />
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={run}
            disabled={!brief.trim() || generating}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-accent px-3 text-[11.5px] font-bold text-accent-contrast transition-transform active:scale-95 disabled:pointer-events-none disabled:opacity-45"
          >
            <WandSparkles className="size-3.5" />
            {generating ? "Rédaction…" : "Générer la réponse"}
          </button>
          <span aria-live="polite" className="min-w-0 truncate text-[10.5px] font-semibold text-ink-muted">
            {generating ? "Le modèle relit le fil…" : custom ? "Proposition ajoutée en tête" : ""}
          </span>
        </div>
      </div>

      <div role="radiogroup" aria-label="Propositions de réponse" className="mt-3 space-y-2">
        {options.map((entry) => (
          <OptionCard
            key={entry.id}
            active={entry.id === selected}
            badge={entry.badge}
            onSelect={() => setSelected(entry.id)}
            text={
              <span className="mt-2 block whitespace-pre-line text-[12.5px] leading-[1.6] font-medium text-ink">
                {entry.text}
              </span>
            }
          />
        ))}
      </div>

      <ShimmerButton
        className="mt-3 w-full"
        disabled={!picked}
        onClick={() => {
          if (picked) onPick(picked);
        }}
      >
        Utiliser cette réponse
      </ShimmerButton>
      <button
        type="button"
        onClick={onClose}
        className="mt-2 w-full rounded-full py-2 text-[11.5px] font-bold text-ink-soft"
      >
        Écrire moi-même
      </button>
    </Sheet>
  );
}

export function RewriteSheet({
  open,
  body,
  onApply,
  onClose,
}: {
  open: boolean;
  body: string;
  onApply: (text: string) => void;
  onClose: () => void;
}) {
  const { llm } = usePrefs();
  const [selected, setSelected] = useState<RewriteOption["id"] | null>(null);
  const [aiText, setAiText] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const options = rewriteOptions();
  const preview = aiText ?? (selected ? rewriteBody(selected, body) : "");
  const before = wordCount(userPart(body));
  const after = selected ? wordCount(userPart(preview)) : before;

  useEffect(() => {
    if (open) {
      setSelected(null);
      setAiText(null);
    }
  }, [open]);

  useEffect(() => {
    if (!selected || !llmReady(llm)) {
      setAiText(null);
      return;
    }
    const option = options.find((entry) => entry.id === selected);
    if (!option) return;
    let cancelled = false;
    setAiLoading(true);
    setAiText(null);
    aiRewrite(llm, option.label, userPart(body))
      .then((result) => {
        if (!cancelled) setAiText(replaceUserPart(body, result));
      })
      .catch(() => {
        if (!cancelled) setAiText(null);
      })
      .finally(() => {
        if (!cancelled) setAiLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, llm, body]);


  return (
    <Sheet
      open={open}
      title="Corriger / reformuler"
      subtitle={llmReady(llm) ? "Réécriture par IA · la citation n'est pas modifiée" : "La citation du message d'origine n'est pas modifiée"}
      onClose={onClose}
    >
      <div role="radiogroup" aria-label="Réécritures proposées" className="mt-3 space-y-2">
        {options.map((option) => (
          <OptionCard
            key={option.id}
            active={option.id === selected}
            label={option.label}
            onSelect={() => setSelected(option.id)}
            text={<span className="mt-0.5 block text-[11.5px] font-semibold text-ink-muted">{option.hint}</span>}
          />
        ))}
      </div>

      {selected && (
        <div className="mt-3">
          <div className="rounded-2xl bg-surface-2 p-3">
            <p className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Aperçu</p>
            <p className="mt-1.5 whitespace-pre-line text-[12.5px] leading-[1.6] font-medium text-ink">
              {aiLoading ? "Rédaction en cours…" : preview}
            </p>
          </div>
          <p aria-live="polite" className="mt-2 text-[11.5px] font-semibold text-ink-muted">
            {before} mots avant · {after} mots après
          </p>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <ShimmerButton
          className="flex-1"
          disabled={!selected || aiLoading || !preview}
          onClick={() => {
            if (selected && preview) onApply(preview);
          }}
        >
          Appliquer
        </ShimmerButton>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-11 items-center rounded-full border border-line px-4 text-[11.5px] font-bold text-ink-soft"
        >
          Annuler
        </button>
      </div>
    </Sheet>
  );
}
