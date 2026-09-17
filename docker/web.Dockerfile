# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
# `@eq/contracts` son las declaraciones que este bundle y la API comparten. No emiten código —
# cada import es un `import type` y se borra— pero `tsc` las necesita para comprobar el front.
COPY packages/contracts/package.json packages/contracts/
# `@eq/import-detect` sí emite código, y entra en el bundle: es la función que nombra lo que
# sueltas en el import, y la comparte con la API para que el plan no pueda prometer una cosa y
# el import hacer otra.
COPY packages/import-detect/package.json packages/import-detect/
RUN pnpm install --frozen-lockfile --filter @eq/web...
COPY . .
RUN pnpm --filter @eq/contracts build && pnpm --filter @eq/import-detect build
# The API origin is baked in at build time, as every static bundle's is. A deployment that needs
# a different one rebuilds; the alternative is a runtime config fetch on every page load.
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @eq/web build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY docker/web.nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
