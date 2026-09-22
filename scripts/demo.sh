#!/usr/bin/env bash
#
# El producto entero y algo que verificar, de un tirón.
#
#     scripts/demo.sh          levanta todo y siembra la demostración
#     scripts/demo.sh down     lo para y borra el volumen de Postgres
#
# Lo único que hace de más que `docker compose up` es generar los secretos la primera vez. La API
# se niega a arrancar sin ellos, a propósito: un valor por defecto en un fichero versionado firma
# las sesiones de todo el mundo con la misma clave. Generarlos aquí y dejarlos en `docker/.env`,
# que está en el .gitignore, es la forma de que eso no cueste una lectura del README antes de ver
# nada funcionando.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/docker/.env"
COMPOSE=(docker compose -f "$ROOT/docker/compose.yml" -f "$ROOT/docker/compose.demo.yml")

if [ "${1:-up}" = "down" ]; then
  # `-v` incluido: es una demostración, y dejar el volumen hace que el segundo `demo.sh` arranque
  # sobre los datos del primero, que es justo lo que alguien que dice "abajo" no quiere.
  "${COMPOSE[@]}" down -v
  exit 0
fi

command -v docker >/dev/null || { echo "Falta docker."; exit 2; }
docker info >/dev/null 2>&1 || { echo "Docker no está corriendo."; exit 2; }

if [ ! -f "$ENV_FILE" ]; then
  secret() { openssl rand -base64 48 | tr -d '\n='; }
  # `SECRETS_KEY` es la clave de AES-256 y tiene que decodificar a **exactamente** 32 bytes: con
  # los 48 de `secret()` la demo arranca y revienta al guardar la primera credencial de un destino.
  key32() { openssl rand -base64 32 | tr -d '\n'; }
  cat > "$ENV_FILE" <<EOF
# Generado por scripts/demo.sh. No se versiona.
#
# JWT_*   firman los tokens de sesión. Cambiarlos cierra la sesión de todo el mundo.
# SECRETS_KEY cifra las credenciales de los destinos (AES-256-GCM). **Perderla es perder esas
#         credenciales**: no hay forma de descifrarlas sin ella, que es la única propiedad que
#         hace que guardarlas valga la pena.
JWT_ACCESS_SECRET=$(secret)
JWT_REFRESH_SECRET=$(secret)
SECRETS_KEY=$(key32)
EOF
  chmod 600 "$ENV_FILE"
  echo "secretos generados en docker/.env"
fi

"${COMPOSE[@]}" up --build -d postgres migrate api web sample-api
echo
echo "sembrando la demostración…"
echo
# En primer plano y sin `-d`: la salida del seed —la cuenta, el token de servicio, la corrida y
# sus rojos— es lo que hay que leer.
#
# `--build` porque el seed corre desde su imagen, no desde el árbol de ficheros. Sin esto, editar
# `tools/seed-demo.mjs` y volver a lanzar la demostración ejecuta la versión anterior, en silencio.
"${COMPOSE[@]}" run --rm --no-deps --build seed || true

cat <<EOF

  Interfaz      http://localhost:${EQ_WEB_PORT:-8080}
  API           http://localhost:${EQ_API_PORT:-3001}  ·  contrato en /openapi.json
  Destino       http://localhost:${EQ_SAMPLE_PORT:-9100}  ·  su contrato en /openapi.json

  Parar         scripts/demo.sh down

  Si algún puerto está ocupado: EQ_WEB_PORT=8081 scripts/demo.sh
  (también EQ_API_PORT, EQ_POSTGRES_PORT y EQ_SAMPLE_PORT)
EOF
