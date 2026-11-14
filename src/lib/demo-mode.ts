export type MailMode = "api" | "demo";

export function mailMode(): MailMode {
  if (import.meta.env.VITE_DISTRIBUTION === "1") return "api";
  return import.meta.env.VITE_MAIL_BACKEND === "demo" ? "demo" : "api";
}

/**
 * Démo embarquée dans le site vitrine : les fixtures s'affichent et se
 * parcourent, aucune mutation ne part et aucun appel LLM n'est tenté.
 * Faux par défaut : l'app normale et les builds existants ne changent pas.
 */
export const demoReadOnly: boolean =
  mailMode() === "demo" && import.meta.env.VITE_DEMO_READONLY === "1";

export const READ_ONLY_NOTICE = "Démo en lecture seule";
