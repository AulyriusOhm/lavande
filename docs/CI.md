# CI — Gitea Actions

Workflow [`.gitea/workflows/ci.yml`](../.gitea/workflows/ci.yml), exécuté par le runner Gitea
`ohm-runner` (labels `ubuntu-latest` / `ubuntu-24.04` / `ubuntu-22.04`), sur tout `push` vers `main`
et toute `pull_request` visant `main`. Trois jobs **parallèles**, aucun secret, aucun service docker :
l'image du runner n'est pas figée, le workflow installe donc ses propres outils (rustup stable +
rustfmt + clippy, `cargo-audit`) et n'attend de l'image que `curl`, `git` et un `cc` système pour
l'édition de liens des tests Rust.

| Job | Ce qu'il vérifie | Commandes |
| --- | --- | --- |
| `rust` | formatage, lint, tests unitaires du workspace, vulnérabilités des 3 lockfiles | `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `cargo audit` (×3 lockfiles) |
| `front` | typecheck + build Vite, vitest, vulnérabilités des dépendances livrées | `npm ci`, `npm run build`, `npm test`, `npm audit --omit=dev --audit-level=high` |
| `vitrine` | typecheck + build du site vitrine, vulnérabilités livrées (pas de tests) | `npm ci`, `npm run build`, `npm audit --omit=dev --audit-level=high` (working-directory `site-vitrine`) |

Le job `rust` ne compile que le workspace racine (`crates/mail-core`, `crates/mail-api`) : `src-tauri`
et `server` sont dans `exclude` du `Cargo.toml` et gardent chacun leur `Cargo.lock`, d'où les trois
`cargo audit -f`. Le cache `actions/cache@v4` couvre `~/.cargo/registry`, `~/.cargo/git` et `target`,
clé `${{ runner.os }}-cargo-${{ hashFiles('**/Cargo.lock') }}` : une montée de dépendance Rust
invalide le cache.

## Reproduire les checks en local

```bash
npm run mail:fmt                            # cargo fmt --all -- --check
npm run mail:clippy                         # cargo clippy --workspace --all-targets -- -D warnings
npm run mail:test                           # cargo test --workspace
npm run build                               # tsc --noEmit && vite build
npm test                                    # vitest run
(cd site-vitrine && npm run build)          # tsc --noEmit -p tsconfig.json && vite build

cargo install cargo-audit --locked          # une fois
cargo audit                                 # workspace
cargo audit -f src-tauri/Cargo.lock
cargo audit -f server/Cargo.lock

npm audit --omit=dev --audit-level=high
(cd site-vitrine && npm audit --omit=dev --audit-level=high)
```

Écarts avec la CI, tous volontaires : la CI part d'un `npm ci` propre (pas de `node_modules` local),
utilise le rustup stable du jour au lieu du toolchain installé sur la machine, et son cache
`~/.cargo` + `target` peut masquer un rebuild complet — un doute sur une régression Rust se tranche
en local après `cargo clean`. Les tests Rust locaux passent par le wrapper `cc` de cette machine
(voir [`E2E.md`](./E2E.md#distinguer-les-suites)) ; sur le runner, c'est le `cc` de l'image.

## Politique d'audit

Le gate CI ne porte que sur les **vulnérabilités réelles** :

- `cargo audit` — une vulnérabilité fait échouer le job (comportement par défaut). `.cargo/audit.toml`
  (seul emplacement lu par cargo-audit 0.23, pas de flag `--config`) ne contient que des `ignore`
  motivés ; les avertissements `unmaintained` / `unsound` restent des avertissements, ils n'échouent
  pas le job.
- `npm audit --omit=dev --audit-level=high` — seules les dépendances **livrées** comptent, et
  seulement à partir de la sévérité *high*. Une vulnérabilité `devDependencies` ne fait pas échouer
  la CI.

### `.cargo/audit.toml` — ignores motivés

| Avis | Crate | Motif | À re-vérifier |
| --- | --- | --- | --- |
| RUSTSEC-2023-0071 (Marvin) | `rsa` | aucun correctif upstream : `rpgp` (main) dépend encore de `rsa` 0.9.10 ; côté `server`, `rsa` vient de `sqlx-mysql`, dépendance **optionnelle jamais compilée** | montée de `pgp` |
| RUSTSEC-2026-0387 | `crypto-bigint` | tiré par `pgp` 0.21, pas de version amont corrigée | montée de `pgp` |
| RUSTSEC-2026-0459 | `libsqlite3-sys` | `server/Cargo.lock` uniquement : via `sqlx-sqlite`, dépendance **optionnelle jamais compilée** (postgres seul) ; correctif >= 0.39 seulement via `sqlx` 0.9 | montée de `sqlx` |
| unmaintained | `chrono`, `pin-utils`, `zbus_names`, `zvariant`, `zvariant_derive`, `proc-macro-error` | crates non maintenus, sans vulnérabilité connue, tirés par la pile Tauri/zbus | montée de `tauri` |
| RUSTSEC-2024-0429 (unsound) | `glib` | corrigé à partir de `glib` 0.20, incompatible avec le Tauri actuel | montée de `tauri` |

Toute entrée ajoutée doit porter son motif et sa condition de sortie ; les cinq lignes ci-dessus se
re-vérifient à chaque montée de `pgp`, `tauri` ou `sqlx`.

### picomatch — GHSA-fc5q-39xc-vjpf (ReDoS)

Avis publié le 19/10/2026 : **toutes** les versions `picomatch` <= 4.0.7 sont vulnérables et aucune
version corrigée n'est publiée. Les deux lockfiles embarquent `picomatch` 4.0.7 (via `vite` 7.3.8).

- La dépendance n'existe que côté **devDependencies** (`vite`, `vitest`, `fdir`, `tinyglobby`) : rien
  dans les bundles livrés, donc `npm audit --omit=dev --audit-level=high` renvoie **0 vulnérabilité**
  aux deux racines npm (front et vitrine) — c'est ce que vérifie la CI.
- **Ne pas** lancer `npm audit fix --force` : il propose un downgrade vers `vite` 6.2.7, qui dépend
  lui aussi de `picomatch` — le « correctif » ne corrige rien et fait régresser le build.
- Surveiller la publication d'un `picomatch` corrigé, puis `npm update picomatch` aux deux racines
  (régénérer les `package-lock.json` et relancer `npm test` + `npm run build`).

## Hors CI v1

Ces suites demandent une infrastructure que le runner ne fournit pas (docker, PostgreSQL, GreenMail,
chromium) : elles restent locales et manuelles.

| Suite | Commande | Dépendances |
| --- | --- | --- |
| tests live IMAP/SMTP | `npm run mail:test:live` | GreenMail démarré, `--test-threads=1` |
| e2e synchro Postgres | `npm run e2e` | serveur `server/` démarré, voir [`SYNC.md`](./SYNC.md#10-vérification) |
| e2e UI | `npm run e2e:ui` | docker, chromium, binaire du démon, voir [`E2E.md`](./E2E.md) |
| tests du serveur | `cd server && cargo test` | PostgreSQL 16 sur `DATABASE_URL`, voir [`server/README.md`](../server/README.md#tests) |

## Releases

Les releases restent **manuelles** : `scripts/release.sh` + skill `lavande-release`. Les clés de
signature (paquets, manifeste de mise à jour) ne sont jamais sur le runner (voir
[`SIGNING.md`](./SIGNING.md)), et la CI ne déploie rien — elle ne fait que vérifier.
