#!/usr/bin/env bash
#
# P6: the parity cut, both passes, end to end.
#
# Runs the coupled dashboard's own executor and the product's runner over the same matrix against
# the same target, each against a **freshly reset** E2E backend, and compares the verdicts case by
# case. `sin --auth` covers the 214 cases the old suite could reach; `con --auth` covers all 311,
# including the 97 that need a credential to mean anything.
#
# Needs, and says so rather than failing halfway:
#   - the endpoint-quality API running (./dev.sh) with the Digital Catalog project migrated
#   - the digital-catalog-back-end repo beside this one, with `uv` on the PATH
#   - Postgres and Redis for the E2E backend, which `e2e_env.py` resets and seeds itself
#
#     EQ_EMAIL=you@example.com EQ_PASSWORD='…' scripts/parity-cut.sh
#
# Exit code is the verdict: 0 only if both passes matched case for case.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="${EQ_BACKEND_REPO:-$ROOT/../geronimo-martings/digital-catalog-back-end}"
OUT="${EQ_CUT_OUT:-$ROOT/.parity-cut}"
API="${EQ_API:-http://localhost:3001}"
CUT="$ROOT/tools/parity-cut/cut.ts"
NODE_RUN=(node --experimental-strip-types)

: "${EQ_EMAIL:?Falta EQ_EMAIL}"
: "${EQ_PASSWORD:?Falta EQ_PASSWORD}"

[ -d "$BACKEND" ] || { echo "No encuentro el backend E2E en $BACKEND (EQ_BACKEND_REPO)"; exit 2; }
command -v uv >/dev/null || { echo "Falta uv en el PATH: el arnés E2E es Python"; exit 2; }
curl -fsS -o /dev/null --max-time 3 "$API/health" || { echo "La API de endpoint-quality no responde en $API: arranca ./dev.sh"; exit 2; }

# The harness refuses to start when the port is taken, and it is right to: it would otherwise get
# a healthy /health from whatever was already there and run the whole cut against stale data.
if lsof -ti:8100 >/dev/null 2>&1; then
  echo "El puerto 8100 está ocupado. Párala antes: lsof -ti:8100 | xargs kill"
  exit 2
fi

mkdir -p "$OUT"
status=0

side() {
  local name="$1" auth_flag="$2" out="$3"; shift 3
  echo "── $name${*:+ $*}"
  ( cd "$BACKEND" && uv run --frozen python scripts/e2e_env.py $auth_flag run -- \
      env EQ_API="$API" EQ_EMAIL="$EQ_EMAIL" EQ_PASSWORD="$EQ_PASSWORD" \
      "${NODE_RUN[@]}" "$CUT" "$name" $auth_flag "$@" --out "$out" )
}

echo
echo "════ Corte sin --auth (214 casos) ════"
side legacy  "" "$OUT/legacy.json"
side product "" "$OUT/product.json"
"${NODE_RUN[@]}" "$CUT" diff "$OUT/legacy.json" "$OUT/product.json" || status=1

echo
echo "════ Corte con --auth (311 casos) ════"
side legacy  --auth "$OUT/legacy-auth.json"
side product --auth "$OUT/product-auth.json"
"${NODE_RUN[@]}" "$CUT" diff "$OUT/legacy-auth.json" "$OUT/product-auth.json" || auth_status=1

# The third run is not a retry. The auth pass finds ten disagreements, all one cause: the coupled
# dashboard sends `Authorization` **and** `X-API-Key` together on `auth: "default"`, and an
# operation that does not declare `ApiKeyAuth` answers 401 to that however good the bearer is
# (D-29). So filling in the API key — which the 403 and D-29 cases require — turns every default
# write case red for a reason unrelated to the endpoint. Neutralising exactly that in the snapshot
# and getting identical parity is what proves the ten are one defect and not ten regressions.
if [ "${auth_status:-0}" -ne 0 ]; then
  echo
  echo "════ Aislando la causa: legacy con una sola credencial en auth:default ════"
  side legacy --auth "$OUT/legacy-auth-1cred.json" --legacy-single-credential
  if "${NODE_RUN[@]}" "$CUT" diff "$OUT/legacy-auth-1cred.json" "$OUT/product-auth.json"; then
    echo "Las diferencias de la pasada con --auth se explican enteramente por ese defecto del dashboard acoplado."
  else
    echo "Quedan diferencias que ese defecto no explica."
    status=1
  fi
fi

echo
[ $status -eq 0 ] && echo "P6: paridad idéntica, con la única divergencia explicada." || echo "P6: hay diferencias sin explicar. Los ficheros están en $OUT"
exit $status
