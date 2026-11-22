/**
 * Gestionnaire des étiquettes Zimbra d'un compte : le serveur en est la seule
 * source (création, renommage, couleur, suppression), rien n'est rangé ici.
 * Un message étiqueté porte l'étiquette sur le serveur, quel que soit le
 * client qui l'ouvre.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Pencil, Plus, RefreshCw, Tag as TagIcon, Trash2 } from "lucide-react";
import { useZimbraAccount } from "@/components/zimbra-account";
import { Badge, DButton, DChip, SectionLabel, Surface, TextInput } from "@/desktop/ui";
import { errorText, mailApi, type ZimbraTag } from "@/lib/api";
import { demoReadOnly, mailMode } from "@/lib/demo-mode";
import { ZIMBRA_TAG_COLORS, sortedTags, tagColorLabel, tagDot } from "@/lib/zimbra-tags";
import { cn } from "@/lib/utils";

export function ZimbraTagsPanel({
  variant = "desktop",
  readOnly = demoReadOnly || mailMode() !== "api",
}: {
  variant?: "desktop" | "mobile";
  readOnly?: boolean;
}) {
  const { accounts, zimbra: zimbraAccounts, account, select } = useZimbraAccount();
  const accountId = account?.id ?? null;

  const [tags, setTags] = useState<ZimbraTag[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readFailed, setReadFailed] = useState<string | null>(null);
  const [writeFailed, setWriteFailed] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState(1);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState(1);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setReadFailed(null);
    try {
      const loaded = await mailApi.zimbraTags(id);
      setTags(Array.isArray(loaded) ? sortedTags(loaded) : null);
      if (!Array.isArray(loaded)) {
        setReadFailed("Lecture impossible · réponse du démon illisible");
      }
    } catch (error) {
      setTags(null);
      setReadFailed(`Lecture impossible · ${errorText(error)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setTags(null);
    setReadFailed(null);
    setWriteFailed(null);
    setNotice(null);
    setEditing(null);
    setConfirming(null);
    setName("");
    if (accountId && !readOnly) void load(accountId);
  }, [accountId, load, readOnly]);

  const write = async (action: () => Promise<unknown>, done: string): Promise<boolean> => {
    if (!accountId) return false;
    setBusy(true);
    setWriteFailed(null);
    setNotice(null);
    try {
      await action();
      await load(accountId);
      setNotice(done);
      return true;
    } catch (error) {
      setWriteFailed(`Écriture refusée · ${errorText(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setWriteFailed("Le nom de l'étiquette est vide");
      return;
    }
    if (!accountId) return;
    const id = accountId;
    if (await write(() => mailApi.zimbraCreateTag(id, { name: trimmed, color }), `Étiquette « ${trimmed} » créée`)) {
      setName("");
    }
  };

  const rename = async (tag: ZimbraTag) => {
    const trimmed = editName.trim();
    if (!trimmed) {
      setWriteFailed("Le nom de l'étiquette est vide");
      return;
    }
    if (!accountId) return;
    const id = accountId;
    const same = trimmed === tag.name && editColor === tag.color;
    if (same) {
      setEditing(null);
      return;
    }
    const ok = await write(
      () => mailApi.zimbraModifyTag(id, tag.id, { name: trimmed, color: editColor }),
      `Étiquette « ${trimmed} » enregistrée`,
    );
    if (ok) setEditing(null);
  };

  const remove = async (tag: ZimbraTag) => {
    if (!accountId) return;
    const id = accountId;
    if (await write(() => mailApi.zimbraDeleteTag(id, tag.id), `Étiquette « ${tag.name} » supprimée`)) {
      setConfirming(null);
    }
  };

  const hint = variant === "mobile" ? "text-[11.5px]" : "text-[11px]";
  const swatches = (selected: number, pick: (value: number) => void) => (
    <div role="group" aria-label="Couleur de l'étiquette" className="flex items-center gap-1">
      {ZIMBRA_TAG_COLORS.map((entry) => (
        <button
          key={entry.value}
          type="button"
          aria-label={entry.label}
          aria-pressed={selected === entry.value}
          onClick={() => pick(entry.value)}
          className={cn(
            "focus-ring size-5 rounded-full border-2",
            selected === entry.value ? "border-ink" : "border-transparent",
          )}
          style={{ backgroundColor: entry.dot }}
        />
      ))}
    </div>
  );

  if (readOnly) {
    return (
      <Surface className="p-4">
        <p className="text-[12px] leading-relaxed font-medium text-ink-muted">
          Démo : les étiquettes d'un compte Zimbra vivent sur le serveur, avec le mot de passe du compte. Rien ne
          s'écrit ici.
        </p>
      </Surface>
    );
  }

  if (zimbraAccounts.length === 0) {
    return (
      <Surface className="p-4">
        <p className="text-[12px] leading-relaxed font-medium text-ink-muted">
          {accounts.length === 0
            ? "Aucun compte connecté : les étiquettes sont celles du serveur Zimbra du compte."
            : "Compte Google : les étiquettes se gèrent dans Gmail."}
        </p>
      </Surface>
    );
  }

  return (
    <div className="grid gap-3" data-testid="zimbra-tags">
      <Surface className="p-3.5">
        <div className="flex items-center gap-2">
          <SectionLabel>Étiquettes</SectionLabel>
          <DButton
            size="sm"
            variant="plain"
            className="ml-auto"
            aria-label="Relire les étiquettes du serveur"
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
              onClick={() => select(entry.id)}
              aria-label={`Étiquettes de ${entry.label}`}
            >
              <TagIcon className="size-3" />
              {entry.label}
            </DChip>
          ))}
        </div>
        <p className={cn("mt-2 font-medium text-ink-muted", hint)}>
          {account?.email} · une étiquette posée ici est celle du serveur, visible dans tous les clients.
        </p>
      </Surface>

      <Surface className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-2">
          <SectionLabel>Sur le compte</SectionLabel>
          <span className="text-[11.5px] font-semibold text-ink-muted">
            {tags === null ? "—" : `${tags.length} étiquette${tags.length > 1 ? "s" : ""}`}
          </span>
        </div>

        {tags === null ? (
          <p className="px-3.5 py-3 text-[11.5px] font-medium text-ink-muted">
            {loading ? "Lecture des étiquettes du serveur…" : "Étiquettes illisibles : voir la notice plus bas."}
          </p>
        ) : tags.length === 0 ? (
          <p className="px-3.5 py-3 text-[11.5px] font-medium text-ink-muted">
            Aucune étiquette sur ce compte.
          </p>
        ) : (
          <ul aria-label="Étiquettes du compte" className="divide-y divide-line">
            {tags.map((tag) => (
              <li key={tag.id} className="px-3.5 py-2.5">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tagDot(tag.color) }}
                  />
                  <span className="truncate text-[12.5px] font-bold text-ink">{tag.name}</span>
                  <span className={cn("font-medium text-ink-muted", hint)}>{tagColorLabel(tag.color)}</span>
                  {typeof tag.count === "number" && tag.count > 0 ? (
                    <Badge tone="neutral">{tag.count}</Badge>
                  ) : null}
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <DButton
                      size="sm"
                      variant="ghost"
                      aria-label={`Renommer l'étiquette ${tag.name}`}
                      disabled={busy}
                      onClick={() => {
                        setEditing(tag.id);
                        setEditName(tag.name);
                        setEditColor(tag.color);
                        setConfirming(null);
                        setWriteFailed(null);
                      }}
                    >
                      <Pencil className="size-3.5" strokeWidth={2.4} />
                    </DButton>
                    <DButton
                      size="sm"
                      variant="danger"
                      aria-label={`Supprimer l'étiquette ${tag.name}`}
                      disabled={busy}
                      onClick={() => setConfirming(tag.id)}
                    >
                      <Trash2 className="size-3.5" strokeWidth={2.4} />
                    </DButton>
                  </div>
                </div>

                {editing === tag.id ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-xl bg-surface-2/60 px-2.5 py-2">
                    <TextInput
                      aria-label={`Nouveau nom de l'étiquette ${tag.name}`}
                      className="h-8 min-w-32 flex-1"
                      value={editName}
                      onChange={(event) => setEditName(event.target.value)}
                    />
                    {swatches(editColor, setEditColor)}
                    <DButton
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      aria-label={`Enregistrer l'étiquette ${tag.name}`}
                      onClick={() => void rename(tag)}
                    >
                      Enregistrer
                    </DButton>
                    <DButton size="sm" variant="plain" onClick={() => setEditing(null)}>
                      Annuler
                    </DButton>
                  </div>
                ) : null}

                {confirming === tag.id ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-rose-500/10 px-2.5 py-2">
                    <span className="text-[11.5px] font-semibold text-rose-700 dark:text-rose-300">
                      Supprimer « {tag.name} » sur le serveur, et sur les messages qui la portent ?
                    </span>
                    <DButton
                      size="sm"
                      variant="danger"
                      className="ml-auto"
                      disabled={busy}
                      aria-label={`Confirmer la suppression de l'étiquette ${tag.name}`}
                      onClick={() => void remove(tag)}
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

        <div className="border-t border-line bg-surface-2/40 px-3.5 py-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <TextInput
              aria-label="Nom de l'étiquette"
              placeholder="Nouvelle étiquette"
              className="h-9 min-w-32 flex-1"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            {swatches(color, setColor)}
            <DButton
              variant="primary"
              disabled={busy}
              aria-label="Créer l'étiquette"
              onClick={() => void create()}
            >
              <Plus className="size-4" strokeWidth={2.6} />
              {busy ? "Envoi…" : "Créer"}
            </DButton>
          </div>
          <p className={cn("mt-1.5 flex items-center gap-1 font-medium text-ink-muted", hint)}>
            <AlertTriangle className="size-3" />
            La couleur est celle du web Zimbra ; supprimer une étiquette la retire des messages qui la portent.
          </p>
        </div>
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
