# Endpoint Quality

Verificación de contratos HTTP como producto: multi-proyecto, multi-entorno, con inicio de
sesión. Ejecuta la matriz de casos que una especificación OpenAPI declara y afirma sobre la
respuesta real — schema, envelope, presupuesto de latencia, autorización y persistencia.

**Un 200 no es un test que pasa.**

## Origen

Extraído de `geronimo-martings/documentation/endpoint-quality-dashboard`, donde el contrato, los
fixtures, los presupuestos del RFP y las credenciales estaban compilados dentro del bundle. Aquí
son datos de un proyecto.

Ese repo sigue vivo y **no se toca**: es el oráculo del test de paridad hasta la fase P6.

## Estructura

    apps/api          NestJS 11 + @nestjs/cqrs — comandos, consultas, saga de ejecución
    apps/web          Vite + React 19 + Tailwind — SPA, sin SSR
    packages/
      runner-core     Dominio puro: generación de escenarios, plan de ejecución,
                      presupuestos, validación JSON Schema. Sin framework.
      spec-import     OpenAPI 3.0/3.1 → Operation[]
      contracts       DTOs + esquemas zod compartidos api ↔ web
    docker            Dockerfiles y compose (api, web, postgres, redis)
    tools             Scripts de migración y mantenimiento

## Puesta en marcha

Todo junto, en contenedores:

    cp .env.example .env      # define JWT_ACCESS_SECRET, JWT_REFRESH_SECRET y SECRETS_KEY
    docker compose -f docker/compose.yml up

El front queda en `http://localhost:8080` y la API detrás de `/api`, mismo origen. Eso último no
es cosmético: la cookie de refresh es `SameSite=Strict`, y para que lo sea de verdad no puede
haber un segundo sitio.

En local, sin contenedores:

    pnpm install
    createdb endpoint_quality
    pnpm --filter @eq/api migration:run
    pnpm --filter @eq/api dev      # http://localhost:3001
    pnpm --filter @eq/web dev      # http://localhost:5173, con proxy a /api

Sin Redis: `QUEUE_DRIVER=memory` (por defecto) ejecuta la cola en el propio proceso. Es lo que
mantiene la ejecución local sin pedir infraestructura; `redis` es lo que quiere una instancia
compartida, donde una corrida debe sobrevivir a un reinicio.

## Plan

`docs/decoupling-plan.md` — diagnóstico del acople, modelo de dominio, superficie REST,
estrategia de pruebas y las 7 fases de entrega con sus criterios de aceptación.

## Seguridad

El motor hace peticiones HTTP a URLs que escribe el usuario. En un despliegue alojado eso es
SSRF si no se controla: ver §4.8 del plan y las variables `ALLOW_PRIVATE_TARGETS`,
`MAX_REDIRECTS` y `MAX_RESPONSE_BYTES`.
