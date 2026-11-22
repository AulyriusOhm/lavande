/**
 * Palette des étiquettes Zimbra : le serveur ne garde qu'un numéro (`color`,
 * 0 = aucune, 1-9 = la palette que le web Zimbra affiche), le nom et la teinte
 * sont ici. Un numéro hors palette garde son nom d'étiquette et s'affiche en
 * gris.
 */

import type { ZimbraTag } from "@/lib/api";

export const ZIMBRA_TAG_COLORS = [
  { value: 1, label: "bleu", dot: "#4f83f1" },
  { value: 2, label: "cyan", dot: "#22a8c2" },
  { value: 3, label: "vert", dot: "#22a06b" },
  { value: 4, label: "violet", dot: "#8b5cf6" },
  { value: 5, label: "rouge", dot: "#e5484d" },
  { value: 6, label: "jaune", dot: "#e3a008" },
  { value: 7, label: "rose", dot: "#ec4899" },
  { value: 8, label: "gris", dot: "#8b95a5" },
  { value: 9, label: "orange", dot: "#f97316" },
] as const;

/** La teinte d'une couleur Zimbra ; gris neutre quand le numéro n'en a pas. */
export function tagDot(color: number): string {
  return ZIMBRA_TAG_COLORS.find((entry) => entry.value === color)?.dot ?? "#8b95a5";
}

/** Le nom français d'une couleur Zimbra, pour les libellés. */
export function tagColorLabel(color: number): string {
  if (color === 0) return "sans couleur";
  return ZIMBRA_TAG_COLORS.find((entry) => entry.value === color)?.label ?? `couleur ${color}`;
}

/** Vrai quand l'étiquette a une couleur de la palette affichable. */
export function tagColored(color: number): boolean {
  return ZIMBRA_TAG_COLORS.some((entry) => entry.value === color);
}

/** Les étiquettes d'un message, triées par nom, sans doublon d'identifiant. */
export function sortedTags(tags: ZimbraTag[]): ZimbraTag[] {
  const seen = new Set<string>();
  return [...tags]
    .filter((tag) => {
      if (seen.has(tag.id)) return false;
      seen.add(tag.id);
      return true;
    })
    .sort((left, right) => left.name.localeCompare(right.name, "fr"));
}
