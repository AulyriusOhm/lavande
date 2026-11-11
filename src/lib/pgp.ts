import type { ApiPgpDetail, ApiPgpState } from "@/lib/api";

/** Clé telle que le démon la renvoie (`PgpKeyInfo`). */
export type PgpKey = {
  fingerprint: string;
  key_id: string;
  user_id: string;
  name: string | null;
  email: string | null;
  algorithm: string;
  created_at: string;
  expires_at: string | null;
  has_secret: boolean;
  revoked: boolean;
  expired: boolean;
};

export const PGP_STATE = {
  valid: {
    label: "clé valide",
    hint: "Clé valide, utilisable pour chaque destinataire.",
  },
  expired: {
    label: "clé expirée",
    hint: "Cette clé ne peut plus servir à chiffrer : demande une nouvelle clé au destinataire.",
  },
  revoked: {
    label: "clé révoquée",
    hint: "Le propriétaire a révoqué cette clé : le chiffrement est bloqué jusqu'à réception d'une nouvelle clé.",
  },
  invalid: {
    label: "clé invalide",
    hint: "Clé illisible ou invalide : vérifie l'empreinte auprès du destinataire avant tout envoi.",
  },
} as const;

export type PgpKeyState = "valid" | "expired" | "revoked";

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function isExpired(key: PgpKey, now = new Date()): boolean {
  if (key.expired) return true;
  const expires = timestamp(key.expires_at);
  return expires !== null && expires <= now.getTime();
}

export function keyState(key: PgpKey, now = new Date()): PgpKeyState {
  if (key.revoked) return "revoked";
  return isExpired(key, now) ? "expired" : "valid";
}

export function formatKeyDate(value: string | null): string {
  const parsed = timestamp(value);
  if (parsed === null) return "—";
  return new Date(parsed).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function formatFingerprint(fingerprint: string): string {
  const clean = fingerprint.replace(/\s+/g, "").toUpperCase();
  return clean.replace(/(.{4})(?=.)/g, "$1 ");
}

export function shortFingerprint(fingerprint: string): string {
  const clean = fingerprint.replace(/\s+/g, "").toUpperCase();
  return clean.length <= 16 ? formatFingerprint(clean) : `…${formatFingerprint(clean.slice(-16))}`;
}

export function keyLabel(key: PgpKey): string {
  return key.name?.trim() || key.email?.trim() || key.user_id;
}

export function keyUsage(key: PgpKey): string {
  return key.has_secret ? "secrète" : "publique";
}

export type PgpVerification = "verified" | "invalid" | "unverified";

export type PgpMessageStatus = {
  state: ApiPgpState;
  /** `null` quand le serveur ne fournit pas `pgp_detail`. */
  verification: PgpVerification | null;
  decrypted: boolean;
  signer: string | null;
  error: string | null;
};

/** Statut PGP d'un message lu, à partir de `mail.pgp` et `mail.pgp_detail`. */
export function messagePgpStatus(message: {
  pgp: ApiPgpState;
  pgp_detail?: ApiPgpDetail | null;
}): PgpMessageStatus | null {
  if (message.pgp === "none") return null;
  const detail = message.pgp_detail ?? null;
  const verification: PgpVerification | null = detail
    ? detail.verified === true
      ? "verified"
      : detail.verified === false
        ? "invalid"
        : "unverified"
    : null;
  return {
    state: message.pgp,
    verification,
    decrypted: detail?.decrypted ?? false,
    signer: detail?.signer ?? null,
    error: detail?.error ?? null,
  };
}

