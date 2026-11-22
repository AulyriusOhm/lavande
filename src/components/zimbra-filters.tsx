/**
 * Filtres et message d'absence d'un compte Zimbra. Le serveur est la seule
 * source : la section ne range rien, elle lit (`GetFilterRules`/`GetPrefs`),
 * envoie une modification et réaffiche ce que le serveur répond. Une règle que
 * le démon ne sait pas réécrire s'affiche en lecture seule, avec sa raison.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Mail, Plus, RefreshCw, Trash2 } from "lucide-react";
import { ToggleRow } from "@/components/ui/primitives";
import { useZimbraAccount } from "@/components/zimbra-account";
import { Badge, DButton, DChip, SectionLabel, Surface, TextArea, TextInput } from "@/desktop/ui";
import {
  errorText,
  mailApi,
  type ZimbraAddressPart,
  type ZimbraFilter,
  type ZimbraFilterAction,
  type ZimbraFilterComparison,
  type ZimbraFilterInput,
  type ZimbraFilterTest,
  type ZimbraVacation,
} from "@/lib/api";
import { demoReadOnly, mailMode } from "@/lib/demo-mode";
import { cn } from "@/lib/utils";

const COMPARISONS: { value: ZimbraFilterComparison; label: string }[] = [
  { value: "contains", label: "contient" },
  { value: "notcontains", label: "ne contient pas" },
  { value: "is", label: "est" },
  { value: "notis", label: "n'est pas" },
  { value: "matches", label: "correspond au motif" },
  { value: "notmatches", label: "ne correspond pas au motif" },
];

const PARTS: { value: ZimbraAddressPart; label: string }[] = [
  { value: "all", label: "adresse entière" },
  { value: "localpart", label: "partie locale" },
  { value: "domain", label: "domaine" },
];

const TEST_KINDS = [
  { value: "header", label: "En-tête" },
  { value: "address", label: "Adresse" },
  { value: "size", label: "Taille" },
  { value: "date", label: "Date" },
] as const;

const ACTION_KINDS = [
  { value: "file_into", label: "Ranger dans un dossier" },
  { value: "flag", label: "Marquer" },
  { value: "tag", label: "Étiqueter" },
  { value: "redirect", label: "Renvoyer à" },
  { value: "keep", label: "Garder dans la boîte" },
  { value: "discard", label: "Supprimer sans lire" },
  { value: "stop", label: "Arrêter les filtres suivants" },
] as const;

const FLAGS = [
  { value: "read", label: "comme lu" },
  { value: "flagged", label: "suivi" },
] as const;

const comparisonLabel = (value: ZimbraFilterComparison): string =>
  COMPARISONS.find((entry) => entry.value === value)?.label ?? value;

const partLabel = (value: ZimbraAddressPart): string =>
  PARTS.find((entry) => entry.value === value)?.label ?? value;

function testLabel(test: ZimbraFilterTest): string {
  switch (test.kind) {
    case "header":
      return `${test.header} ${comparisonLabel(test.comparison)} « ${test.value} »`;
    case "address":
      return `${test.header} (${partLabel(test.part)}) ${comparisonLabel(test.comparison)} « ${test.value} »`;
    case "size":
      return test.comparison === "over" ? `taille au-dessus de ${test.size}` : `taille en dessous de ${test.size}`;
    case "date":
      return test.comparison === "before" ? `reçu avant le ${test.date}` : `reçu après le ${test.date}`;
  }
}

function actionLabel(action: ZimbraFilterAction): string {
  switch (action.kind) {
    case "keep":
      return "garder dans la boîte";
    case "discard":
      return "supprimer sans lire";
    case "stop":
      return "arrêter les filtres suivants";
    case "file_into":
      return `ranger dans ${action.folder_path}`;
    case "tag":
      return `étiqueter ${action.tag_name}`;
    case "flag":
      return `marquer ${action.flag_name}`;
    case "redirect":
      return `renvoyer à ${action.address}`;
  }
}

/** Le résumé d'une règle : ses conditions, puis ce qu'elle fait. */
export function filterSummary(rule: ZimbraFilter): string {
  if (rule.read_only) return "règle avancée · à modifier dans l'interface Zimbra";
  const conditions = rule.tests.map(testLabel).join(rule.condition === "allof" ? " et " : " ou ");
  const actions = rule.actions.map(actionLabel).join(", ");
  return `${conditions} → ${actions}`;
}

const isVacation = (value: unknown): value is ZimbraVacation =>
  typeof value === "object" && value !== null && typeof (value as ZimbraVacation).enabled === "boolean";

const emptyRule = (): ZimbraFilterInput => ({
  name: "",
  active: true,
  condition: "allof",
  tests: [{ kind: "header", header: "From", comparison: "contains", value: "" }],
  actions: [{ kind: "file_into", folder_path: "" }],
});

const toInput = (rule: ZimbraFilter): ZimbraFilterInput => ({
  name: rule.name,
  active: rule.active,
  condition: rule.condition,
  tests: rule.tests,
  actions: rule.actions,
});

export function ZimbraFiltersPanel({
  variant = "desktop",
  readOnly = demoReadOnly || mailMode() !== "api",
}: {
  variant?: "desktop" | "mobile";
  readOnly?: boolean;
}) {
  const { accounts, zimbra: zimbraAccounts, account, select: setSelected } = useZimbraAccount();

  const [rules, setRules] = useState<ZimbraFilter[] | null>(null);
  const [vacation, setVacation] = useState<ZimbraVacation | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readFailed, setReadFailed] = useState<string | null>(null);
  const [writeFailed, setWriteFailed] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<ZimbraFilterInput | null>(null);
  const [mode, setMode] = useState<"add" | "modify" | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setReadFailed(null);
    try {
      const [loaded, answer] = await Promise.all([mailApi.zimbraFilters(id), mailApi.zimbraVacation(id)]);
      setRules(Array.isArray(loaded) ? loaded : null);
      setVacation(isVacation(answer) ? answer : null);
      if (!Array.isArray(loaded) || !isVacation(answer)) {
        setReadFailed("Lecture impossible · réponse du démon illisible");
      }
    } catch (error) {
      setRules(null);
      setVacation(null);
      setReadFailed(`Lecture impossible · ${errorText(error)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const accountId = account?.id ?? null;

  useEffect(() => {
    setNotice(null);
    setReadFailed(null);
    setWriteFailed(null);
    setDraft(null);
    setMode(null);
    setConfirming(null);
    if (accountId && !readOnly) void load(accountId);
  }, [accountId, load, readOnly]);

  const change = async (body: Parameters<typeof mailApi.zimbraModifyFilter>[1]): Promise<boolean> => {
    if (!accountId) return false;
    setBusy(true);
    setWriteFailed(null);
    setNotice(null);
    try {
      await mailApi.zimbraModifyFilter(accountId, body);
      await load(accountId);
      return true;
    } catch (error) {
      setWriteFailed(`Écriture refusée · ${errorText(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveRule = async () => {
    if (!draft || !mode) return;
    const name = draft.name.trim();
    if (!name) {
      setWriteFailed("Le nom du filtre est vide");
      return;
    }
    if (draft.tests.length === 0) {
      setWriteFailed("Le filtre n'a aucune condition");
      return;
    }
    if (draft.actions.length === 0) {
      setWriteFailed("Le filtre n'a aucune action");
      return;
    }
    if (!(await change({ action: mode, rule: { ...draft, name } }))) return;
    setDraft(null);
    setMode(null);
    setNotice(mode === "add" ? `Filtre « ${name} » créé sur le serveur` : `Filtre « ${name} » mis à jour`);
  };

  const removeRule = async (name: string) => {
    if (!(await change({ action: "delete", rule: { name } }))) return;
    setConfirming(null);
    setNotice(`Filtre « ${name} » supprimé du serveur`);
  };

  const saveVacation = async () => {
    if (!accountId || !vacation) return;
    if (vacation.enabled && !vacation.message.trim()) {
      setWriteFailed("Une réponse d'absence active a besoin d'un message");
      return;
    }
    setBusy(true);
    setWriteFailed(null);
    setNotice(null);
    try {
      await mailApi.zimbraSetVacation(accountId, vacation);
      await load(accountId);
      setNotice("Message d'absence enregistré sur le serveur");
    } catch (error) {
      setWriteFailed(`Écriture refusée · ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const updateTest = (index: number, patch: Partial<ZimbraFilterTest>) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            tests: current.tests.map((test, position) =>
              position === index ? ({ ...test, ...patch } as ZimbraFilterTest) : test,
            ),
          }
        : current,
    );

  const updateAction = (index: number, patch: Partial<ZimbraFilterAction>) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            actions: current.actions.map((action, position) =>
              position === index ? ({ ...action, ...patch } as ZimbraFilterAction) : action,
            ),
          }
        : current,
    );

  const hint = variant === "mobile" ? "text-[11.5px]" : "text-[11px]";

  if (readOnly) {
    return (
      <Surface className="p-4">
        <p className="text-[12px] leading-relaxed font-medium text-ink-muted">
          Démo : les filtres et le message d'absence d'un compte Zimbra se règlent sur le serveur, avec le mot de
          passe du compte. Rien ne s'écrit ici.
        </p>
      </Surface>
    );
  }

  if (zimbraAccounts.length === 0) {
    return (
      <Surface className="p-4">
        <p className="text-[12px] leading-relaxed font-medium text-ink-muted">
          {accounts.length === 0
            ? "Aucun compte connecté : les filtres se règlent sur le serveur Zimbra du compte."
            : "Compte Google : les filtres se gèrent dans Gmail, l'absence dans les paramètres Google."}
        </p>
      </Surface>
    );
  }

  return (
    <div className="grid gap-3" data-testid="zimbra-filters">
      <Surface className="p-3.5">
        <div className="flex items-center gap-2">
          <SectionLabel>Compte</SectionLabel>
          <DButton
            size="sm"
            variant="plain"
            className="ml-auto"
            aria-label="Relire les filtres du serveur"
            disabled={loading || !accountId}
            onClick={() => accountId && void load(accountId)}
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} strokeWidth={2.4} />
            {loading ? "Lecture…" : "Relire"}
          </DButton>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {zimbraAccounts.map((entry) => (
            <DChip
              key={entry.id}
              active={entry.id === accountId}
              onClick={() => setSelected(entry.id)}
              aria-label={`Filtres de ${entry.label}`}
            >
              <Mail className="size-3" />
              {entry.label}
            </DChip>
          ))}
        </div>
        <p className={cn("mt-2 font-medium text-ink-muted", hint)}>
          {account?.email} · les filtres vivent sur le serveur Zimbra, rien n'est gardé ici.
        </p>
      </Surface>

      <Surface className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-2">
          <SectionLabel>Filtres</SectionLabel>
          <span className="text-[11.5px] font-semibold text-ink-muted">
            {rules === null ? "—" : `${rules.length} sur le serveur`}
          </span>
          <DButton
            size="sm"
            variant="soft"
            className="ml-auto"
            aria-label="Nouveau filtre"
            disabled={busy || rules === null}
            onClick={() => {
              setDraft(emptyRule());
              setMode("add");
              setWriteFailed(null);
              setNotice(null);
            }}
          >
            <Plus className="size-3.5" strokeWidth={2.6} />
            Nouveau
          </DButton>
        </div>

        {rules === null ? (
          <p className="px-3.5 py-3 text-[11.5px] font-medium text-ink-muted">
            {loading ? "Lecture des filtres du serveur…" : "Filtres illisibles : voir la notice plus bas."}
          </p>
        ) : rules.length === 0 ? (
          <p className="px-3.5 py-3 text-[11.5px] font-medium text-ink-muted">
            Aucun filtre sur ce compte : le serveur applique ce qu'on lui envoie.
          </p>
        ) : (
          <ul aria-label="Filtres du compte" className="divide-y divide-line">
            {rules.map((rule) => (
              <li key={rule.name} className="px-3.5 py-3">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[12.5px] font-bold text-ink">{rule.name}</span>
                  <Badge tone={rule.active ? "green" : "neutral"}>{rule.active ? "actif" : "coupé"}</Badge>
                  {rule.read_only ? <Badge tone="amber">lecture seule</Badge> : null}
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    {rule.read_only ? null : (
                      <DButton
                        size="sm"
                        variant="ghost"
                        aria-label={`Modifier le filtre ${rule.name}`}
                        disabled={busy}
                        onClick={() => {
                          setDraft(toInput(rule));
                          setMode("modify");
                          setWriteFailed(null);
                          setNotice(null);
                        }}
                      >
                        Modifier
                      </DButton>
                    )}
                    <DButton
                      size="sm"
                      variant="danger"
                      aria-label={`Supprimer le filtre ${rule.name}`}
                      disabled={busy}
                      onClick={() => setConfirming(rule.name)}
                    >
                      <Trash2 className="size-3.5" strokeWidth={2.4} />
                    </DButton>
                  </div>
                </div>
                <p className={cn("mt-1 leading-relaxed font-medium text-ink-muted", hint)}>
                  {filterSummary(rule)}
                </p>
                {confirming === rule.name ? (
                  <div className="mt-2 flex items-center gap-2 rounded-xl bg-rose-500/10 px-2.5 py-2">
                    <span className="text-[11.5px] font-semibold text-rose-700 dark:text-rose-300">
                      Supprimer « {rule.name} » sur le serveur ?
                    </span>
                    <DButton
                      size="sm"
                      variant="danger"
                      className="ml-auto"
                      disabled={busy}
                      onClick={() => void removeRule(rule.name)}
                    >
                      Confirmer
                    </DButton>
                    <DButton size="sm" variant="plain" onClick={() => setConfirming(null)}>
                      Annuler
                    </DButton>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {draft ? (
          <div className="border-t border-line bg-surface-2/40 px-3.5 py-3">
            <div className="flex items-center gap-2">
              <SectionLabel>{mode === "add" ? "Nouveau filtre" : "Modifier le filtre"}</SectionLabel>
              <DButton
                size="sm"
                variant="plain"
                className="ml-auto"
                onClick={() => {
                  setDraft(null);
                  setMode(null);
                }}
              >
                Fermer
              </DButton>
            </div>

            <div className="mt-2 grid gap-2 md:grid-cols-[1fr_auto]">
              <TextInput
                aria-label="Nom du filtre"
                placeholder="Nom du filtre"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
              <div className="flex items-center gap-1.5">
                <DChip
                  active={draft.active}
                  aria-label="Filtre actif"
                  onClick={() => setDraft({ ...draft, active: !draft.active })}
                >
                  {draft.active ? "actif" : "coupé"}
                </DChip>
                <DChip
                  active={draft.condition === "allof"}
                  aria-label="Toutes les conditions"
                  onClick={() => setDraft({ ...draft, condition: "allof" })}
                >
                  toutes
                </DChip>
                <DChip
                  active={draft.condition === "anyof"}
                  aria-label="Une des conditions"
                  onClick={() => setDraft({ ...draft, condition: "anyof" })}
                >
                  au moins une
                </DChip>
              </div>
            </div>

            <div className="mt-3 grid gap-2">
              {draft.tests.map((test, index) => (
                <div key={index} className="grid gap-1.5 rounded-xl border border-line bg-surface p-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <select
                      aria-label={`Type de la condition ${index + 1}`}
                      className="focus-ring h-8 rounded-lg border border-line bg-surface px-2 text-[11.5px] font-semibold text-ink"
                      value={test.kind}
                      onChange={(event) => {
                        const kind = event.target.value;
                        updateTest(
                          index,
                          kind === "size"
                            ? ({ kind: "size", comparison: "over", size: "1M" } as ZimbraFilterTest)
                            : kind === "date"
                              ? ({ kind: "date", comparison: "before", date: "2026-01-01" } as ZimbraFilterTest)
                              : ({
                                  kind,
                                  header: kind === "address" ? "From" : "From",
                                  ...(kind === "address" ? { part: "all" } : {}),
                                  comparison: "contains",
                                  value: "",
                                } as ZimbraFilterTest),
                        );
                      }}
                    >
                      {TEST_KINDS.map((entry) => (
                        <option key={entry.value} value={entry.value}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                    {test.kind === "header" || test.kind === "address" ? (
                      <>
                        <TextInput
                          aria-label={`En-tête de la condition ${index + 1}`}
                          className="h-8 w-24"
                          value={test.header}
                          onChange={(event) => updateTest(index, { header: event.target.value })}
                        />
                        {test.kind === "address" ? (
                          <select
                            aria-label={`Partie de l'adresse ${index + 1}`}
                            className="focus-ring h-8 rounded-lg border border-line bg-surface px-2 text-[11.5px] font-semibold text-ink"
                            value={test.part}
                            onChange={(event) =>
                              updateTest(index, { part: event.target.value as ZimbraAddressPart })
                            }
                          >
                            {PARTS.map((entry) => (
                              <option key={entry.value} value={entry.value}>
                                {entry.label}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        <select
                          aria-label={`Comparaison de la condition ${index + 1}`}
                          className="focus-ring h-8 rounded-lg border border-line bg-surface px-2 text-[11.5px] font-semibold text-ink"
                          value={test.comparison}
                          onChange={(event) =>
                            updateTest(index, { comparison: event.target.value as ZimbraFilterComparison })
                          }
                        >
                          {COMPARISONS.map((entry) => (
                            <option key={entry.value} value={entry.value}>
                              {entry.label}
                            </option>
                          ))}
                        </select>
                        <TextInput
                          aria-label={`Valeur de la condition ${index + 1}`}
                          className="h-8 min-w-32 flex-1"
                          value={test.value}
                          onChange={(event) => updateTest(index, { value: event.target.value })}
                        />
                      </>
                    ) : test.kind === "size" ? (
                      <>
                        <select
                          aria-label={`Comparaison de la condition ${index + 1}`}
                          className="focus-ring h-8 rounded-lg border border-line bg-surface px-2 text-[11.5px] font-semibold text-ink"
                          value={test.comparison}
                          onChange={(event) =>
                            updateTest(index, { comparison: event.target.value as "over" | "under" })
                          }
                        >
                          <option value="over">au-dessus de</option>
                          <option value="under">en dessous de</option>
                        </select>
                        <TextInput
                          aria-label={`Taille de la condition ${index + 1}`}
                          className="h-8 w-24"
                          value={test.size}
                          onChange={(event) => updateTest(index, { size: event.target.value })}
                        />
                      </>
                    ) : (
                      <>
                        <select
                          aria-label={`Comparaison de la condition ${index + 1}`}
                          className="focus-ring h-8 rounded-lg border border-line bg-surface px-2 text-[11.5px] font-semibold text-ink"
                          value={test.comparison}
                          onChange={(event) =>
                            updateTest(index, { comparison: event.target.value as "before" | "after" })
                          }
                        >
                          <option value="before">reçu avant</option>
                          <option value="after">reçu après</option>
                        </select>
                        <TextInput
                          aria-label={`Date de la condition ${index + 1}`}
                          type="date"
                          className="h-8 w-36"
                          value={test.date}
                          onChange={(event) => updateTest(index, { date: event.target.value })}
                        />
                      </>
                    )}
                    <DButton
                      size="sm"
                      variant="plain"
                      aria-label={`Retirer la condition ${index + 1}`}
                      className="ml-auto"
                      onClick={() =>
                        setDraft({ ...draft, tests: draft.tests.filter((_, position) => position !== index) })
                      }
                    >
                      <Trash2 className="size-3.5" strokeWidth={2.4} />
                    </DButton>
                  </div>
                </div>
              ))}
              <DButton
                size="sm"
                variant="ghost"
                className="justify-self-start"
                aria-label="Ajouter une condition"
                onClick={() =>
                  setDraft({
                    ...draft,
                    tests: [...draft.tests, { kind: "header", header: "Subject", comparison: "contains", value: "" }],
                  })
                }
              >
                <Plus className="size-3.5" strokeWidth={2.6} />
                Condition
              </DButton>
            </div>

            <div className="mt-3 grid gap-2">
              {draft.actions.map((action, index) => (
                <div
                  key={index}
                  className="flex flex-wrap items-center gap-1.5 rounded-xl border border-line bg-surface p-2"
                >
                  <select
                    aria-label={`Type de l'action ${index + 1}`}
                    className="focus-ring h-8 rounded-lg border border-line bg-surface px-2 text-[11.5px] font-semibold text-ink"
                    value={action.kind}
                    onChange={(event) => {
                      const kind = event.target.value;
                      updateAction(
                        index,
                        kind === "file_into"
                          ? ({ kind: "file_into", folder_path: "" } as ZimbraFilterAction)
                          : kind === "tag"
                            ? ({ kind: "tag", tag_name: "" } as ZimbraFilterAction)
                            : kind === "flag"
                              ? ({ kind: "flag", flag_name: "read" } as ZimbraFilterAction)
                              : kind === "redirect"
                                ? ({ kind: "redirect", address: "" } as ZimbraFilterAction)
                                : ({ kind } as ZimbraFilterAction),
                      );
                    }}
                  >
                    {ACTION_KINDS.map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                  {action.kind === "file_into" ? (
                    <TextInput
                      aria-label={`Dossier de l'action ${index + 1}`}
                      className="h-8 min-w-32 flex-1"
                      placeholder="Dossier (chemin Zimbra)"
                      value={action.folder_path}
                      onChange={(event) => updateAction(index, { folder_path: event.target.value })}
                    />
                  ) : action.kind === "tag" ? (
                    <TextInput
                      aria-label={`Étiquette de l'action ${index + 1}`}
                      className="h-8 min-w-32 flex-1"
                      placeholder="Étiquette"
                      value={action.tag_name}
                      onChange={(event) => updateAction(index, { tag_name: event.target.value })}
                    />
                  ) : action.kind === "redirect" ? (
                    <TextInput
                      aria-label={`Adresse de l'action ${index + 1}`}
                      className="h-8 min-w-32 flex-1"
                      placeholder="adresse@exemple.tld"
                      value={action.address}
                      onChange={(event) => updateAction(index, { address: event.target.value })}
                    />
                  ) : action.kind === "flag" ? (
                    <select
                      aria-label={`Marque de l'action ${index + 1}`}
                      className="focus-ring h-8 rounded-lg border border-line bg-surface px-2 text-[11.5px] font-semibold text-ink"
                      value={action.flag_name}
                      onChange={(event) => updateAction(index, { flag_name: event.target.value })}
                    >
                      {FLAGS.map((entry) => (
                        <option key={entry.value} value={entry.value}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <DButton
                    size="sm"
                    variant="plain"
                    aria-label={`Retirer l'action ${index + 1}`}
                    className="ml-auto"
                    onClick={() =>
                      setDraft({ ...draft, actions: draft.actions.filter((_, position) => position !== index) })
                    }
                  >
                    <Trash2 className="size-3.5" strokeWidth={2.4} />
                  </DButton>
                </div>
              ))}
              <DButton
                size="sm"
                variant="ghost"
                className="justify-self-start"
                aria-label="Ajouter une action"
                onClick={() =>
                  setDraft({
                    ...draft,
                    actions: [...draft.actions, { kind: "file_into", folder_path: "" }],
                  })
                }
              >
                <Plus className="size-3.5" strokeWidth={2.6} />
                Action
              </DButton>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <DButton variant="primary" disabled={busy} aria-label="Enregistrer le filtre" onClick={() => void saveRule()}>
                {busy ? "Envoi…" : "Enregistrer sur le serveur"}
              </DButton>
              <span className="text-[10.5px] font-medium text-ink-muted">
                « ModifyFilterRules » réécrit la liste entière : les règles non touchées reviennent telles quelles.
              </span>
            </div>
          </div>
        ) : null}
      </Surface>

      <Surface className="overflow-hidden">
        <div className="border-b border-line px-3.5 py-2">
          <SectionLabel>Message d'absence</SectionLabel>
        </div>
        {vacation === null ? (
          <p className="px-3.5 py-3 text-[11.5px] font-medium text-ink-muted">
            {loading ? "Lecture du message d'absence…" : "Message d'absence illisible : voir la notice plus bas."}
          </p>
        ) : (
          <div>
            <ToggleRow
              icon={<AlertTriangle className="size-4" />}
              label="Répondre automatiquement"
              hint="Le serveur répond aux mails entrants pendant l'absence"
              checked={vacation.enabled}
              onChange={(enabled) => setVacation({ ...vacation, enabled })}
            />
            <div className="grid gap-2 px-3.5 py-3">
              <TextArea
                aria-label="Message d'absence"
                rows={4}
                placeholder="Je suis absent jusqu'à lundi, je réponds à mon retour."
                value={vacation.message}
                onChange={(event) => setVacation({ ...vacation, message: event.target.value })}
              />
              <div className="flex flex-wrap items-center gap-2">
                <label className={cn("flex items-center gap-1.5 font-semibold text-ink-soft", hint)}>
                  Du
                  <TextInput
                    aria-label="Début de l'absence"
                    type="date"
                    className="h-8 w-36"
                    value={vacation.from ?? ""}
                    onChange={(event) => setVacation({ ...vacation, from: event.target.value })}
                  />
                </label>
                <label className={cn("flex items-center gap-1.5 font-semibold text-ink-soft", hint)}>
                  au
                  <TextInput
                    aria-label="Fin de l'absence"
                    type="date"
                    className="h-8 w-36"
                    value={vacation.until ?? ""}
                    onChange={(event) => setVacation({ ...vacation, until: event.target.value })}
                  />
                </label>
                <DButton
                  variant="primary"
                  className="ml-auto"
                  disabled={busy}
                  aria-label="Enregistrer l'absence"
                  onClick={() => void saveVacation()}
                >
                  {busy ? "Envoi…" : "Enregistrer l'absence"}
                </DButton>
              </div>
              <p className={cn("font-medium text-ink-muted", hint)}>
                Dates facultatives : vides, la réponse court tant que l'interrupteur est ouvert. Le serveur les garde
                en temps universel.
              </p>
            </div>
          </div>
        )}
      </Surface>

      {readFailed ? (
        <p role="status" aria-live="polite" className="text-[11.5px] font-semibold text-red-700 dark:text-red-300">
          {readFailed}
        </p>
      ) : null}
      {writeFailed ? (
        <p role="alert" className="text-[11.5px] font-semibold text-red-700 dark:text-red-300">
          {writeFailed}
        </p>
      ) : null}
      {notice ? (
        <p role="status" aria-live="polite" className="text-[11.5px] font-semibold text-ink-muted">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
