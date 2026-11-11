/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAIL_BACKEND?: "api" | "demo";
  readonly VITE_OAUTH_CLIENT_ID?: string;
  readonly VITE_MICROSOFT_CLIENT_ID?: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
