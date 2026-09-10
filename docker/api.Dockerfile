# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/runner-core/package.json packages/runner-core/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @eq/api build && pnpm --filter @eq/api exec pnpm prune --prod

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Sin root: un proceso que hace peticiones HTTP a destinos que escribe el usuario no debería
# además ser root dentro de su contenedor.
RUN addgroup -S eq && adduser -S eq -G eq
COPY --from=build --chown=eq:eq /repo/node_modules ./node_modules
COPY --from=build --chown=eq:eq /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=eq:eq /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=eq:eq /repo/apps/api/package.json ./apps/api/
USER eq
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]
