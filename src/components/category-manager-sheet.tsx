import { useEffect, useState } from "react";
import { Loader2, Pencil, Plus, RefreshCw, Tag, Trash2, X } from "lucide-react";
import { mailApi } from "@/lib/api";
import { useBackLayer } from "@/lib/back";
import type { CustomCategory } from "@/lib/decision";
import { usePrefs } from "@/lib/prefs";
import { useMailStore } from "@/lib/store";
import { toApiDecisionConfig } from "@/lib/triage";
import { cn } from "@/lib/utils";
import { ToggleRow } from "@/components/ui/primitives";

export const MAX_CUSTOM_CATEGORIES = 8;

export type CategoryColorId = "accent" | "emerald" | "amber" | "rose" | "sky" | "violet";

export const CATEGORY_COLORS: {
  id: CategoryColorId;
  label: string;
  dot: string;
  pill: string;
}[] = [
  { id: "accent", label: "Lavande", dot: "bg-accent", pill: "bg-accent-soft text-accent-ink" },
  {
    id: "emerald",
    label: "Émeraude",
    dot: "bg-emerald-500",
    pill: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  },
  {
    id: "amber",
    label: "Ambre",
    dot: "bg-amber-500",
    pill: "bg-amber-500/14 text-amber-700 dark:text-amber-300",
  },
  {
    id: "rose",
    label: "Rose",
    dot: "bg-rose-500",
    pill: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
  },
  {
    id: "sky",
    label: "Ciel",
    dot: "bg-sky-500",
    pill: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  },
  {
    id: "violet",
    label: "Orchidée",
    dot: "bg-violet-500",
    pill: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
  },
];

export function categoryColorStyle(color: string) {
  return CATEGORY_COLORS.find((entry) => entry.id === color) ?? CATEGORY_COLORS[0];
}

function slugifyCategory(name: string, existingIds: Set<string>): string {
  const base =
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "categorie";

  if (!existingIds.has(base)) return base;
  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

type CategoryDraft = {
  id: string | null;
  name: string;
  description: string;
  color: CategoryColorId;
  excludeFromPriority: boolean;
  allowNotifications: boolean;
  cleanupEligible: boolean;
};

const EMPTY_DRAFT: CategoryDraft = {
  id: null,
  name: "",
  description: "",
  color: "accent",
  excludeFromPriority: false,
  allowNotifications: true,
  cleanupEligible: false,
};

export type CategoryManagerSheetProps = {
  open: boolean;
  onClose: () => void;
  onRetriage?: () => Promise<void> | void;
};

export function CategoryManagerSheet({ open, onClose, onRetriage }: CategoryManagerSheetProps) {
  const { decision, setDecision } = usePrefs();
  const { mode, mails, triageMails } = useMailStore();

  const [draft, setDraft] = useState<CategoryDraft>(EMPTY_DRAFT);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [retriaging, setRetriaging] = useState(false);

  useBackLayer(open, onClose);

  useEffect(() => {
    if (!open) return;
    setDraft(EMPTY_DRAFT);
    setFormOpen(decision.customCategories.length === 0);
    setError(null);
    setChanged(false);
    // Réinitialise uniquement à l'ouverture pour ne pas effacer `changed` après ajout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const categories = decision.customCategories;
  const atLimit = categories.length >= MAX_CUSTOM_CATEGORIES && draft.id === null;

  const persistCategories = (nextCategories: CustomCategory[]) => {
    const nextConfig = { ...decision, customCategories: nextCategories };
    setDecision({ customCategories: nextCategories });
    if (mode === "api") {
      void mailApi.saveDecisionConfig(toApiDecisionConfig(nextConfig)).catch(() => undefined);
    }
  };

  const startCreate = () => {
    if (categories.length >= MAX_CUSTOM_CATEGORIES) return;
    setDraft(EMPTY_DRAFT);
    setError(null);
    setFormOpen(true);
  };

  const startEdit = (cat: CustomCategory) => {
    const color = CATEGORY_COLORS.some((c) => c.id === cat.color)
      ? (cat.color as CategoryColorId)
      : "accent";
    setDraft({
      id: cat.id,
      name: cat.name,
      description: cat.description,
      color,
      excludeFromPriority: cat.excludeFromPriority,
      allowNotifications: cat.allowNotifications,
      cleanupEligible: cat.cleanupEligible,
    });
    setError(null);
    setFormOpen(true);
  };

  const handleSave = (event: React.FormEvent) => {
    event.preventDefault();
    const name = draft.name.trim().slice(0, 40);
    const description = draft.description.trim().slice(0, 200);
    if (!name) {
      setError("Donne un nom à la catégorie.");
      return;
    }
    if (!description) {
      setError("Décris brièvement quels mails y classer.");
      return;
    }

    if (draft.id) {
      const next = categories.map((cat) =>
        cat.id === draft.id
          ? {
              ...cat,
              name,
              description,
              color: draft.color,
              excludeFromPriority: draft.excludeFromPriority,
              allowNotifications: draft.allowNotifications,
              cleanupEligible: draft.cleanupEligible,
            }
          : cat,
      );
      persistCategories(next);
    } else {
      if (categories.length >= MAX_CUSTOM_CATEGORIES) {
        setError(`Maximum ${MAX_CUSTOM_CATEGORIES} catégories personnalisées.`);
        return;
      }
      const existingIds = new Set(categories.map((c) => c.id));
      const id = slugifyCategory(name, existingIds);
      const created: CustomCategory = {
        id,
        name,
        description,
        color: draft.color,
        excludeFromPriority: draft.excludeFromPriority,
        allowNotifications: draft.allowNotifications,
        cleanupEligible: draft.cleanupEligible,
      };
      persistCategories([...categories, created]);
    }

    setChanged(true);
    setDraft(EMPTY_DRAFT);
    setFormOpen(false);
    setError(null);
  };

  const handleDelete = (id: string) => {
    const next = categories.filter((cat) => cat.id !== id);
    persistCategories(next);
    if (decision.defaultInboxFilter === `custom:${id}`) {
      setDecision({ defaultInboxFilter: "all" });
    }
    if (draft.id === id) {
      setDraft(EMPTY_DRAFT);
      setFormOpen(false);
    }
  };

  const handleRetriage = async () => {
    if (retriaging) return;
    setRetriaging(true);
    try {
      if (onRetriage) await onRetriage();
      else await triageMails(mails, true);
      setChanged(false);
    } finally {
      setRetriaging(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Catégories personnalisées"
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
    >
      <div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]"
      />
      <div className="relative flex max-h-[88vh] w-full flex-col overflow-hidden rounded-t-[32px] border border-line bg-canvas shadow-2xl sm:max-w-lg sm:rounded-[32px]">
        <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-line sm:hidden" />

        <header className="flex items-center justify-between gap-2 border-b border-line/80 px-5 pt-3.5 pb-3">
          <div className="min-w-0">
            <h2 className="text-[16px] font-extrabold tracking-tight text-ink">
              Catégories personnalisées
            </h2>
            <p className="text-[11.5px] font-medium text-ink-muted">
              {categories.length} / {MAX_CUSTOM_CATEGORIES} · évaluées en une passe par le modèle de décision
            </p>
          </div>
          <button
            type="button"
            aria-label="Fermer"
            onClick={onClose}
            className="focus-ring grid size-10 shrink-0 place-items-center rounded-full text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <X className="size-4.5" strokeWidth={2.2} />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {changed ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-accent-ring bg-accent-soft px-3.5 py-2.5">
              <p className="text-[12px] font-semibold text-accent-ink">
                Catégories mises à jour · applique-les aux messages déjà reçus ?
              </p>
              <button
                type="button"
                disabled={retriaging}
                onClick={() => void handleRetriage()}
                className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[12px] font-bold text-accent-contrast transition-transform active:scale-95 disabled:opacity-60"
              >
                {retriaging ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                <span>Retrier les mails récents</span>
              </button>
            </div>
          ) : null}

          {categories.length > 0 ? (
            <div className="space-y-2">
              {categories.map((cat) => {
                const style = categoryColorStyle(cat.color);
                return (
                  <div
                    key={cat.id}
                    className="flex items-start gap-3 rounded-2xl border border-line bg-surface p-3"
                  >
                    <span className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", style.dot)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold", style.pill)}>
                          {cat.name}
                        </span>
                        <span className="truncate font-mono text-[10.5px] text-ink-muted">
                          {cat.id}
                        </span>
                      </div>
                      <p className="mt-1 text-[12px] leading-snug font-medium text-ink-soft">
                        {cat.description}
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1 text-[10.5px] font-semibold text-ink-muted">
                        {cat.excludeFromPriority && (
                          <span className="rounded-md bg-surface-2 px-1.5 py-0.5">Hors Prioritaire</span>
                        )}
                        {cat.allowNotifications && (
                          <span className="rounded-md bg-surface-2 px-1.5 py-0.5">Notifs actives</span>
                        )}
                        {cat.cleanupEligible && (
                          <span className="rounded-md bg-surface-2 px-1.5 py-0.5">Nettoyable</span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        aria-label={`Modifier ${cat.name}`}
                        onClick={() => startEdit(cat)}
                        className="focus-ring grid size-9 place-items-center rounded-full text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Supprimer ${cat.name}`}
                        onClick={() => handleDelete(cat.id)}
                        className="focus-ring grid size-9 place-items-center rounded-full text-ink-muted transition-colors hover:bg-rose-500/10 hover:text-rose-700 dark:hover:text-rose-300"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {!formOpen ? (
            <button
              type="button"
              disabled={categories.length >= MAX_CUSTOM_CATEGORIES}
              onClick={startCreate}
              className="focus-ring flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line bg-surface px-4 text-[12.5px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink disabled:opacity-45"
            >
              <Plus className="size-4" />
              <span>
                {categories.length >= MAX_CUSTOM_CATEGORIES
                  ? `Limite de ${MAX_CUSTOM_CATEGORIES} catégories atteinte`
                  : "Ajouter une catégorie"}
              </span>
            </button>
          ) : (
            <form onSubmit={handleSave} className="space-y-3 rounded-2xl border border-line bg-surface p-3.5">
              <div className="flex items-center justify-between">
                <p className="text-[12.5px] font-bold text-ink">
                  {draft.id ? "Modifier la catégorie" : "Nouvelle catégorie"}
                </p>
                {categories.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setFormOpen(false);
                      setDraft(EMPTY_DRAFT);
                      setError(null);
                    }}
                    className="text-[11.5px] font-bold text-ink-muted hover:text-ink"
                  >
                    Annuler
                  </button>
                ) : null}
              </div>

              <label className="block">
                <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                  Nom
                </span>
                <input
                  aria-label="Nom de la catégorie"
                  type="text"
                  maxLength={40}
                  placeholder="Factures"
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  className="focus-ring mt-1 h-10 w-full rounded-xl border border-line bg-surface-2/60 px-3 text-[13px] font-medium text-ink placeholder:text-ink-muted"
                />
              </label>

              <label className="block">
                <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                  Description pour l'IA
                </span>
                <textarea
                  aria-label="Description de la catégorie"
                  rows={2}
                  maxLength={200}
                  placeholder="Factures, devis, justificatifs de paiement et abonnements"
                  value={draft.description}
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                  className="focus-ring mt-1 w-full resize-none rounded-xl border border-line bg-surface-2/60 px-3 py-2 text-[12.5px] font-medium text-ink placeholder:text-ink-muted"
                />
              </label>

              <div>
                <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                  Couleur
                </span>
                <div role="group" aria-label="Couleur de la catégorie" className="mt-1.5 flex flex-wrap gap-1.5">
                  {CATEGORY_COLORS.map((color) => {
                    const selected = draft.color === color.id;
                    return (
                      <button
                        key={color.id}
                        type="button"
                        aria-label={color.label}
                        aria-pressed={selected}
                        onClick={() => setDraft((d) => ({ ...d, color: color.id }))}
                        className={cn(
                          "focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-bold transition-colors",
                          selected
                            ? "border-accent bg-accent-soft text-accent-ink"
                            : "border-line bg-surface text-ink-soft",
                        )}
                      >
                        <span className={cn("size-2.5 rounded-full", color.dot)} />
                        <span>{color.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="divide-y divide-line/80 overflow-hidden rounded-2xl border border-line">
                <ToggleRow
                  icon={<Tag className="size-4" />}
                  label="Exclure de la vue Prioritaire"
                  hint="Masque ces messages dans l'onglet Prioritaire"
                  checked={draft.excludeFromPriority}
                  onChange={(value) => setDraft((d) => ({ ...d, excludeFromPriority: value }))}
                />
                <ToggleRow
                  icon={<Tag className="size-4" />}
                  label="Autoriser les notifications"
                  hint="Notifie en mode Notifications intelligentes"
                  checked={draft.allowNotifications}
                  onChange={(value) => setDraft((d) => ({ ...d, allowNotifications: value }))}
                />
                <ToggleRow
                  icon={<Tag className="size-4" />}
                  label="Inclure dans le nettoyage"
                  hint="Propose ces messages dans le mode Nettoyage"
                  checked={draft.cleanupEligible}
                  onChange={(value) => setDraft((d) => ({ ...d, cleanupEligible: value }))}
                />
              </div>

              {error ? (
                <p role="alert" className="text-[12px] font-semibold text-rose-600 dark:text-rose-300">
                  {error}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={atLimit}
                className="focus-ring min-h-11 w-full rounded-full bg-accent px-4 text-[12.5px] font-bold text-accent-contrast transition-opacity disabled:opacity-45"
              >
                {draft.id ? "Enregistrer la catégorie" : "Créer la catégorie"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
