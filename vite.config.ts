import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const MAIL_API = process.env.MAIL_API ?? "http://127.0.0.1:8790";

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
    proxy: {
      "/api": { target: MAIL_API },
      "/lavande/api": {
        target: MAIL_API,
        rewrite: (requestPath) => requestPath.replace(/^\/lavande\/api/, "/api"),
      },
    },
  },
  clearScreen: false,
});
