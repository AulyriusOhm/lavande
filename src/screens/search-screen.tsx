import { useEffect, useMemo, useState } from "react";
import { RotateCcw, Search, X } from "lucide-react";
import type { Mail } from "@/lib/mail";
import { frequentContacts, normalize } from "@/lib/mail";
import type { SearchFilter } from "@/lib/search-query";
import { readRecentSearches, writeRecentSearches } from "@/lib/recent-searches";
import { buildThreads } from "@/lib/threads";
import { useMailStore } from "@/lib/store";
import { Avatar, Chip } from "@/components/ui/primitives";
import { BlurFade } from "@/components/ui/blur-fade";
import { MeshGlow } from "@/components/ui/backdrops";
import { ThreadRow } from "@/components/thread-row";

const SCOPES = ["Tout", "Non lus", "Fichiers", "Contacts"] as const;

type Scope = (typeof SCOPES)[number];

/** Les scopes qui filtrent la recherche côté démon. */
const SCOPE_FILTERS: Record<Scope, SearchFilter> = {
  Tout: {},
  "Non lus": { unread: true },
  Fichiers: { hasAttachment: true },
  Contacts: {},
};

const OPERATORS =
  "from: to: subject: in: is:unread is:starred has:attachment before:2026-01-31 after:2026-01-01";

export function SearchScreen({
  onOpen,
  onToggleStar,
  onMailAction,
  onReply,
  onNotSpam,
  onRestore,
}: {
  onOpen: (mail: Mail) => void;
  onToggleStar: (id: string) => void;
  onMailAction: (kind: "delete" | "archive" | "read", mail: Mail) => void;
  onReply: (mail: Mail) => void;
  onNotSpam?: (mail: Mail) => void;
  onRestore?: (mail: Mail) => void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("Tout");
  const [recent, setRecent] = useState<string[]>(readRecentSearches);

  const commitRecent = (next: string[]) => {
    setRecent(next);
    writeRecentSearches(next);
  };

  const trimmed = query.trim();

  const { searchMails, mails } = useMailStore();
  const [found, setFound] = useState<Mail[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!trimmed) {
      setFound([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchMails(trimmed, SCOPE_FILTERS[scope]).then((messages) => {
        if (cancelled) return;
        setFound(messages);
        setSearching(false);
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [trimmed, scope, searchMails]);

  const results = useMemo(() => (scope === "Contacts" ? [] : found), [found, scope]);

  const threads = useMemo(
    () => (scope === "Contacts" ? [] : buildThreads(results)),
    [results, scope],
  );

  const allContacts = useMemo(() => frequentContacts(mails), [mails]);

  const contacts = useMemo(() => {
    const needle = normalize(trimmed);
    if (!needle) return [];
    return allContacts.filter(
      (contact) => normalize(contact.name).includes(needle) || normalize(contact.email).includes(needle),
    );
  }, [allContacts, trimmed]);

  const resetSearch = () => {
    setQuery("");
    setScope("Tout");
  };

  const empty = trimmed !== "" && !searching && (scope === "Contacts" ? contacts.length === 0 : results.length === 0);

  return (
    <div className="relative h-full overflow-y-auto no-scrollbar pb-32">
      <MeshGlow className="h-48" />

      <header className="relative px-5 pt-4">
        <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-muted uppercase">Explorer</p>
        <h1 className="mt-1.5 text-[27px] leading-none font-extrabold tracking-[-0.035em] text-ink">
          Recherche
        </h1>

        <div className="mt-5 flex items-center gap-2">
          <div className="flex h-12 flex-1 items-center gap-2.5 rounded-2xl border border-line bg-surface px-3.5 shadow-[0_8px_24px_-22px_var(--accent)] focus-within:border-accent-ring focus-within:shadow-[0_10px_28px_-18px_var(--accent)]">
            <Search className="size-4.5 shrink-0 text-ink-muted" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Rechercher un message ou un contact"
              placeholder="Rechercher un message…"
              className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-ink-muted"
            />
            {query ? (
              <button
                type="button"
                aria-label="Effacer la recherche"
                onClick={resetSearch}
                className="relative grid size-6 place-items-center rounded-full bg-surface-2 text-ink-muted before:absolute before:-inset-2.5 before:rounded-full before:content-['']"
              >
                <X className="size-3.5" />
              </button>
            ) : (
              <span className="hidden rounded-lg bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold text-ink-muted sm:inline">
                ⌘K
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="mt-4 flex gap-2 overflow-x-auto px-5 pb-1 no-scrollbar">
        {SCOPES.map((item) => (
          <Chip key={item} active={scope === item} onClick={() => setScope(item)}>
            {item}
          </Chip>
        ))}
      </div>

      {trimmed === "" ? (
        <>
          <div className="px-5 pt-7">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
                Recherches récentes
              </p>
              {recent.length ? (
                <button
                  type="button"
                  onClick={() => commitRecent([])}
                  className="text-[11px] font-bold text-accent-ink"
                >
                  Tout effacer
                </button>
              ) : null}
            </div>
            {recent.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {recent.map((item, index) => (
                  <BlurFade key={item} delay={0.04 * index} yOffset={6}>
                    <span className="inline-flex items-center rounded-full border border-line bg-surface">
                      <button
                        type="button"
                        onClick={() => setQuery(item)}
                        className="rounded-full py-2 pr-1 pl-3.5 text-[12.5px] font-semibold text-ink-soft transition-colors hover:text-accent-ink"
                      >
                        {item}
                      </button>
                      <button
                        type="button"
                        aria-label={`Retirer « ${item} » des recherches récentes`}
                        onClick={() => commitRecent(recent.filter((entry) => entry !== item))}
                        className="relative mr-1 grid size-6 place-items-center rounded-full text-ink-muted transition-colors before:absolute before:-inset-2.5 before:rounded-full before:content-[''] hover:bg-surface-2 hover:text-ink"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  </BlurFade>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-[11.5px] font-medium text-ink-muted">Aucune recherche récente.</p>
            )}
          </div>

          <div className="px-5 pt-7">
            <p className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
              Contacts fréquents
            </p>
            <div className="mt-3 flex gap-3 overflow-x-auto pb-1 no-scrollbar">
              {allContacts.slice(0, 8).map((contact) => (
                <button
                  key={contact.email}
                  type="button"
                  onClick={() => setQuery(contact.name)}
                  className="flex w-16 shrink-0 flex-col items-center gap-1.5 transition-transform active:scale-95"
                >
                  <Avatar name={contact.name} tone={contact.tone} size={46} />
                  <span className="w-full truncate text-center text-[10.5px] font-semibold text-ink-soft">
                    {contact.name.split(" ")[0]}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <BlurFade delay={0.15}>
            <div className="mx-5 mt-7 rounded-3xl border border-dashed border-line bg-surface/60 p-4 text-center">
              <p className="text-[11.5px] font-bold text-ink">Opérateurs de recherche</p>
              <p className="mx-auto mt-1.5 max-w-[280px] text-[11px] leading-relaxed font-medium text-ink-muted">
                {OPERATORS}
              </p>
            </div>
          </BlurFade>
        </>
      ) : (
        <div className="mt-4 px-1">
          <p className="px-4 pb-2 text-[11.5px] font-semibold text-ink-muted" role="status">
            {scope === "Contacts"
              ? `${contacts.length} contact${contacts.length > 1 ? "s" : ""} pour « ${trimmed} »`
              : searching
                ? `Recherche de « ${trimmed} »…`
                : `${threads.length} résultat${threads.length > 1 ? "s" : ""} pour « ${trimmed} »`}
          </p>

          {scope === "Contacts" ? (
            <div className="space-y-1">
              {contacts.map((contact, index) => (
                <BlurFade key={contact.email} delay={index * 0.04} yOffset={14}>
                  <div className="flex items-center gap-3 rounded-[22px] px-3 py-3">
                    <Avatar name={contact.name} tone={contact.tone} size={42} />
                    <div className="min-w-0 flex-1 leading-tight">
                      <p className="truncate text-[13.5px] font-bold text-ink">{contact.name}</p>
                      <p className="truncate text-[11.5px] font-medium text-ink-muted">{contact.email}</p>
                    </div>
                  </div>
                </BlurFade>
              ))}
            </div>
          ) : (
            <div className="space-y-1">
              {threads.map((thread, index) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  delay={index * 0.04}
                  onOpen={() => onOpen(thread.primary)}
                  onToggleStar={() => onToggleStar(thread.primary.id)}
                  onDelete={() => onMailAction("delete", thread.primary)}
                  onArchive={() => onMailAction("archive", thread.primary)}
                  onToggleRead={() => onMailAction("read", thread.primary)}
                  onReply={() => onReply(thread.primary)}
                  onNotSpam={onNotSpam ? () => onNotSpam(thread.primary) : undefined}
                  onRestore={onRestore ? () => onRestore(thread.primary) : undefined}
                />
              ))}
            </div>
          )}

          {empty && (
            <div className="px-6 py-12 text-center">
              <p className="text-[13px] font-medium text-ink-muted">
                {scope === "Contacts" ? "Aucun contact ne correspond." : "Aucun message ne correspond."}
              </p>
              <button
                type="button"
                onClick={resetSearch}
                className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-2 text-[12px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
              >
                <RotateCcw className="size-3.5" />
                Réinitialiser
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
