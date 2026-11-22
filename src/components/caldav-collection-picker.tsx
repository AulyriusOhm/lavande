/**
 * Choix de la collection CalDAV d'une source : celle que le serveur annonce,
 * ou le chemin explicite d'un calendrier partagé (`/dav/<email>/Calendar/`).
 * Le composant ne connaît pas les identifiants : l'appelant fournit `load`, qui
 * interroge le démon avec le mot de passe du compte ou celui du coffre.
 */

import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { DButton, TextInput } from "@/desktop/ui";
import type { CaldavCollection } from "@/lib/api";
import { cn } from "@/lib/utils";

export function CaldavCollectionPicker({
  load,
  href,
  onChoose,
  label = "Choisir le calendrier",
  pathLabel = "Chemin du calendrier",
  placeholder = "/dav/<email>/Calendar/",
  disabled = false,
  readOnly = false,
}: {
  load: () => Promise<CaldavCollection[] | null>;
  href: string;
  onChoose: (href: string) => void;
  label?: string;
  /** Libellé du champ de chemin, pour distinguer deux sélecteurs d'un écran. */
  pathLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [collections, setCollections] = useState<CaldavCollection[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  if (readOnly) return null;

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (collections !== null) return;
    setBusy(true);
    setFailed(null);
    try {
      const list = await load();
      setCollections(list);
      if (list === null) {
        setFailed("Calendriers illisibles · voir la notice des calendriers");
      }
    } finally {
      setBusy(false);
    }
  };

  const choose = (value: string) => {
    onChoose(value);
    setOpen(false);
  };

  return (
    <div className="grid gap-1.5" data-testid="caldav-collection-picker">
      <div className="flex flex-wrap items-center gap-1.5">
        <DButton
          variant="ghost"
          size="sm"
          aria-label={label}
          aria-expanded={open}
          disabled={disabled || busy}
          onClick={() => void toggle()}
        >
          <CalendarDays className={cn("size-3.5", busy && "animate-pulse")} strokeWidth={2.4} />
          {busy ? "Lecture…" : label}
        </DButton>
        <TextInput
          aria-label={pathLabel}
          placeholder={placeholder}
          value={href}
          disabled={disabled}
          onChange={(event) => onChoose(event.target.value)}
          className="h-8 min-w-[180px] flex-1 text-[11.5px] font-semibold"
        />
        {href ? (
          <DButton
            variant="plain"
            size="sm"
            aria-label="Retirer le calendrier choisi"
            disabled={disabled}
            onClick={() => choose("")}
          >
            Effacer
          </DButton>
        ) : null}
      </div>

      {failed ? (
        <p role="status" aria-live="polite" className="text-[10.5px] font-semibold text-rose-700 dark:text-rose-300">
          {failed}
        </p>
      ) : null}

      {open ? (
        <ul
          aria-label="Calendriers du serveur"
          className="grid gap-1 rounded-xl border border-line bg-surface p-1.5"
        >
          {collections === null ? (
            <li className="px-1.5 py-1 text-[10.5px] font-semibold text-ink-muted">
              {busy ? "Lecture des calendriers du serveur…" : "Aucune réponse du serveur."}
            </li>
          ) : collections.length === 0 ? (
            <li className="px-1.5 py-1 text-[10.5px] font-semibold text-ink-muted">
              Ce serveur n'annonce aucun calendrier.
            </li>
          ) : (
            collections.map((collection) => (
              <li key={collection.href}>
                <button
                  type="button"
                  aria-label={`Calendrier ${collection.name}`}
                  aria-pressed={href === collection.href}
                  onClick={() => choose(collection.href)}
                  className={cn(
                    "focus-ring flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                    href === collection.href
                      ? "bg-accent-soft text-accent-ink"
                      : "text-ink-soft hover:bg-surface-2",
                  )}
                >
                  <span className="truncate text-[11.5px] font-bold">{collection.name}</span>
                  <span className="truncate text-[10px] font-medium text-ink-muted">
                    {collection.description ?? collection.href}
                  </span>
                </button>
              </li>
            ))
          )}
          <li>
            <button
              type="button"
              aria-label="Tous les calendriers découverts"
              aria-pressed={href === ""}
              onClick={() => choose("")}
              className="focus-ring flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              Tous les calendriers découverts
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
