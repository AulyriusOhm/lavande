#!/usr/bin/env bash
# Bundle « démo lecture seule » embarqué par le site vitrine sous /demo/.
# Sans VITE_DISTRIBUTION (les fixtures restent) ni VITE_PLATFORM (build web).
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p site-vitrine/public/demo

npx tsc --noEmit

VITE_MAIL_BACKEND=demo VITE_DEMO_READONLY=1 \
  npx vite build --base /demo/ --outDir site-vitrine/public/demo --emptyOutDir

# Les maquettes HTML du dossier public ne servent pas la démo embarquée.
rm -rf site-vitrine/public/demo/maquettes
