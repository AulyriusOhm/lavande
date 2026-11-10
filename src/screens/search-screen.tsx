import { useMemo, useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import type { Mail } from "@/lib/mail";
import { RECENT_SEARCHES } from "@/lib/mail";
import { Avatar, Chip } from "@/components/ui/primitives";
import { BlurFade } from "@/components/ui/blur-fade";
import { ShinyText } from "@/components/ui/animated-text";
import { MeshGlow } from "@/components/ui/backdrops";
import { MailRow } from "@/components/mail-row";

const CONTACTS = [
  { name: "Camille Rousseau", tone: 0 },
  { name: "Léa Fontaine", tone: 3 },
  { name: "Marc Delaunay", tone: 1 },
  { name: "Anaïs Petit", tone: 4 },
  { name: "Hugo Vidal", tone: 2 },
];

export function SearchScreen({
  mails,
  onOpen,
  onToggleStar,
  onMailAction,
  onReply,
}: {
  mails: Mail[];
  onOpen: (mail: Mail) => void;
  onToggleStar: (id: string) => void;
  onMailAction: (kind: "delete" | "archive" | "read", mail: Mail) => void;
  onReply: (mail: Mail) => void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("Tout");

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return mails.filter((mail) =>
      [mail.name, mail.email, mail.subject, mail.preview].some((field) =>
        field.toLowerCase().includes(needle),
      ),
    );
  }, [mails, query]);

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
              placeholder="Rechercher un message…"
              className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-ink-muted"
            />
            {query ? (
              <button
                type="button"
                aria-label="Effacer"
                onClick={() => setQuery("")}
                className="grid size-6 place-items-center rounded-full bg-surface-2 text-ink-muted"
              >
                <X className="size-3.5" />
              </button>
            ) : (
              <span className="rounded-lg bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold text-ink-muted">
                ⌘K
              </span>
            )}
          </div>
          <button
            type="button"
            aria-label="Filtres"
            className="grid size-12 shrink-0 place-items-center rounded-2xl bg-accent text-white shadow-[0_10px_24px_-12px_var(--accent)] transition-transform active:scale-95"
          >
            <SlidersHorizontal className="size-4.5" />
          </button>
        </div>
      </header>

      <div className="mt-4 flex gap-2 overflow-x-auto px-5 pb-1 no-scrollbar">
        {["Tout", "Non lus", "Fichiers", "Contacts"].map((item) => (
          <Chip key={item} active={scope === item} onClick={() => setScope(item)}>
            {item}
          </Chip>
        ))}
      </div>

      {query === "" ? (
        <>
          <div className="px-5 pt-7">
            <p className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
              Recherches récentes
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {RECENT_SEARCHES.map((item, index) => (
                <BlurFade key={item} delay={0.04 * index} yOffset={6}>
                  <button
                    type="button"
                    onClick={() => setQuery(item)}
                    className="rounded-full border border-line bg-surface px-3.5 py-2 text-[12.5px] font-semibold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
                  >
                    {item}
                  </button>
                </BlurFade>
              ))}
            </div>
          </div>

          <div className="px-5 pt-7">
            <p className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
              Contacts fréquents
            </p>
            <div className="mt-3 flex gap-3 overflow-x-auto pb-1 no-scrollbar">
              {CONTACTS.map((contact) => (
                <button
                  key={contact.name}
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
            <div className="mx-5 mt-7 rounded-3xl border border-dashed border-accent-ring/70 bg-accent-soft/50 p-5 text-center">
              <p className="text-[13px] font-bold text-ink">
                <ShinyText>Cherche en langage naturel</ShinyText>
              </p>
              <p className="mx-auto mt-1.5 max-w-[240px] text-[11.5px] leading-relaxed font-medium text-ink-soft">
                « les factures de mars non payées » — Lavender comprend l'intention, pas juste les mots.
              </p>
            </div>
          </BlurFade>
        </>
      ) : (
        <div className="mt-4 px-1">
          <p className="px-4 pb-2 text-[11.5px] font-semibold text-ink-muted">
            {results.length} résultat{results.length > 1 ? "s" : ""} pour « {query} »
          </p>
          <div className="space-y-1">
            {results.map((mail, index) => (
              <MailRow
                key={mail.id}
                mail={mail}
                delay={index * 0.04}
                onOpen={() => onOpen(mail)}
                onToggleStar={() => onToggleStar(mail.id)}
                onDelete={() => onMailAction("delete", mail)}
                onArchive={() => onMailAction("archive", mail)}
                onToggleRead={() => onMailAction("read", mail)}
                onReply={() => onReply(mail)}
              />
            ))}
          </div>
          {results.length === 0 && (
            <p className="px-6 py-12 text-center text-[13px] font-medium text-ink-muted">
              Aucun message ne correspond.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
