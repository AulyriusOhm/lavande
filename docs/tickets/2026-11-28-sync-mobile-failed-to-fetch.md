# Ticket — Synchro mobile : « Failed to fetch » (téléphone → GammaSync)

> **Ticket Gitea : [#3](https://git.lanro.eu/Roman/lavande/issues/3)** — ouvert le 28/11/2026.
> Statut : ouvert, en attente de diagnostic côté téléphone (le serveur et le PC fonctionnent).

## Contexte

Serveur de synchro E2EE **GammaSync = CT 150** (Alma 10, Proxmox GammaWTR Grenoble, 192.168.5.180), déployé le 28/11/2026 :
- `lavande-sync` 0.5.12 (Rust) + PostgreSQL 16.15, systemd, bind loopback 8787.
- **nginx 443 ssl → 127.0.0.1:8787**, URL **`https://synchrolavande.int.lanro.eu`**.
- Certificat : wildcard Let's Encrypt `*.int.lanro.eu` du VPS (hook `synchrolavande-tls.sh`, renewal auto), firewalld 443 limité au LAN 192.168.5.0/24.
- DNS : Cloudflare (A publique IP privée) + dnsmasq SLP + AdGuard LAN (.125 / .126).
- Décision Roman : **LAN/VPN uniquement**, pas d'exposition publique. Hors LAN : WireGuard du hub (AllowedIPs 192.168.5.0/24).
- **Le PC (app Linux 0.5.12, 192.168.5.75) se connecte et sync sans problème.**

## Symptômes (téléphone Android, app 0.5.12, WiFi Grenoble)

1. Première erreur : **« synchronisation impossible : clé de chiffrement absente (appareil non appairé) »** — état local périmé : compte en localStorage sans clé privée d'appareil valide ; le moteur vérifie la DEK **avant** tout appel réseau (`src/lib/sync/engine.ts:271`, `resolveDek` `src/lib/sync/storage.ts:562`). Correctif prévu : Se déconnecter → Se connecter (l'enveloppe de mot de passe est côté serveur, `users.key_envelope`, round-trip vérifié en live).
2. Après bascule en HTTPS : **« Failed to fetch »** à la connexion. **Aucune requête du téléphone dans les logs nginx** (`/var/log/nginx/access.log` du CT 150) → l'échec est AVANT le serveur (DNS, réseau, ou état local de l'app).

## Vérifié côté serveur (tout est OK)

- `scripts/e2e-sync.mjs` : **28/28** contre `https://synchrolavande.int.lanro.eu` depuis plasmasrv (inscription, login, push/pull, appairage complet, révocations).
- Login PC visible dans les logs nginx : salt 200, preflight OPTIONS 200 (CORS `tauri://localhost`, `http(s)://tauri.localhost`), login 200 avec enveloppe, devices 200.
- Chaîne LE valide (expire 29/01/2027), TLS 1.2/1.3, healthz OK depuis VPS / plasmasrv / LAN, reboot CT → tout repart.
- **DNS LAN** : .125 et SLP résolvent. **.126 (CT 149) timeout sur `int.lanro.eu`** : upstream `[/int.lanro.eu/]192.168.1.50` injoignable depuis ce CT (gateway .254, pas de route vers SLP ; le CT 101 .125 a gateway **192.168.5.100 gammaWTR** qui route vers 192.168.1.x via le hub WG). **Corrigé le 28/11** : upstream int.lanro.eu de .126 → .125 (backup `AdGuardHome.yaml.bak-20261128`). Les deux AdGuard résolvent `synchrolavande.int.lanro.eu` → 192.168.5.180.
- **Android cleartext** : `src-tauri/gen/android/app/src/main/res/xml/network_security_config.xml` n'autorise le HTTP en clair que pour 127.0.0.1/localhost → une URL `http://192.168.5.180:8787` donne « Failed to fetch » (bloqué par Android, aucune requête émise). C'est la raison du passage en HTTPS (évite un rebuild d'APK avec exception cleartext).

## Hypothèses restantes (côté téléphone)

1. **DNS du téléphone** : Private DNS Android (DoT) ou resolver différent ; .126 était cassé au moment du test (corrigé depuis → **retester**).
2. **État local de l'app** : ancien compte `http://192.168.5.180:8787` non déconnecté → l'auto-sync tape le port 8787 fermé + cleartext bloqué → « Failed to fetch » en boucle. La carte « Compte synchronisé » doit montrer l'URL https après re-login.
3. **Isolation client WiFi** : l'AP bloque peut-être WiFi → LAN (le PC est en filaire).
4. Erreur fetch spécifique du WebView (DNS ? TLS ? autre) — console via `chrome://inspect`.

## Prochaines étapes de diagnostic

1. **Navigateur du téléphone** : ouvrir `https://synchrolavande.int.lanro.eu/healthz` → si `{"status":"ok"...}` s'affiche, le réseau est bon, le problème est dans l'app.
2. Vérifier les DNS WiFi du téléphone (Réglages → WiFi → détails) + Private DNS (Réglages → Réseau → DNS privé).
3. App : Réglages → Synchronisation → **Se déconnecter** → URL `https://synchrolavande.int.lanro.eu` + `roman@mail.lanro.eu` + mot de passe → **Se connecter** (pas « Créer le compte »). Surveiller `tail -f /var/log/nginx/access.log` sur le CT 150 (via nihyl, profil « GammaSync (CT 150 Alma) »).
4. Si le navigateur échoue aussi : tester `http://192.168.5.180` (nginx :80) depuis le téléphone → isolation AP / routage.
5. Console WebView : USB debug + `chrome://inspect` → message d'erreur exact du fetch.

## Environnement

- Téléphone : Android (IPAM : « A15 », 192.168.5.93), app Lavande 0.5.12 (APK `/updates/Lavande.apk`).
- Serveur : CT 150 `gammaSyncAlma`, nginx 1.26.3, `lavande-sync` 0.5.12 (sha256 `a6fac86f5a4853bf6eea6977f7d323aa774a227f008de89c9ff9510985e0d716`), PostgreSQL 16.15.
- PC OK : Fedora, 192.168.5.75, app 0.5.12.

## Références

- Infra : notes mémoire nihyl sur GammaSync (service/cert/rebuild), Proxmox GammaWTR (pièges CT Alma 10), DNS interne (correctif .126).
- Doc : `docs/SYNC.md` (protocole), Outline « TODO — Lavande » + « Détails & décisions » (sections 28/11).
- Fichier de diagnostic repo : `docs/tickets/2026-11-28-sync-mobile-failed-to-fetch.md`.
