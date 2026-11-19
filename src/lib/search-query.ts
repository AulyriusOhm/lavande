/** Grammaire unique de la recherche : le parseur écrit les params du démon. */

export type SearchFilter = {
  folder?: string;
  from?: string;
  to?: string;
  subject?: string;
  unread?: boolean;
  starred?: boolean;
  hasAttachment?: boolean;
  /** YYYY-MM-DD, exclusif. */
  before?: string;
  /** YYYY-MM-DD, inclusif. */
  after?: string;
};

export type SearchCriteria = SearchFilter & { text?: string };

const OPERATOR = /^([\p{L}]+):(.*)$/u;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of input) {
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(character)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

function isoDate(value: string): string | undefined {
  if (!ISO_DATE.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return undefined;
  return value;
}

/**
 * `from:` `to:` `subject:` `in:` `has:attachment` `is:unread` `is:starred`
 * `before:` `after:` ; tout le reste, opérateur inconnu compris, est du texte.
 */
export function parseSearchQuery(input: string): SearchCriteria {
  const criteria: SearchCriteria = {};
  const literal: string[] = [];

  for (const token of tokenize(input)) {
    const match = OPERATOR.exec(token);
    const key = match?.[1].toLowerCase();
    const value = match?.[2].trim() ?? "";

    if (key && value) {
      if (key === "from" || key === "to" || key === "subject") {
        criteria[key] = value;
        continue;
      }
      if (key === "in") {
        criteria.folder = value;
        continue;
      }
      if (key === "has" && value.toLowerCase() === "attachment") {
        criteria.hasAttachment = true;
        continue;
      }
      if (key === "is") {
        const flag = value.toLowerCase();
        if (flag === "unread" || flag === "starred") {
          criteria[flag] = true;
          continue;
        }
      }
      if (key === "before" || key === "after") {
        const date = isoDate(value);
        if (date) {
          criteria[key] = date;
          continue;
        }
      }
    }

    literal.push(token);
  }

  criteria.text = literal.join(" ");
  return criteria;
}

export function hasCriteria(criteria: SearchCriteria): boolean {
  const { text, ...filters } = criteria;
  return Boolean(text?.trim()) || Object.values(filters).some((value) => value !== undefined);
}

export function mergeCriteria(base: SearchCriteria, overrides: SearchFilter = {}): SearchCriteria {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as SearchCriteria;
}

const PARAMETERS: [keyof SearchFilter, string][] = [
  ["folder", "folder"],
  ["from", "from"],
  ["to", "to"],
  ["subject", "subject"],
  ["unread", "unread"],
  ["starred", "starred"],
  ["hasAttachment", "has_attachment"],
  ["before", "before"],
  ["after", "after"],
];

/** Query string du démon : seuls les critères définis sont envoyés. */
export function searchParams(
  query: string,
  limit: number,
  filter: SearchFilter & { offset?: number } = {},
): string {
  const parts: string[] = [];
  const add = (name: string, value: string | number | boolean | undefined) => {
    if (value === undefined || value === "") return;
    parts.push(`${name}=${encodeURIComponent(String(value))}`);
  };

  add("q", query.trim());
  add("limit", limit);
  if (filter.offset) add("offset", filter.offset);
  for (const [key, name] of PARAMETERS) add(name, filter[key]);
  return parts.join("&");
}

/** Les mots du texte libre, pour surligner les résultats. */
export function searchTerms(text: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const chunk of text.split(/\s+/)) {
    const term = chunk.replace(/^\P{L}+|\P{L}+$/gu, "");
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}
