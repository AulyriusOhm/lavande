export type PgpKey = {
  id: string;
  name: string;
  email: string;
  fingerprint: string;
  algorithm: string;
  created: string;
  expires: string;
  verified: boolean;
  trust: "ultimate" | "full" | "marginal";
  secret?: boolean;
};

export const MY_KEY: PgpKey = {
  id: "own",
  name: "Roman",
  email: "roman@lavande.mail",
  fingerprint: "9F3A 71C4 D0B8 5E62 4A17  88CD 2B90 7F31 AE45 6C08",
  algorithm: "Curve25519 · Ed25519",
  created: "12/03/2026",
  expires: "12/03/2028",
  verified: true,
  trust: "ultimate",
  secret: true,
};

export const CONTACT_KEYS: PgpKey[] = [
  {
    id: "camille",
    name: "Camille Rousseau",
    email: "camille@studio-lilas.fr",
    fingerprint: "4B71 0E9C 55A2 B3D8 6F14  2C90 77DE 1A3B 09F5 22C7",
    algorithm: "RSA 4096",
    created: "04/11/2025",
    expires: "04/11/2027",
    verified: true,
    trust: "full",
  },
  {
    id: "marc",
    name: "Marc Delaunay",
    email: "marc.delaunay@mail.fr",
    fingerprint: "A1D4 62F0 8C33 5B97 E2D1  40A8 6C15 9B7E 3D02 84F1",
    algorithm: "Curve25519 · Ed25519",
    created: "19/01/2026",
    expires: "19/01/2028",
    verified: true,
    trust: "full",
  },
  {
    id: "lea",
    name: "Léa Fontaine",
    email: "lea@atelier-nova.co",
    fingerprint: "77C2 9D31 40E8 A6B5 1F3C  8B62 D904 5AE7 2C18 63B0",
    algorithm: "RSA 3072",
    created: "02/06/2024",
    expires: "02/06/2026",
    verified: false,
    trust: "marginal",
  },
];
