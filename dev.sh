#!/usr/bin/env bash
#
# Levanta la API y el front en local, contra el PostgreSQL de la máquina.
#
# Existe porque arrancar los dos a mano es fácil de hacer a medias: la API necesita las variables
# de `.env.local` y el front necesita que la API esté escuchando antes de proxear. Ctrl-C para los
# dos a la vez.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env.local ] || { echo "Falta .env.local. Copia .env.example y define los tres secretos."; exit 1; }

# Un arranque anterior que quedó vivo se lleva el puerto y el nuevo proceso muere en silencio
# por EADDRINUSE, dejándote hablando con el binario viejo.
for port in 3001 5173; do
  lsof -ti:$port | xargs -r kill -9 2>/dev/null || true
done

set -a; . ./.env.local; set +a

echo "→ compilando la API"
pnpm --filter @eq/api build >/dev/null

echo "→ migraciones"
(cd apps/api && npx typeorm-ts-node-commonjs migration:run -d src/shared/database/data-source.ts >/dev/null)

echo "→ API en http://localhost:3001"
(cd apps/api && node dist/main.js) &
API=$!

until curl -sf http://localhost:3001/health >/dev/null 2>&1; do sleep 1; done
echo "→ front en http://localhost:5173"
(cd apps/web && npx vite --port 5173) &
WEB=$!

trap 'kill $API $WEB 2>/dev/null || true' EXIT INT TERM
wait
