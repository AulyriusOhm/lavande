/**
 * Les étiquettes Zimbra du message ouvert : une pastille par étiquette du
 * serveur, et un bouton qui ouvre le choix (poser, retirer, créer à la volée).
 * Le serveur est la seule source ; un message que Zimbra ne retrouve pas laisse
 * la ligne vide plutôt que d'alerter le lecteur.
 */

import { useEffect, useState } from "react";
import { Tag as TagIcon } from "lucide-react";
import { errorText, mailApi, type ZimbraTag } from "@/lib/api";
import { demoReadOnly, mailMode } from "@/lib/demo-mode";
import type { MailSource } from "@/lib/mail";
import { ZIMBRA_TAG_COLORS, sortedTags, tagDot } from "@/lib/zimbra-tags";
import { cn } from "@/lib/utils";

export function MessageTags({
  source,
  className,
}: {
  source?: MailSource;
  className?: string;
}) {
  const readOnly = demoReadOnly || mailMode() !== "api";
  const accountId = source?.accountId ?? null;
  const folder = source?.folderPath ?? null;
  const uid = source?.uid ?? null;

  const [tags, setTags] = useState<ZimbraTag[] | null>(null);
  const [catalog, setCatalog] = useState<ZimbraTag[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(1);

  useEffect(() => {
    setTags(null);
    setCatalog(null);
    setFailed(null);
    setOpen(false);
    setName("");
    if (accountId === null || folder === null || uid === null || readOnly) return;
    let cancelled = false;
    void mailApi.zimbraMessageTags(accountId, folder, uid).then(
      (loaded) => {
        if (!cancelled) setTags(sortedTags(Array.isArray(loaded) ? loaded : []));
      },
      (error: unknown) => {
        if (!cancelled) setFailed(errorText(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [accountId, folder, uid, readOnly]);

  const togglePicker = async () => {
    setOpen((current) => !current);
    if (catalog !== null || accountId === null) return;
    try {
      const loaded = await mailApi.zimbraTags(accountId);
      setCatalog(sortedTags(Array.isArray(loaded) ? loaded : []));
      setFailed(null);
    } catch (error) {
      setFailed(errorText(error));
    }
  };

  const toggle = async (tag: ZimbraTag) => {
    if (accountId === null || folder === null || uid === null) return;
    const add = !(tags ?? []).some((entry) => entry.id === tag.id);
    setBusy(true);
    setFailed(null);
    try {
      const answer = await mailApi.zimbraTagMessage(accountId, {
        folder,
        uid,
        tag_id: tag.id,
        add,
      });
      setTags(sortedTags(Array.isArray(answer) ? answer : []));
    } catch (error) {
      setFailed(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (accountId === null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setFailed("Le nom de l'étiquette est vide");
      return;
    }
    setBusy(true);
    setFailed(null);
    try {
      const created = await mailApi.zimbraCreateTag(accountId, { name: trimmed, color });
      setCatalog((current) => sortedTags([...(current ?? []), created]));
      setName("");
      if (folder !== null && uid !== null) {
        const answer = await mailApi.zimbraTagMessage(accountId, {
          folder,
          uid,
          tag_id: created.id,
          add: true,
        });
        setTags(sortedTags(Array.isArray(answer) ? answer : []));
      }
    } catch (error) {
      setFailed(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  if (!source || readOnly) return null;
  const current = tags ?? [];

  return (
    <div className={cn("mt-2 flex flex-wrap items-center gap-1.5", className)} data-testid="message-tags">
      {current.map((tag) => (
        <span
          key={tag.id}
          data-testid="message-tag"
          className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-[10.5px] font-bold text-ink-soft"
        >
          <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: tagDot(tag.color) }} />
          {tag.name}
        </span>
      ))}
      <button
        type="button"
        aria-label="Étiqueter le message"
        aria-expanded={open}
        onClick={() => void togglePicker()}
        className="focus-ring inline-flex h-6 items-center gap-1 rounded-full border border-line bg-surface px-2 text-[10.5px] font-bold text-ink-muted transition-colors hover:border-accent-ring hover:text-accent-ink"
      >
        <TagIcon className="size-3" strokeWidth={2.6} />
        Étiqueter
      </button>

      {open ? (
        <div className="mt-1 w-full rounded-xl border border-line bg-surface p-2">
          <ul aria-label="Étiquettes du serveur" className="flex flex-wrap gap-1.5">
            {(catalog ?? []).map((tag) => {
              const posed = current.some((entry) => entry.id === tag.id);
              return (
                <li key={tag.id}>
                  <button
                    type="button"
                    aria-pressed={posed}
                    aria-label={`${posed ? "Retirer" : "Poser"} l'étiquette ${tag.name}`}
                    disabled={busy}
                    onClick={() => void toggle(tag)}
                    className={cn(
                      "focus-ring inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-bold transition-colors disabled:opacity-60",
                      posed
                        ? "border-accent-ring bg-accent-soft text-accent-ink"
                        : "border-line bg-surface text-ink-soft hover:border-accent-ring",
                    )}
                  >
                    <span
                      aria-hidden
                      className="size-2 rounded-full"
                      style={{ backgroundColor: tagDot(tag.color) }}
                    />
                    {tag.name}
                  </button>
                </li>
              );
            })}
          </ul>
          {catalog !== null && catalog.length === 0 ? (
            <p className="mt-1 text-[10.5px] font-medium text-ink-muted">
              Aucune étiquette sur ce compte.
            </p>
          ) : null}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <input
              aria-label="Nom de la nouvelle étiquette"
              placeholder="Nouvelle étiquette"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="focus-ring h-7 min-w-28 flex-1 rounded-lg border border-line bg-surface px-2 text-[11px] font-medium text-ink"
            />
            <div role="group" aria-label="Couleur de l'étiquette" className="flex items-center gap-1">
              {ZIMBRA_TAG_COLORS.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  aria-label={entry.label}
                  aria-pressed={color === entry.value}
                  onClick={() => setColor(entry.value)}
                  className={cn(
                    "focus-ring size-5 rounded-full border-2",
                    color === entry.value ? "border-ink" : "border-transparent",
                  )}
                  style={{ backgroundColor: entry.dot }}
                />
              ))}
            </div>
            <button
              type="button"
              aria-label="Créer et étiqueter"
              disabled={busy}
              onClick={() => void create()}
              className="focus-ring inline-flex h-7 items-center rounded-lg bg-accent px-2 text-[10.5px] font-bold text-accent-contrast disabled:opacity-60"
            >
              Créer et étiqueter
            </button>
          </div>

          {failed ? (
            <p role="status" aria-live="polite" className="mt-1.5 text-[10.5px] font-semibold text-red-700 dark:text-red-300">
              {failed}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
