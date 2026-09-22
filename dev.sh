#!/usr/bin/env bash
#
# Levanta las tres implementaciones de la API y el front en local, contra el PostgreSQL de la
# máquina.
#
# Existe porque arrancarlos a mano es fácil de hacer a medias: las APIs necesitan las variables de
# `.env.local` —**las mismas para las tres**, que es lo que hace que una sesión abierta contra una
# siga viva contra otra— y el front necesita que estén escuchando antes de proxear. Ctrl-C para
# todas a la vez.
#
# Python y Go son opcionales: si no tienes su entorno preparado, el arranque lo dice y sigue con
# Node. El selector del front marcará las que no contesten en vez de ofrecerlas como si nada.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env.local ] || { echo "Falta .env.local. Copia .env.example y define los tres secretos."; exit 1; }

# Un arranque anterior que quedó vivo se lleva el puerto y el nuevo proceso muere en silencio
# por EADDRINUSE, dejándote hablando con el binario viejo.
for port in 3001 3002 3003 5173; do
  lsof -ti:$port | xargs -r kill -9 2>/dev/null || true
done

set -a; . ./.env.local; set +a

echo "→ compilando la API"
pnpm --filter @eq/api build >/dev/null

echo "→ migraciones"
# El esquema es de `apps/api` y solo de él: los otros dos backends leen y escriben en él, y nunca
# emiten DDL. Ver docs/backends-poliglotas.md.
(cd apps/api && npx typeorm-ts-node-commonjs migration:run -d src/shared/database/data-source.ts >/dev/null)

echo "→ API (NestJS) en http://localhost:3001"
(cd apps/api && node dist/main.js) &
API=$!
PIDS=($API)

if [ -x apps/api-py/.venv/bin/python ]; then
  echo "→ API (FastAPI) en http://localhost:${PORT_PY:-3002}"
  (cd apps/api-py && .venv/bin/python -m eq_api) &
  PIDS+=($!)
else
  echo "· FastAPI omitida: prepara su entorno con «cd apps/api-py && uv venv .venv && uv pip install --python .venv/bin/python -e .»"
fi

if command -v go >/dev/null 2>&1; then
  echo "→ API (Go) en http://localhost:${PORT_GO:-3003}"
  (cd apps/api-go && go run .) &
  PIDS+=($!)
else
  echo "· Go omitido: no hay toolchain de Go en el PATH."
fi

until curl -sf http://localhost:3001/health >/dev/null 2>&1; do sleep 1; done
echo "→ front en http://localhost:5173"
(cd apps/web && npx vite --port 5173) &
PIDS+=($!)

trap 'kill "${PIDS[@]}" 2>/dev/null || true' EXIT INT TERM
wait
