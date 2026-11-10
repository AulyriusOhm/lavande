/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAIL_BACKEND?: "api" | "demo";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
