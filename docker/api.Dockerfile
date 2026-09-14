# syntax=docker/dockerfile:1
#
# La imagen de la API, y también la del paso de migración y la del seed: los tres son el mismo
# código con distinto `command`, y tres imágenes casi iguales solo dan tres formas de que una se
# quede vieja.
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable

# Los manifiestos primero, para que la capa de `pnpm install` sobreviva a cualquier cambio de
# código. **Todos**: la API depende de `@eq/runner-core`, `@eq/spec-import` y `@eq/contracts` como
# paquetes del workspace, y sin sus manifiestos aquí `pnpm install` no crea los enlaces — que fue
# exactamente cómo esta imagen llegó a arrancar y morir con `Cannot find module '@eq/spec-import'`.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/runner-core/package.json packages/runner-core/
COPY packages/security-rules/package.json packages/security-rules/
COPY packages/spec-import/package.json packages/spec-import/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile

COPY . .
# En orden: la API importa el resultado compilado de los otros dos, no sus fuentes.
# `@eq/contracts` no emite código: son las declaraciones que el navegador y la API comparten, y
# `tsc` las necesita presentes para compilar la API aunque el `import type` se borre al salir.
RUN pnpm --filter @eq/contracts build \
 && pnpm --filter @eq/runner-core build \
 && pnpm --filter @eq/security-rules build \
 && pnpm --filter @eq/spec-import build \
 && pnpm --filter @eq/api build
# Fuera las dependencias de desarrollo — TypeScript, los tipos, el corredor de pruebas — de todo
# el workspace, no solo de la API.
RUN pnpm -r --prod prune 2>/dev/null || pnpm prune --prod

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Sin root: un proceso que hace peticiones HTTP a destinos que escribe el usuario no debería
# además ser root dentro de su contenedor.
RUN addgroup -S eq && adduser -S eq -G eq

# El árbol del workspace tal cual, porque los enlaces de pnpm dentro de `node_modules` apuntan a
# `packages/*` por ruta relativa: copiar solo `node_modules` deja símbolos colgando.
COPY --from=build --chown=eq:eq /repo/node_modules ./node_modules
COPY --from=build --chown=eq:eq /repo/packages/runner-core/package.json ./packages/runner-core/
COPY --from=build --chown=eq:eq /repo/packages/runner-core/dist ./packages/runner-core/dist
COPY --from=build --chown=eq:eq /repo/packages/security-rules/package.json ./packages/security-rules/
COPY --from=build --chown=eq:eq /repo/packages/security-rules/dist ./packages/security-rules/dist
# Nada lo importa en ejecución —son solo tipos— pero el enlace de pnpm apunta aquí, y un enlace
# colgando es una forma de que algún día un `require` resuelva a la nada.
COPY --from=build --chown=eq:eq /repo/packages/contracts/package.json ./packages/contracts/
COPY --from=build --chown=eq:eq /repo/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=eq:eq /repo/packages/spec-import/package.json ./packages/spec-import/
COPY --from=build --chown=eq:eq /repo/packages/spec-import/dist ./packages/spec-import/dist
COPY --from=build --chown=eq:eq /repo/packages/spec-import/node_modules ./packages/spec-import/node_modules
COPY --from=build --chown=eq:eq /repo/packages/runner-core/node_modules ./packages/runner-core/node_modules
COPY --from=build --chown=eq:eq /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=eq:eq /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=eq:eq /repo/apps/api/package.json ./apps/api/

# `eq-run.mjs` viaja con la API a propósito: es parte del producto, no del repositorio. Quien
# despliega esta imagen puede lanzar la matriz desde ella —
# `docker compose run --rm api node tools/eq-run.mjs …` — sin clonar nada. Y `seed-demo.mjs`
# necesita la configuración de ejemplo que hay al lado.
COPY --from=build --chown=eq:eq /repo/tools/eq-run.mjs /repo/tools/seed-demo.mjs ./tools/
COPY --from=build --chown=eq:eq /repo/examples/sample-api/config.json ./examples/sample-api/

USER eq
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]
