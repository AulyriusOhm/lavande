import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const MAIL_API = process.env.MAIL_API ?? "http://127.0.0.1:8790";

// Le démon exige un jeton Bearer : le proxy le lit dans le répertoire de
// données et l'injecte, le navigateur n'a rien à porter. Même résolution que
// le démon (LAVANDE_MAIL_DATA_DIR, XDG_DATA_HOME, ~/.local/share/lavande).
function daemonToken(): string | null {
  const dataDir =
    process.env.LAVANDE_MAIL_DATA_DIR ??
    (process.env.XDG_DATA_HOME
      ? path.join(process.env.XDG_DATA_HOME, "lavande")
      : path.join(os.homedir(), ".local/share/lavande"));
  try {
    return fs.readFileSync(path.join(dataDir, "daemon-token"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

const token = daemonToken();
if (!token) {
  console.warn(
    "[lavande] daemon-token introuvable : l'API mail refusera les requêtes. " +
      "Démarrez scripts/mail-service.sh puis relancez Vite (mode démo sans démon).",
  );
}
const apiProxy = {
  target: MAIL_API,
  ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
};

const srcDir = path.resolve(import.meta.dirname, "./src");

// Sur Android, le code MCP n'est pas masqué : les modules sont remplacés à la
// résolution par des stubs vides, donc absents du bundle.
const alias =
  process.env.VITE_PLATFORM === "android"
    ? [
        { find: "@/lib/mcp", replacement: path.join(srcDir, "lib/mcp.android.ts") },
        { find: "@/screens/mcp-screen", replacement: path.join(srcDir, "screens/mcp-screen.android.tsx") },
        { find: "@", replacement: srcDir },
      ]
    : { "@": srcDir };

export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  publicDir: process.env.VITE_DISTRIBUTION === "1" ? false : "public",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@tiptap") || id.includes("prosemirror")) return "vendor-editor";
          if (id.includes("/motion/") || id.includes("framer-motion")) return "vendor-motion";
          if (id.includes("@noble/")) return "vendor-crypto";
          if (id.includes("lucide-react")) return "vendor-icons";
          if (id.includes("react-dom") || id.includes("/react/")) return "vendor-react";
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 1420,
    strictPort: true,
    allowedHosts: true,
    watch: {
      ignored: ["**/.plasma/**", "**/src-tauri/**", "**/server/**", "**/dist/**", "**/target/**", "**/.agents/**", "**/artifacts/**"],
    },
    proxy: {
      "/api": { ...apiProxy },
      "/lavande/api": {
        ...apiProxy,
        rewrite: (requestPath) => requestPath.replace(/^\/lavande\/api/, "/api"),
      },
    },
  },
  clearScreen: false,
});