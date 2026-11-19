import type { Prefs } from "@/lib/prefs";

export type TeamMember = { name: string; scope: string };

/** Identité, rôle et équipe d'une boîte : le contexte que l'assistant reçoit tel quel. */
export type AccountTeamContext = {
  identity: string;
  role: string;
  context: string;
  members: TeamMember[];
};

export const EMPTY_TEAM_CONTEXT: AccountTeamContext = {
  identity: "",
  role: "",
  context: "",
  members: [],
};

export const TEAM_MEMBERS_MAX = 12;

/** Fiche d'un compte ; un compte jamais réglé part d'une fiche vide. */
export function teamContextOf(prefs: Pick<Prefs, "teamContext">, accountId: string): AccountTeamContext {
  return prefs.teamContext?.[accountId] ?? EMPTY_TEAM_CONTEXT;
}

const memberLine = (member: TeamMember): string => {
  const name = member.name.trim();
  const scope = member.scope.trim();
  return scope ? `${name} — ${scope}` : name;
};

/**
 * Section de prompt système : donnée fournie par l'utilisateur, donc fiable et
 * placée hors des marqueurs de contenu mail non fiable.
 */
export function teamPromptBlock(ctx: AccountTeamContext): string {
  const identity = ctx.identity.trim();
  const role = ctx.role.trim();
  const context = ctx.context.trim();
  const members = ctx.members.filter((member) => member.name.trim());
  const lines = [
    identity ? `Identité : ${identity}` : "",
    role ? `Rôle : ${role}` : "",
    context ? `Contexte : ${context}` : "",
    members.length > 0 ? `Équipe :\n${members.map((member) => `- ${memberLine(member)}`).join("\n")}` : "",
  ].filter((line) => line !== "");
  if (lines.length === 0) return "";
  return ["CONTEXTE UTILISATEUR (fiable, fourni par l'utilisateur)", ...lines].join("\n");
}

/** Tous les membres connus, une fois par nom, pour les listes de suggestions. */
export function allTeamMembers(prefs: Pick<Prefs, "teamContext">): TeamMember[] {
  const seen = new Set<string>();
  const out: TeamMember[] = [];
  for (const ctx of Object.values(prefs.teamContext ?? {})) {
    for (const member of ctx.members) {
      const name = member.name.trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push({ name, scope: member.scope.trim() });
    }
  }
  return out;
}
