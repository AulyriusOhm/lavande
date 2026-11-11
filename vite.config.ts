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

export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: {
    host: "0.0.0.0",
    port: 1420,
    strictPort: true,
    allowedHosts: true,
    watch: {
      ignored: ["**/.plasma/**", "**/src-tauri/**", "**/server/**", "**/dist/**"],
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