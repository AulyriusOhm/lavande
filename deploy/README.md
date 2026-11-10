# Portail dev (TLS) — `plasma.int.lanro.eu`

Une seule entrée pour tous les projets en cours de dev, servie en HTTPS avec le
certificat wildcard `*.int.lanro.eu` déjà présent sur l'hôte.

| URL | Cible |
| --- | --- |
| `https://plasma.int.lanro.eu:8443/` | portail (liste des projets) — `deploy/www/index.html` |
| `https://plasma.int.lanro.eu:8443/lavande/` | dev server Vite de Lavande (`127.0.0.1:1420`) |

`plasma.int.lanro.eu` **existe déjà** dans le DNS interne (OPNsense → `10.1.50.10`) et le
wildcard le couvre : rien à créer côté DNS. `dev.int.lanro.eu` est également déclaré dans le
`server_name` — le jour où l'enregistrement `dev` sera ajouté, la même URL fonctionnera.

Le port `:8443` est imposé : le `443` de `10.1.50.10` est déjà pris par le proxy TLS du
panneau Nihyl (`/opt/nihyl-tls/server.js` → `127.0.0.1:3030`), qui ne fait pas de routage
par nom d'hôte.

## Fonctionnement

`deploy/dev-proxy.sh` lance le conteneur `dev-proxy` (`nginx:alpine`) :

- `--network host` + `--restart unless-stopped` → repart au boot, écoute `0.0.0.0:8443` ;
- certificat : `/etc/nihyl-tls/tls.crt|key` monté dans `/certs` (fichiers `root:root 640`,
  le montage est fait par le daemon docker → aucun sudo nécessaire) ;
- conf nginx montée **en dossier** (`deploy/nginx:/etc/nginx/conf.d`) — un montage de fichier
  seul casse au premier `edit` (nouvel inode, nginx continue de lire l'ancien) ;
- WebSocket géré (HMR Vite passe à travers).

Vérifié :

| Test | Résultat |
| --- | --- |
| `curl https://plasma.int.lanro.eu:8443/` | `200` (portail) |
| `curl .../lavande/`, `.../lavande/src/main.tsx`, `.../lavande/@vite/client` | `200` |
| `openssl s_client -servername plasma.int.lanro.eu` | chaîne complète, `Verify return code: 0 (ok)` |
| rendu de l'app dans un Chrome headless via le DNS interne + TLS réel | rendu complet, 0 erreur console |

## Ajouter un projet

1. Dev server du projet sur un port libre (ex. `5174`), `base` réglé sur `/<projet>/`.
2. Bloc dans `deploy/nginx/portal.conf` :

   ```nginx
   location /monprojet/ {
       proxy_pass http://127.0.0.1:5174;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-Proto https;
   }
   ```

   (pas de `/` final à `proxy_pass` : le préfixe doit être conservé pour que le `base` du
   bundler soit respecté.)
3. Une entrée dans `deploy/www/index.html`, puis `bash deploy/dev-proxy.sh`.

## Lavande : deux modes

| Commande | `base` | Usage |
| --- | --- | --- |
| `npm run dev:portal` | `/lavande/` | derrière le portail dev (URL ci-dessus) |
| `npm run dev` | `/` | Tauri / accès direct `http://10.1.50.10:1420` |
| `npm run build` | `/` | bundle natif Tauri |

Le proxy pointe sur `127.0.0.1:1420` : si le dev server n'est pas lancé en mode portail
(`npm run dev:portal`), `/lavande/` renvoie 404 (`/` du dev server, lui, redirige).

## Alias `dev.int.lanro.eu` (optionnel)

Le nom vit dans `plasma.int.lanro.eu`, qui existe déjà. `dev.int.lanro.eu` est déclaré dans le
`server_name` mais **n'a pas d'enregistrement DNS** — c'est ce qui donne `DNS_PROBE_POSSIBLE`
si on l'utilise. Le DNS interne est **OPNsense** (`10.1.50.1`) ; il connaît `nihyl`,
`nas` et `plasma`, mais `int.lanro.eu` n'a pas de wildcard, et je n'ai aucun accès à cette
interface. Pour ajouter l'alias : **Services → Unbound DNS → Host overrides → +**

```
Host:     dev
Domain:   int.lanro.eu
IP:       10.1.50.10
```

(API : `/api/unbound/settings/addHostOverride` puis `/api/unbound/service/reconfigure`.)

## Chemin réseau depuis le LAN Grenoble (`192.168.5.0/24`)

Le routage direct ne marche pas : la Freebox (`192.168.5.254`) est la passerelle des postes et
route `10.1.0.0/16` vers **gammaWTR** (`192.168.5.100`), pas vers l'OPNsense. Pattern déjà
utilisé pour ohm (port 8777), reproduit pour 8443 :

```
poste 192.168.5.x
  → Freebox (route 10.1.0.0/16 → 192.168.5.100)
  → gammaWTR : DNAT 10.1.50.10:8443 → 10.10.10.1:8443 + MASQUERADE vers wg0
  → hub WireGuard (10.10.10.1) : tunnel SSH inverse
  → plasmasrv 127.0.0.1:8443 (nginx `dev-proxy`)
```

- **plasmasrv** : `~/bin/lavande-dev-tunnel.sh` (boucle de relance) lancé dans tmux
  `lavande-tunnel`, + `@reboot` dans la crontab.
- **gammaWTR** : `iptables -t nat -A PREROUTING -d 10.1.50.10/32 -i vmbr0 -p tcp --dport 8443
  -j DNAT --to-destination 10.10.10.1:8443` et
  `-A POSTROUTING -d 10.10.10.1/32 -o wg0 -p tcp --dport 8443 -j MASQUERADE`, persistés
  (`netfilter-persistent save`).

Vérifié de bout en bout depuis un invité du LAN derrière gammaWTR :
`curl https://plasma.int.lanro.eu:8443/lavande/` → `200`.

### Si le portail tombe en timeout

Le maillon faible est le **tunnel SSH inverse**. Panne du 09/11 : le VPS gardait un `sshd-session`
fantôme sur `10.10.10.1:8443` pendant 64 min, et le client bouclait sur
`remote port forwarding failed for listen port 8443`.

- Côté VPS : `ss -ltnp | grep 8443` → si le port est tenu par un `sshd-session` ancien
  (`ps -o etimes -p <pid>`), `kill <pid>` le libère.
- Cause traitée : `sshd` n'avait **aucun `ClientAliveInterval`** (`0`) → sessions mortes jamais
  recyclées. Drop-in `/etc/ssh/sshd_config.d/99-keepalive.conf` (`15` / `3`) : libération en ~45 s.
- Côté plasmasrv : keepalive client `15`/`2` + watchdog `~/bin/lavande-dev-watchdog.sh`
  (cron `*/5`, relance la session tmux `lavande-tunnel` si le hub ne répond plus).

## Firewall OPNsense (fait le 09/11)


Deux firewalls, deux causes distinctes :

1. **SLP — le ruleset ne se chargeait plus.** `/tmp/rules.error` :
   `rules.debug:180: syntax error … proto any`. Une règle portait `<protocol>any</protocol>` ; pf refuse
   la syntaxe et `configctl filter reload` répond **`OK` quand même** → toutes les règles ajoutées
   ensuite étaient inactives en silence. Toujours lire `/tmp/rules.error` après un reload.
2. **Aucune règle pf n'autorisait `wg0 → plasmaSRV:8443`** : le groupe `wireguard` n'ouvre que
   ICMP + tcp 22/443 vers `(self)`, et le SSH observé était en réalité **sortant** (plasmaSRV →
   `192.168.5.50:22`), pas l'inverse.

### Politique temporaire en place

Alias `RESEAUX_INTERNES` (type `network` : `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) et
**21 règles par firewall** `INTERNE ANY (temporaire, log)` — 7 interfaces (`lan`, `opt1`…`opt5`,
`wireguard`) × tcp/udp/icmp, source et destination = l'alias, `log` actif, `disablereplyto=1`,
placées en tête du ruleset.

Retrait : supprimer les règles dont la description commence par `INTERNE ANY`, puis
`configctl filter reload`.

Scripts versionnés ici (idempotents, PHP + `write_config` / modèle `Alias`) :
`opnsense-alias-interne.php` (l'alias, via le modèle), `opnsense-interne-any-rules.php` (les 21 règles),
`opnsense-fix-proto-any.php` (le piège `proto any`), `opnsense-dev-portal.php` + `-no-replyto.php`
(les deux règles ciblées 8443, désormais redondantes avec la politique large).

Vérifié depuis le firewall GN : `nc -z 10.1.50.10 8443` → OK, `curl -sk https://10.1.50.10:8443/lavande/` → `200`.

## Firewall côté hôte


État réel de la machine (relevé en lecture seule sur la pile iptables/nftables) :

- `/etc/ufw/ufw.conf` → **`ENABLED=no`** : ufw n'applique aucun jeu de règles ;
- `iptables -S` → **`-P INPUT ACCEPT`**, 0 règle dans `INPUT` (les 31 règles présentes
  sont celles de Docker, en `FORWARD`/`NAT`) ;
- `nft list ruleset` → uniquement le NAT de Docker.

Conséquence : `1420` et `8443` sont joignables depuis **tout réseau routé** (donc
`192.168.5.0/24`, `192.168.1.0/24`, et plus si la box forwarde), et il en va de même pour
tous les services publiés par Docker.

Écoute hors loopback au moment du relevé : `22`, `443` (proxy Nihyl, lié à `10.1.50.10`),
`1420`, `8443`, `3000`, `8080`, `8777`, `18777`, `8888`, `8889`, `9222` (socat → Chrome
DevTools), `9876`.

Si tu veux activer un filtrage, deux étages séparés :

```bash
# 1. entrant hôte : ne casser pas ton propre SSH (adapte les sources !)
sudo ufw default deny incoming
sudo ufw allow from 10.1.50.0/24 to any port 22 proto tcp
sudo ufw allow from 192.168.5.0/24 to any port 22 proto tcp
sudo ufw allow from 10.1.50.0/24 to any port 8443 proto tcp
sudo ufw allow from 192.168.5.0/24 to any port 8443 proto tcp
sudo ufw --force enable

# 2. ports publiés par Docker : ils passent en FORWARD, ufw ne les voit pas.
#    Il faut des règles DOCKER-USER (ou arrêter de publier sur 0.0.0.0).
```

`sudo ufw status` demande un mot de passe que je n'ai pas (`sudo -n -l` n'autorise sans
mot de passe que `/usr/local/sbin/nihyl-tls-deploy`).

## Résolution du serveur mail (IMAP/SMTP)

`mail.lanro.eu` résout publiquement vers `194.164.201.13`, où les ports IMAP/SMTP (993, 143, 465,
587) sont **filtrés** ; le serveur Dovecot/Postfix réel écoute sur `192.168.5.121` avec un certificat
Let's Encrypt valide pour `mail.lanro.eu` / `imap.lanro.eu`.

Conséquence pour le démon mail (`lavande-maild`) : il se connecte au **nom**, donc il lui faut une
résolution interne. Deux options propres :

- ajouter un enregistrement A interne (ou une entrée `/etc/hosts` sur la machine qui héberge le
  service) : `192.168.5.121 imap.lanro.eu smtp.lanro.eu` ;
- ou lancer le démon avec une surcharge de résolution sans toucher au système, par exemple un
  conteneur `--network host --add-host imap.lanro.eu:192.168.5.121` (utilisé pour la recette avec le
  compte réel : le certificat reste validé, l'IP n'étant pas dans ses SAN).

Vérification en lecture seule, sans modifier aucun drapeau :

```bash
openssl s_client -connect 192.168.5.121:993 -servername mail.lanro.eu </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -ext subjectAltName
```
