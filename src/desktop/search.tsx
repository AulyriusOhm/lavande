import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Archive, Search, Star, Trash2, X } from "lucide-react";
import { useMailStore } from "@/lib/store";
import { useEscapeLayer } from "@/desktop/escape";
import { useContacts } from "@/lib/contacts";
import { mailFolderLabel } from "@/lib/mail";
import type { Mail } from "@/lib/mail";
import { readRecentSearches, writeRecentSearches } from "@/lib/recent-searches";
import { parseSearchQuery, searchTerms } from "@/lib/search-query";
import { buildThreads } from "@/lib/threads";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/primitives";
import { Badge, DIconButton, EmptyState, Kbd, SectionLabel } from "@/desktop/ui";

const OPERATORS = "from: to: subject: in: is:unread is:starred has:attachment before:2026-01-31 after:2026-01-01";

const escapeTerm = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const pattern = new RegExp(`(${terms.map(escapeTerm).join("|")})`, "gi");
  return (
    <>
      {text.split(pattern).map((part, index) =>
        index % 2 === 1 ? (
          <mark key={index} className="rounded-[3px] bg-accent-soft px-0.5 text-ink">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="focus-ring grid size-7 place-items-center rounded-full text-ink-muted transition-colors duration-200 hover:bg-surface hover:text-ink"
    >
      {children}
    </button>
  );
}

export function DesktopSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { openMessage, toggleStar, mailAction, accountById, searchMails, loadMoreSearch, searchHasMore } =
    useMailStore();
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(readRecentSearches);
  const [selected, setSelected] = useState(0);
  const [results, setResults] = useState<Mail[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const trimmed = query.trim();
  const terms = useMemo(() => searchTerms(parseSearchQuery(trimmed).text ?? ""), [trimmed]);

  useEffect(() => {
    if (!trimmed) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchMails(trimmed).then((found) => {
        if (cancelled) return;
        setResults(found);
        setSearching(false);
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [trimmed, searchMails]);

  const threads = useMemo(() => buildThreads(results), [results]);

  const contacts = useContacts("", 6);

  useEffect(() => {
    setSelected(0);
  }, [trimmed]);

  useEscapeLayer(open, onClose);

  const commit = (value: string) => {
    const next = [value, ...recent.filter((entry) => entry !== value)].slice(0, 6);
    setRecent(next);
    writeRecentSearches(next);
  };

  const forget = (value: string) => {
    const next = recent.filter((entry) => entry !== value);
    setRecent(next);
    writeRecentSearches(next);
  };

  const loadMore = () => {
    setLoadingMore(true);
    void loadMoreSearch().then((merged) => {
      setResults(merged);
      setLoadingMore(false);
    });
  };

  const openThread = (index: number) => {
    const thread = threads[index];
    if (!thread) return;
    commit(trimmed);
    openMessage(thread.primary);
    onClose();
  };

  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!threads.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((current) => (current + 1) % threads.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((current) => (current - 1 + threads.length) % threads.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      openThread(selected);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="search"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="fixed inset-0 z-40 flex items-start justify-center bg-ink/25 px-6 pt-[12vh] backdrop-blur-[2px]"
        >
          <button
            type="button"
            aria-label="Fermer la recherche"
            onClick={onClose}
            className="absolute inset-0 cursor-default"
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Recherche globale"
            data-testid="desktop-search"
            onKeyDown={onPanelKeyDown}
            initial={{ opacity: 0, y: -14, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.985 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="relative flex max-h-[min(620px,calc(100vh-12rem))] w-[min(760px,100%)] flex-col overflow-hidden rounded-[26px] border border-line bg-canvas shadow-[0_50px_120px_-50px_var(--accent)]"
          >
            <div className="flex shrink-0 items-center gap-3 px-4 py-3">
              <Search className="size-4.5 shrink-0 text-ink-muted" strokeWidth={2.2} />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Rechercher dans tous les comptes"
                placeholder="Rechercher dans tous les comptes…"
                className="min-w-0 flex-1 bg-transparent text-[13.5px] font-medium text-ink outline-none placeholder:font-medium placeholder:text-ink-muted"
              />
              {query ? (
                <button
                  type="button"
                  aria-label="Effacer la recherche"
                  onClick={() => setQuery("")}
                  className="focus-ring grid size-6 place-items-center rounded-full bg-surface-2 text-ink-muted transition-colors hover:text-ink"
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
              <Kbd>Échap</Kbd>
              <DIconButton label="Fermer la recherche" onClick={onClose}>
                <X className="size-4" strokeWidth={2.2} />
              </DIconButton>
            </div>

            <p className="shrink-0 border-b border-line px-4 pb-2 text-[10.5px] font-semibold text-ink-muted">
              Opérateurs : {OPERATORS}
            </p>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {trimmed === "" ? (
                <div className="space-y-5 px-1.5 pt-2 pb-3">
                  <section>
                    <div className="flex items-baseline justify-between gap-3">
                      <SectionLabel>Recherches récentes</SectionLabel>
                      {recent.length ? (
                        <button
                          type="button"
                          onClick={() => {
                            setRecent([]);
                            writeRecentSearches([]);
                          }}
                          className="focus-ring rounded-full px-1 text-[11px] font-bold text-accent-ink"
                        >
                          Tout effacer
                        </button>
                      ) : null}
                    </div>
                    {recent.length ? (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {recent.map((item) => (
                          <span
                            key={item}
                            className="inline-flex items-center rounded-full border border-line bg-surface"
                          >
                            <button
                              type="button"
                              onClick={() => setQuery(item)}
                              className="focus-ring rounded-full py-1.5 pr-0.5 pl-3 text-[12px] font-semibold text-ink-soft transition-colors duration-200 hover:text-accent-ink"
                            >
                              {item}
                            </button>
                            <button
                              type="button"
                              aria-label={`Retirer « ${item} » des recherches récentes`}
                              onClick={() => forget(item)}
                              className="focus-ring mr-0.5 grid size-5 place-items-center rounded-full text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                            >
                              <X className="size-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2.5 text-[11.5px] font-medium text-ink-muted">Aucune recherche récente.</p>
                    )}
                  </section>

                  <section>
                    <SectionLabel>Contacts fréquents</SectionLabel>
                    <div className="mt-2.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                      {contacts.map((contact) => (
                        <button
                          key={contact.email}
                          type="button"
                          onClick={() => setQuery(contact.name ?? contact.email)}
                          className="focus-ring flex items-center gap-2.5 rounded-[16px] px-2 py-2 text-left transition-colors duration-200 hover:bg-surface-2"
                        >
                          <Avatar
                            name={contact.name ?? contact.email}
                            tone={contact.tone}
                            size={32}
                            rounded="rounded-full"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12.5px] font-bold text-ink">
                              {contact.name ?? contact.email}
                            </span>
                            <span className="block truncate text-[11px] font-medium text-ink-muted">
                              {contact.count} message{contact.count > 1 ? "s" : ""}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
              ) : (
                <div className="pb-1">
                  <p role="status" className="px-2.5 pt-1.5 pb-2 text-[11.5px] font-semibold text-ink-muted">
                    {searching
                      ? `Recherche de « ${trimmed} »…`
                      : `${results.length} résultat${results.length > 1 ? "s" : ""} pour « ${trimmed} »`}
                  </p>

                  <div className="space-y-0.5">
                    {threads.map((thread, index) => {
                      const primary = thread.primary;
                      const isSelected = index === selected;
                      const label =
                        thread.count > 1 && thread.participants.length
                          ? `${thread.participants.slice(0, 2).join(", ")}${
                              thread.participants.length > 2 ? ` +${thread.participants.length - 2}` : ""
                            }`
                          : primary.folder === "sent" && primary.to
                            ? `À ${primary.to}`
                            : primary.name;

                      return (
                        <div
                          key={thread.id}
                          data-selected={isSelected}
                          onMouseEnter={() => setSelected(index)}
                          className={cn(
                            "group flex items-center gap-1.5 rounded-[16px] px-2 py-2 transition-colors duration-200",
                            isSelected ? "bg-accent-soft/60" : "hover:bg-surface-2",
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => openThread(index)}
                            className="focus-row flex min-w-0 flex-1 items-center gap-2.5 rounded-xl text-left"
                          >
                            <Avatar name={label} tone={primary.tone} size={34} rounded="rounded-xl" />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-baseline gap-2">
                                <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-ink">{label}</span>
                                {thread.unread > 0 ? (
                                  <span className="size-1.5 shrink-0 rounded-full bg-accent" />
                                ) : null}
                                <span className="shrink-0 text-[10.5px] font-semibold text-ink-muted tabular-nums">
                                  {thread.time}
                                </span>
                              </span>
                              <span className="mt-0.5 flex items-center gap-1.5">
                                <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink-soft">
                                  <Highlight text={thread.subject} terms={terms} />
                                </span>
                                <Badge tone="accent">{accountById(primary.account)?.label ?? primary.account}</Badge>
                                <Badge>{mailFolderLabel(primary)}</Badge>
                              </span>
                              <span className="mt-0.5 block truncate text-[11.5px] font-medium text-ink-muted">
                                <Highlight text={thread.preview} terms={terms} />
                              </span>
                            </span>
                          </button>

                          <span
                            className={cn(
                              "flex shrink-0 items-center gap-0.5 transition-opacity duration-200",
                              isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                            )}
                          >
                            <RowAction
                              label={thread.starred ? "Retirer l'étoile" : "Étoiler"}
                              onClick={() => toggleStar(primary.id)}
                            >
                              <Star
                                className={cn(
                                  "size-3.5",
                                  thread.starred ? "fill-amber-400 text-amber-700 dark:text-amber-300" : undefined,
                                )}
                              />
                            </RowAction>
                            <RowAction label="Archiver" onClick={() => mailAction("archive", primary)}>
                              <Archive className="size-3.5" />
                            </RowAction>
                            <RowAction label="Supprimer" onClick={() => mailAction("delete", primary)}>
                              <Trash2 className="size-3.5" />
                            </RowAction>
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {searchHasMore && !searching ? (
                    <button
                      type="button"
                      onClick={loadMore}
                      disabled={loadingMore}
                      className="focus-ring mx-auto mt-2 block rounded-full border border-line bg-surface px-4 py-1.5 text-[12px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink disabled:opacity-60"
                    >
                      {loadingMore ? "Chargement…" : "Charger plus"}
                    </button>
                  ) : null}

                  {threads.length === 0 && !searching ? (
                    <EmptyState
                      icon={<Search className="size-5" />}
                      title="Aucun message ne correspond"
                      hint={`Rien pour « ${trimmed} » dans aucun compte. Essayez un nom, un objet ou un mot du message.`}
                      className="py-14"
                    />
                  ) : null}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
