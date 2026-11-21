# CI — Gitea Actions

Workflow [`.gitea/workflows/ci.yml`](../.gitea/workflows/ci.yml), exécuté par le runner Gitea
`ohm-runner` (labels `ubuntu-latest` / `ubuntu-24.04` / `ubuntu-22.04`), sur tout `push` vers `main`
et toute `pull_request` visant `main`. Quatre jobs **parallèles**, aucun secret, aucun service docker :
l'image du runner n'est pas figée, le workflow installe donc ses propres outils (rustup stable +
rustfmt + clippy, `cargo-audit`, JDK 21 + SDK + NDK Android) et n'attend de l'image que `curl`, `git`,
`unzip` (installé à la volée s'il manque) et un `cc` système pour l'édition de liens des tests Rust.

| Job | Ce qu'il vérifie | Commandes |
| --- | --- | --- |
| `rust` | formatage, lint, tests unitaires du workspace, vulnérabilités des 3 lockfiles | `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `cargo audit` (×3 lockfiles) |
| `front` | typecheck + build Vite, vitest, vulnérabilités des dépendances livrées | `npm ci`, `npm run build`, `npm test`, `npm audit --omit=dev --audit-level=high` |
| `vitrine` | typecheck + build du site vitrine, vulnérabilités livrées (pas de tests) | `npm ci`, `npm run build`, `npm audit --omit=dev --audit-level=high` (working-directory `site-vitrine`) |
| `android` | build debug complet de l'app Android (codegen + Rust `aarch64-linux-android` + Kotlin + APK debug **non signé**) — aucune signature, aucun émulateur, aucune publication | voir « Job `android` — vérification de compilation » ci-dessous |

Le job `rust` ne compile que le workspace racine (`crates/mail-core`, `crates/mail-api`) : `src-tauri`
et `server` sont dans `exclude` du `Cargo.toml` et gardent chacun leur `Cargo.lock`, d'où les trois
`cargo audit -f`. Pas de cache pour l'instant : le service de cache du runner est injoignable depuis
les jobs (`getCacheEntry … connect ETIMEDOUT`, ~4 min de timeout par tentative, constaté au premier
run). À réactiver quand l'infra sera corrigée : `actions/cache@v4` sur `~/.cargo/registry`,
`~/.cargo/git`, `target` (clé sur `hashFiles('**/Cargo.lock')`) et `cache: npm` pour `setup-node`.

## Build Windows — GitHub Actions (miroir)

Le dépôt est poussé en miroir vers `github.com/AulyriusOhm/lavande` (miroir de push Gitea,
`sync_on_commit`). Le workflow [`.github/workflows/windows.yml`](../.github/workflows/windows.yml)
y compile nativement sur `windows-latest` (toolchain MSVC préinstallée) : `cargo test --workspace`
puis l'installeur NSIS **non signé** (`Lavande_<version>_x64-setup.exe`, artifact
`lavande-windows-x64`, rétention 14 jours). Aucune clé sur le runner : la release locale récupère
l'exe, le signe et publie l'entrée `windows-x86_64` du manifeste (politique `SIGNING.md`).

- `npm run build:distribution` porte un préfixe d'environnement POSIX que `cmd.exe` refuse : le job
  construit le front à part (`VITE_DISTRIBUTION=1` en `env:`) et neutralise `beforeBuildCommand`
  via `--config '{"build":{"beforeBuildCommand":"cmd /C exit 0"}}'` (étape en `shell: bash`).
- La push protection GitHub est désactivée sur le miroir : GH013 bloquait le push de toutes les
  refs à cause d'un secret détecté dans une branche historique (`feat/android-ui`).
- Le runtime Windows n'est pas encore validé (répertoires de données XDG à adapter) : le job
  garantit la compilation et l'installeur, pas le comportement sur un vrai Windows.

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
utilise le rustup stable du jour au lieu du toolchain installé sur la machine, et repart d'un
`target/` vide à chaque run (pas de cache) — un doute sur une régression Rust se tranche en local
après `cargo clean`. Les tests Rust locaux passent par le wrapper `cc` de cette machine
(voir [`E2E.md`](./E2E.md#distinguer-les-suites)) ; sur le runner, c'est le `cc` de l'image.

## Job `android` — vérification de compilation

Le job `android` vérifie que l'app **compile** des deux côtés via un build debug complet : il produit
un APK debug **non signé** (jamais publié) et les `.so` aarch64, mais pas de keystore, pas de signature,
pas d'émulateur, pas de publication. La release
Android reste manuelle (`scripts/build-android-release.sh`, voir [`android.md`](./android.md)) et les
clés de signature ne sont jamais sur le runner (voir [`SIGNING.md`](./SIGNING.md)).

| Étape | À quoi elle sert |
| --- | --- |
| `actions/setup-java@v4` (temurin 21) | même JDK que la machine de build ; Gradle 9.6.1 et AGP 9.3.1 l'exigent |
| rustup stable + `rustup target add aarch64-linux-android` | seule ABI livrée (voir « Build mono-ABI arm64 » dans [`android.md`](./android.md)) |
| SDK Android via cmdline-tools : `platform-tools`, `platforms;android-37.0`, `build-tools;36.0.0`, `ndk;28.2.13676358` | `compileSdk`/`targetSdk` 37 et le NDK réellement utilisés ; `build-tools` 36.0.0 est la version par défaut d'AGP 9.3.1 (constatée sur la machine de build), `37.0.0` existe aussi si AGP monte ; les licences sont acceptées dans le job, donc AGP peut provisionner un autre paquet au besoin |
| `cargo fetch --manifest-path src-tauri/Cargo.toml` | **obligatoire avant** le build : `tauri.settings.gradle` (généré par `tauri android build`, **pas** par `init`) contient des chemins **absolus** vers `~/.cargo/registry/src/index.crates.io-…/tauri-<version>/mobile/android` (idem `tauri-plugin-*`) et Gradle fait `include ':tauri-android'` — sans les sources extraites, la configuration Gradle échoue |
| `npx tauri android init --ci --skip-targets-install` + `node scripts/patch-android.mjs` | régénère `src-tauri/gen/android` (ignoré par git) et applique tous les patchs Kotlin / manifeste / `networkSecurityConfig` ; `--skip-targets-install` évite d'ajouter les trois autres cibles Android, inutiles ici |
| `source scripts/android-env.sh` + `CC_aarch64_linux_android` / `AR_…` / `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER` | la coquille Rust compile pour Android, C cross-compilé inclus (`ring`, `libsqlite3-sys`…) ; `scripts/android-env.sh` honore les `JAVA_HOME` / `ANDROID_HOME` / `NDK_HOME` exportés par le job et ne pose que le `PATH` et le `cc` hôte — un seul chemin de code entre CI et machine locale |
| `npx tauri android build --ci --debug --apk -t aarch64` | génère `tauri.settings.gradle` (codegen — **absent après `init` seul**, d'où l'échec `settings.gradle` ligne 3 « Could not read script tauri.settings.gradle » si on saute le build), compile la coquille Rust pour aarch64 (`.so`), le Kotlin (flavor `universal` debug) et emballe un APK debug **non signé**. `CARGO_BUILD_JOBS=2` limite la RAM. Pas de keystore ni `apksigner` |

À connaître :

- **Coût ~15–25 min à froid** : SDK + NDK (~1,5 Go), distribution Gradle 9.6.1, build Rust aarch64
  complet + Kotlin + APK debug. Aucun cache pour l'instant (même service de cache que les autres jobs) ; à
  réactiver avec `~/.cargo/registry`, `~/.gradle/caches` et `$ANDROID_HOME` une fois l'infra réparée.
- **Ressources** : disque (NDK + target Rust + Gradle, ~15 Go libres nécessaires) et RAM
  (`org.gradle.jvmargs=-Xmx2048m`, `CARGO_BUILD_JOBS=2`) sont les points sensibles. Le disque du runner
  (45G) sature si les vieilles images docker s'accumulent (watchtower) : un prune régulier
  (`docker image prune -af --filter until=168h`) maintient la baseline — sinon « No space left on device »
  pendant le build.
- **Paquets SDK** : `platforms;android-37.0`, `build-tools;37.0.0` et `ndk;28.2.13676358` sont publiés
  sur le canal stable (`sdkmanager --list`). Si un paquet venait à disparaître, repli : installer
  `platforms;android-36` et laisser AGP provisionner 37 (licences déjà acceptées), puis documenter ici.
- **Aucun test de l'app** : ni émulateur, ni `adb`, ni `androidTest`, ni `npm run e2e:ui` — tout cela
  reste local (voir « Hors CI v1 »).
- Aucun secret, aucune variable `LAVANDE_KEYSTORE*`, aucun `apksigner` / `zipalign` / `release-updater.mjs`
  dans ce job.

Reproduire en local :

```bash
npm run android:init                                            # tauri android init + patch
source scripts/android-env.sh
npx tauri android build --ci --debug --apk -t aarch64           # codegen + Rust aarch64 + Kotlin + APK non signé
```

Le build local a besoin des mêmes `CC_` / `AR_` / linker NDK que la CI ; `tauri android build` les
pose aussi lui-même via `android-env.sh`.

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
