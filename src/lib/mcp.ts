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

export const MCP_SCOPES: { id: McpTool["scope"]; hint: string }[] = [
  { id: "lecture", hint: "consultation seule" },
  { id: "écriture", hint: "modifie la boîte ou l'agenda" },
  { id: "signature", hint: "chiffre ou vérifie" },
];

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
    description: "Chiffrement et vérification hors processus",
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

export function mcpCounts(active: (server: McpServer) => boolean = (server) => server.status === "connected") {
  const servers = MCP_SERVERS.filter(active);
  return {
    servers: MCP_SERVERS.length,
    activeServers: servers.length,
    activeTools: servers.reduce((total, server) => total + server.tools.length, 0),
    installedTools: MCP_SERVERS.reduce((total, server) => total + server.tools.length, 0),
  };
}

export type McpLogEntry = {
  time: string;
  tool: string;
  agent: string;
  status: "succès" | "échec";
  detail: string;
};

export const MCP_LOG: McpLogEntry[] = [
  {
    time: "09:38",
    tool: "mail.search",
    agent: "Assistant Lavande",
    status: "succès",
    detail: "« maquettes v3 » · 1 résultat · perso",
  },
  {
    time: "09:39",
    tool: "calendar.create",
    agent: "Assistant Lavande",
    status: "succès",
    detail: "Point maquettes v3 · aujourd'hui 10:00",
  },
  {
    time: "09:40",
    tool: "pgp.verify",
    agent: "Relais local",
    status: "succès",
    detail: "Signature de Camille Rousseau · valide",
  },
  {
    time: "09:41",
    tool: "fs.read",
    agent: "Assistant Lavande",
    status: "échec",
    detail: "Serveur filesystem inactif · aucune pièce jointe lue",
  },
];
