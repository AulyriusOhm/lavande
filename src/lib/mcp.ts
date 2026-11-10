export type McpTool = {
  name: string;
  description: string;
  scope: "lecture" | "écriture" | "signature";
};

export type McpServer = {
  id: string;
  name: string;
  description: string;
  transport: "stdio" | "http";
  status: "connected" | "idle" | "error";
  tools: McpTool[];
};

export const MCP_SERVERS: McpServer[] = [
  {
    id: "mail",
    name: "lavande-mail",
    description: "Boîtes, dossiers, recherche full-text",
    transport: "stdio",
    status: "connected",
    tools: [
      { name: "mail.search", description: "Recherche multi-comptes", scope: "lecture" },
      { name: "mail.read", description: "Corps complet + pièces jointes", scope: "lecture" },
      { name: "mail.draft", description: "Prépare un brouillon", scope: "écriture" },
      { name: "mail.send", description: "Envoi après confirmation", scope: "écriture" },
      { name: "mail.label", description: "Étiquettes et dossiers", scope: "écriture" },
    ],
  },
  {
    id: "calendar",
    name: "lavande-calendar",
    description: "Agenda CalDAV, disponibilités",
    transport: "stdio",
    status: "connected",
    tools: [
      { name: "calendar.list", description: "Événements d'une plage", scope: "lecture" },
      { name: "calendar.create", description: "Crée un événement", scope: "écriture" },
      { name: "calendar.free", description: "Créneaux libres", scope: "lecture" },
    ],
  },
  {
    id: "pgp",
    name: "pgp-signer",
    description: "Chiffrement et signature hors processus",
    transport: "stdio",
    status: "connected",
    tools: [
      { name: "pgp.verify", description: "Vérifie une signature", scope: "signature" },
      { name: "pgp.encrypt", description: "Chiffre vers une clé", scope: "signature" },
    ],
  },
  {
    id: "filesystem",
    name: "filesystem",
    description: "Pièces jointes montées en lecture",
    transport: "http",
    status: "idle",
    tools: [{ name: "fs.read", description: "Lit un fichier joint", scope: "lecture" }],
  },
];

export const MCP_LOG: { time: string; tool: string; detail: string }[] = [
  { time: "09:38", tool: "mail.search", detail: "« maquettes v3 » · 1 résultat · perso" },
  { time: "09:39", tool: "calendar.create", detail: "Point maquettes v3 · aujourd'hui 10:00" },
  { time: "09:40", tool: "pgp.verify", detail: "Signature de Camille Rousseau · valide" },
];
