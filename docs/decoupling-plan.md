# Plan de desacople — `endpoint-quality-dashboard` → producto multi-proyecto

Convertir el dashboard actual (acoplado a la API de Digital Catalog) en un producto genérico
de verificación de contratos HTTP: multi-proyecto, multi-entorno, con inicio de sesión, backend
propio en NestJS + CQRS, y ejecutable tanto en la web como en local.

- **Estado actual**: aplicación vinext/Cloudflare Worker de ~2.500 líneas, sin persistencia, con
  el contrato de un solo proyecto compilado dentro del bundle.
- **Estado objetivo**: monorepo con `apps/api` (NestJS + CQRS), `apps/web` (SPA), y paquetes
  compartidos; el contrato, los fixtures, los presupuestos de latencia y las credenciales pasan
  a ser **datos de un proyecto**, no código.
- **Criterio de éxito no negociable**: el proyecto "Digital Catalog", cargado como datos en el
  producto nuevo, debe reproducir exactamente la misma matriz de casos y los mismos veredictos
  que la versión acoplada. Un desacople que pierde aserciones no es un desacople, es una
  regresión con mejor arquitectura.

---

## 1. Diagnóstico: dónde está el acoplamiento

Once puntos concretos, cada uno con su destino en el modelo nuevo.

| # | Origen | Qué acopla | Destino |
|---|--------|-----------|---------|
| 1 | `lib/contract-operations.ts` | Las 46 operaciones de `bundled.yaml` **compiladas dentro del bundle**, generadas por `scripts/gen_dashboard_endpoints.py` del repo backend | `SpecVersion` + `Operation`: importación de OpenAPI en runtime, con hash y snapshot |
| 2 | `lib/endpoints.ts` — `implemented` | Set literal de 18 operationIds; es un hecho sobre *ese* código | Tabla `implementation_flags` por proyecto, editable y/o derivable de un probe |
| 3 | `lib/endpoints.ts` — `bodies` | Payloads con FKs del seed (`product_id: 2, store_id: 4`), EANs libres, `records` vs `items` | `body_templates` por proyecto/operación, con interpolación `{{var}}` |
| 4 | `lib/scenarios.ts` — `values` | Catálogo de valores por parámetro del dominio (`ean_sap`, `zone_id`, `region: "Centro"`) | `parameter_samples` por proyecto |
| 5 | `lib/scenarios.ts` — geo | Coordenadas de Bogotá y el caso "océano" incrustados en el generador | Regla de escenario declarativa: `geo` como *plugin de generación* configurable |
| 6 | `lib/budgets.mjs` | Umbrales del RFP §6 (`/health` < 20 ms, `?ean_sap=` < 50 ms, GET < 70 ms) con `if` por path | `budget_rules` ordenadas: match método + path + query → umbral, etiqueta, fuente |
| 7 | `app/api/run/route.ts` | Envelope `{data}`, `HealthStatus` con `status`/`checks`, `ProblemDetails`, y `GET /openapi.json` como ruta fija | `envelope_profile` por proyecto + `spec_url` explícito por entorno |
| 8 | `components/api-dashboard.tsx` | `DEFAULT_PARAMETERS`, `baseUrl` por defecto `http://127.0.0.1:8100`, tres campos de credencial (`token`, `readToken`, `apiKey`) | `path_defaults`, `Environment.baseUrl`, lista de `Credential` con rol y scopes |
| 9 | `api-dashboard.tsx` — `detailEndpointFor` / `idFrom` / `deleteCreated` | Los flujos `create-read`/`delete-read` **infieren** la operación de detalle por convención REST y el id por `body.data[<último placeholder>]` | Inferencia igual por defecto + `flow_overrides` explícitos cuando la convención no aplica |
| 10 | `package.json` scripts | `cd ../../digital-catalog-back-end && uv run … e2e_env.py` en `test:e2e`, `test:auth`, `dev:e2e` | Los tests del producto usan un target simulado; el arranque del backend ajeno sale del repo |
| 11 | `worker/index.ts`, `next.config.ts`, `vite.config.ts` | Despliegue atado a Cloudflare Workers + vinext beta | SPA estática + API NestJS en contenedor; despliegue agnóstico |

**Lo que no hay que perder.** El valor del dashboard actual no es la UI: es que *un 200 no es un
test que pasa*. Verifica el schema contra el `/openapi.json` vivo, los presupuestos de latencia
con p95 sobre muestras reales, la matriz 401/403 y el D-29 del DELETE con API key, la
persistencia real de los campos escritos, y el orden de ejecución que impide que un DELETE
contagie de rojo al resto. Todo eso debe sobrevivir como comportamiento **por defecto**, no como
una opción que hay que recordar activar.

---

## 2. Arquitectura objetivo

```
endpoint-quality/
├─ apps/
│  ├─ api/                    NestJS 11 + @nestjs/cqrs
│  └─ web/                    Vite + React 19 + Tailwind (SPA, sin SSR)
├─ packages/
│  ├─ runner-core/            Dominio puro, sin framework: generación de escenarios,
│  │                          plan de ejecución, presupuestos, validación JSON Schema
│  ├─ spec-import/            Parser OpenAPI 3.0/3.1 → Operation[] (dereference, $ref, webhooks)
│  └─ contracts/              DTOs + esquemas zod compartidos api ↔ web
├─ docker/                    Dockerfiles + compose (api, web, postgres, redis)
└─ tools/
   └─ migrate-digital-catalog.ts   Volcado único de la config hardcodeada a datos
```

Gestor: **pnpm workspaces** (ya hay `pnpm-workspace.yaml`). Turborepo opcional para cachear
build/test.

**`runner-core` es el corazón del desacople.** Hoy `scenarios.ts`, `execution-plan.ts`,
`budgets.mjs` y `contract.mjs` ya son módulos puros y testeables — esa decisión estaba bien
tomada. El trabajo es parametrizarlos: donde hoy leen constantes del módulo, reciben un objeto
`ProjectConfig`. Ese paquete lo consumen **el backend** (ejecuta las corridas) y **el front**
(previsualiza la cola sin llamar al servidor), y por tanto no puede depender de NestJS ni de React.

---

## 3. Modelo de dominio

### 3.1 Identidad y acceso

- **Organization** — tenant. Todo proyecto pertenece a una.
- **User** — email + password (argon2id). `status`: `active | invited | disabled`.
- **Membership** — `(user, org, role)` con `owner | admin | editor | viewer`.
  - `viewer`: ve proyectos y corridas.
  - `editor`: edita config, lanza corridas de solo-lectura.
  - `admin`: gestiona entornos, credenciales y corridas con escritura.
  - `owner`: además, facturación y borrado de la organización.
- **ApiToken** — token de servicio por organización, para lanzar corridas desde CI.
- **RefreshToken** — rotación con detección de reuso.

### 3.2 Contrato y configuración

- **Project** — `(org, name, slug)`. Unidad de configuración.
- **SpecSource** — de dónde sale el contrato: `url` (con auth opcional), `upload`, `inline`.
- **SpecVersion** — snapshot inmutable: `hash`, documento crudo, `openapi_version`,
  `imported_at`, `operation_count`. Una está `active` por proyecto.
- **Operation** — proyección plana de `SpecVersion`: `operationId`, método, path, tag, summary,
  `statuses[]`, `parameters[]`, `security[]`, refs de schema de request/response.
  *Reemplaza exactamente a `contract-operations.ts`.*
- **Environment** — `(project, name, baseUrl)` + `specUrlOverride`, `variables`, `writesAllowed`.
  Ej.: `local`, `e2e`, `staging`. Un entorno de producción se marca `writesAllowed: false` y el
  motor rechaza toda operación no idempotente.
- **Credential** — por entorno, con `role`: `primary` (el token completo), `insufficient` (scope
  menor, para los 403), `alternate` (la API key, para el D-29), `none` (ausencia deliberada).
  `kind`: `bearer | api_key | basic | oauth2_client_credentials | none`. Secreto cifrado
  AES-256-GCM, **nunca devuelto** en lecturas.
- **ParameterSample** — `parameter_name → valores[]`, con `expectedStatus` opcional por valor
  (así `limit=0` sigue esperando 422 sin un `if` en el generador).
- **PathDefault** — valores por defecto de los placeholders (`{store_id} → 1`).
- **BodyTemplate** — por operación: `body`, `conflictBody`, `patchBody`, con interpolación.
- **BudgetRule** — lista ordenada; primera que casa gana. `{ method, pathGlob, queryMatch,
  thresholdMs, label, source }`. **Sin regla no hay aserción** — se conserva la decisión actual
  de `budgets.mjs`: un tick verde que no afirma nada es peor que ninguno.
- **EnvelopeProfile** — `successPointer` (`/data`), `listPointer`, `errorShape`
  (`problem-details | custom` con campos requeridos), `healthShape`. Se usa **solo como
  fallback**: si el `/openapi.json` declara schema para ese status, manda el schema.
- **FlowOverride** — por operación: `createOperationId`, `readOperationId`,
  `deleteOperationId`, `idPointer` (JSON Pointer al identificador devuelto).
- **ImplementationFlag** — `operationId → implemented`. Editable a mano o poblable con un
  probe que marca como no implementada toda operación que responde 405.

### 3.3 Ejecución

- **RunPlan** — guardable y reutilizable: `orderMode` (`contract | safe | custom`),
  `customOrder`, `endpointIds`, `caseSelection`, `samples`, `delayMs`, `authEnabled`.
- **Run** — `(project, environment, specVersion, plan)` + `status`, `startedAt`, `finishedAt`,
  `totals`, `triggeredBy`.
- **RunCase** — un escenario de una operación: `status`, `ok`, `durationMs`.
- **RunStep** — un request dentro del caso (un `create-read` son 3): `request`, `expected`,
  `actual`, `assertions[]`, `latency`.

Persistir las corridas es capacidad **nueva**: hoy el resultado vive en `useState` y muere al
refrescar. Con historial aparecen tendencia de latencia, regresión de cobertura y diff de drift
entre versiones de contrato — sin trabajo extra, solo por guardar.

---

## 4. Backend — NestJS + CQRS

### 4.1 Estructura por módulo

Cada módulo de dominio usa el mismo esqueleto de cuatro capas:

```
src/modules/<module>/
├─ domain/                aggregates, value objects, puertos (interfaces), errores de dominio
├─ application/
│  ├─ commands/           <Name>Command + <Name>Handler  (@CommandHandler)
│  ├─ queries/            <Name>Query   + <Name>Handler  (@QueryHandler)
│  ├─ events/             <Name>Event   + <Name>Handler  (@EventsHandler)
│  └─ sagas/              @Saga sobre el EventBus
├─ infrastructure/        repositorios TypeORM, adaptadores HTTP, cripto, cola
└─ presentation/          controllers, DTOs (class-validator), mappers de respuesta
```

Módulos: `auth`, `iam`, `projects`, `specs`, `environments`, `config`, `runs`, `execution`,
`reports`, `shared`.

**Reglas de arquitectura que se aplican con lint (`eslint-plugin-boundaries`)**, no solo con
buena voluntad:

1. `domain/` no importa nada de `@nestjs/*` salvo los decoradores de CQRS. Sin TypeORM, sin Axios.
2. Los handlers dependen de **puertos** (`SpecRepositoryPort`, `HttpProbePort`, `ClockPort`,
   `CryptoPort`, `QueuePort`), inyectados por token. La implementación se sustituye en test.
3. Un controller **nunca** contiene lógica: valida el DTO, resuelve el tenant y despacha al bus.
4. Los comandos no devuelven read models: devuelven un id o `void`. Toda lectura va por
   `QueryBus`.
5. Un handler = un archivo = una transacción.

### 4.2 Comandos

| Módulo | Comandos |
|--------|----------|
| `auth` | `RegisterUser`, `LoginUser`, `RefreshSession`, `LogoutUser`, `ChangePassword`, `IssueApiToken`, `RevokeApiToken` |
| `iam` | `CreateOrganization`, `InviteMember`, `AcceptInvitation`, `ChangeMemberRole`, `RemoveMember` |
| `projects` | `CreateProject`, `UpdateProject`, `ArchiveProject`, `CloneProjectConfig` |
| `specs` | `ImportSpecVersion`, `ActivateSpecVersion`, `DeleteSpecVersion`, `CheckSpecDrift` |
| `environments` | `CreateEnvironment`, `UpdateEnvironment`, `UpsertCredential`, `DeleteCredential`, `PingEnvironment` |
| `config` | `UpsertBodyTemplate`, `UpsertParameterSamples`, `UpsertPathDefaults`, `UpsertBudgetRule`, `ReorderBudgetRules`, `UpsertEnvelopeProfile`, `UpsertFlowOverride`, `SetImplementedOperations`, `ProbeImplementedOperations` |
| `runs` | `StartRun`, `CancelRun`, `RecordStepResult`, `FinishRun`, `ReplayRun`, `SaveRunPlan` |
| `execution` | `ExecuteProbe` (un request suelto, el botón "ejecutar este caso") |

### 4.3 Consultas

`ListProjects`, `GetProjectOverview`, `ListSpecVersions`, `GetOperations`,
`GetGeneratedScenarios` (pura, vía `runner-core`), `PreviewExecutionQueue`, `ListEnvironments`,
`GetProjectConfig`, `ListRuns`, `GetRun`, `GetRunCase`, `GetCoverageReport`,
`GetLatencyReport`, `GetDriftReport`.

`GetCoverageReport` es la generalización del cierre del README actual ("de las 192 respuestas
declaradas, 191 tienen caso"): cruza `Operation.statuses[]` con los escenarios generados y
devuelve los huecos. Deja de ser una frase en un README y pasa a ser una métrica calculada.

### 4.4 Eventos y saga de orquestación

```
StartRun ──> RunStarted
                 │
      RunOrchestrationSaga
                 │  encola cada RunCase respetando orderMode y delayMs
                 ▼
           RunCaseStarted ──> (ExecuteProbe × n steps) ──> RunCaseFinished
                 │                                              │
                 │◀──────────── siguiente caso ─────────────────┘
                 ▼
            RunFinished ──> proyecta totals, dispara webhooks, cierra SSE
```

- `RunCaseFinished` alimenta también un `RunProgressProjector` que escribe el read model del
  progreso, y un `RunStreamGateway` que empuja SSE al front.
- El bucle de ejecución **se mueve del navegador al servidor**. Hoy vive en
  `api-dashboard.tsx`: cerrar la pestaña aborta la corrida. En el modelo nuevo el front es un
  observador; una corrida lanzada desde CI y otra desde el navegador son la misma cosa.

### 4.5 Cola

`QueuePort` con dos adaptadores:

- `BullMqQueueAdapter` (Redis) — despliegue web, corridas concurrentes, reintentos, supervivencia
  a reinicios.
- `InMemoryQueueAdapter` — `npm run dev` sin Redis. Es lo que mantiene viva la promesa de
  "ejecutable en local" sin pedir infraestructura.

Selección por `QUEUE_DRIVER=memory|redis`. El resto del código no se entera.

### 4.6 Persistencia

PostgreSQL + TypeORM con migraciones versionadas (nunca `synchronize: true`). Índices que
importan: `runs(project_id, started_at desc)`, `run_cases(run_id, status)`,
`operations(spec_version_id, operation_id)` único.

Retención: `run_steps` es la tabla que crece — guarda cuerpos de respuesta completos. Política
por proyecto (`keepFullBodiesForDays`, por defecto 14); pasado el plazo un job deja el resumen
de aserciones y descarta los cuerpos.

### 4.7 Superficie REST

```
POST   /auth/register|login|refresh|logout        GET  /auth/me
GET    /orgs                                      POST /orgs
GET    /orgs/:id/members                          POST /orgs/:id/invitations
GET    /projects                                  POST /projects
GET    /projects/:id                              PATCH /projects/:id
POST   /projects/:id/spec-versions                GET  /projects/:id/spec-versions
POST   /projects/:id/spec-versions/:v/activate    GET  /projects/:id/operations
POST   /projects/:id/spec-drift-check
GET    /projects/:id/environments                 POST /projects/:id/environments
POST   /environments/:id/credentials              POST /environments/:id/ping
GET    /projects/:id/config                       PUT  /projects/:id/config/:section
GET    /projects/:id/scenarios?environmentId=     GET  /projects/:id/queue-preview
POST   /projects/:id/runs            → 202 { runId }
GET    /runs/:id                     GET /runs/:id/stream (SSE)   POST /runs/:id/cancel
GET    /projects/:id/reports/coverage|latency|drift
POST   /probe                        (request suelto, sin persistir)
```

Versionado por URI (`/v1`), OpenAPI propio publicado con `@nestjs/swagger` — el producto que
verifica contratos debe publicar el suyo.

### 4.8 Seguridad

- **SSRF es el riesgo nuevo y serio.** Hoy el fetch sale de un Worker con un `baseUrl` que
  escribe el propio usuario en su máquina. En un backend alojado, `baseUrl` arbitrario significa
  que el servidor alcanza `169.254.169.254`, `10.0.0.0/8` y `localhost` del contenedor.
  Mitigación obligatoria: resolver DNS y validar la **IP resuelta** contra una denylist de
  rangos privados/link-local (configurable por despliegue, permisiva en self-hosted vía
  `ALLOW_PRIVATE_TARGETS=true`), cap de redirecciones a 3 revalidando cada salto, timeout duro,
  y límite de tamaño de respuesta.
- Secretos cifrados con AES-256-GCM, clave desde `SECRETS_KEY` (KMS en despliegue gestionado).
  Campos write-only: la API devuelve `••••` y un `lastFour`.
- Enmascarado de credenciales en `RunStep.request.headers` — ya existe en `route.ts:66` y hay
  que conservarlo, extendido a cualquier header marcado como secreto.
- `writesAllowed: false` en un entorno bloquea POST/PUT/PATCH/DELETE en el motor, no en la UI.
- Rate limit (`@nestjs/throttler`) en `/auth/*` y en `POST /projects/:id/runs`.
- Cabeceras con Helmet, CORS por lista de orígenes.

---

## 5. Frontend

**Vite + React 19 + Tailwind 4 + shadcn/ui**, SPA pura. Se abandona vinext/Cloudflare Worker: el
único motivo para tener servidor en el front era `app/api/run/route.ts`, y eso ahora es el
backend. Una SPA se sirve desde cualquier CDN, un nginx o el propio contenedor de la API.

Rutas:

| Ruta | Contenido |
|------|-----------|
| `/login`, `/register`, `/accept-invite` | Autenticación |
| `/` | Lista de proyectos de la organización |
| `/p/:slug` | **El dashboard actual**, ahora alimentado por API: lista de operaciones, filtros por tag, panel de detalle con pestañas request/expected/actual, monitor de ejecución, orden de ejecución |
| `/p/:slug/environments` | Entornos y credenciales |
| `/p/:slug/contract` | Versiones de spec, importación, diff de drift |
| `/p/:slug/config` | Bodies, samples, presupuestos, envelope, flujos, implementadas |
| `/p/:slug/runs` · `/runs/:id` | Historial y detalle de corrida con sus steps |
| `/settings/org` | Miembros, roles, tokens de CI |

Estado de servidor con **TanStack Query**; el progreso en vivo llega por SSE desde
`GET /runs/:id/stream` y actualiza la caché. Se conservan tal cual los componentes de UI que ya
funcionan (`ExecutionMonitor`, `ExecutionOrder`, `JsonBlock`, las tarjetas de aserción): cambian
sus fuentes de datos, no su diseño.

Los textos pasan por i18n (`es` por defecto, `en` incluido). Hoy las descripciones de escenario
están en español dentro de `scenarios.ts` — en un producto multi-proyecto eso es una cadena de
recurso, no una constante de código.

---

## 6. Estrategia de pruebas del backend

Cinco niveles, de más rápido a más lento.

**1. Unitarias puras (`packages/runner-core`)** — sin NestJS, sin red. Es donde vive la lógica
que de verdad puede equivocarse:
- generación de escenarios: dado un `Operation` + `ProjectConfig`, la lista exacta de casos;
- `percentile` nearest-rank, `latencyAssertion` con 1 muestra vs 30;
- `orderEndpoints` en los tres modos, `moveEndpoint` en los bordes;
- `dereference` con `$ref` recursivos, `validateJson` con cada palabra clave soportada.

**2. Handlers de comando/consulta** — repositorios en memoria, `ClockPort` fijo, `HttpProbePort`
simulado. Se afirma el evento publicado, no el estado interno: `StartRunHandler` debe publicar
`RunStarted` con la cola construida, y nada más.

**3. Integración con base de datos** — Testcontainers levanta PostgreSQL real. Se prueban las
migraciones, el aislamiento por tenant (un usuario de la org A **no** puede leer un run de la
org B — un test por endpoint, generado en tabla) y los índices.

**4. E2E de API** — `supertest` contra la app completa, con Postgres y Redis en Testcontainers,
y un **target simulado**: un servidor Fastify generado desde una spec de fixture que puede
responder correctamente, romper el envelope, tardar de más o devolver 405 a voluntad. Escenarios:
- flujo completo `register → create project → import spec → create environment → start run →
  stream SSE → assert totals`;
- un target que responde 200 con envelope roto ⇒ el caso falla y la aserción que falla es la del
  schema, no otra;
- un target lento ⇒ falla el presupuesto y solo el presupuesto;
- un target 405 ⇒ `notImplemented`, sin ruido de envelope (conserva la decisión de
  `route.ts:52`);
- entorno con `writesAllowed: false` ⇒ el DELETE se rechaza antes de salir a la red;
- `baseUrl` apuntando a `169.254.169.254` ⇒ rechazo con 422 y sin request emitido.

**5. Prueba de paridad (la que autoriza el corte)** — un test que carga
`digital-catalog-back-end/docs/openapi/bundled.yaml` y la configuración migrada, genera la matriz
y la compara contra un **golden file** extraído del generador actual: mismos `operationId`, mismos
ids de escenario, mismos `expectedStatus`, mismo orden en modo `safe`. Diferencia = fallo. Es el
único test que demuestra que el desacople no perdió nada.

Complementos: cobertura mínima 85 % en `runner-core` y en `application/`, mutation testing
(Stryker) solo sobre `runner-core`, y `k6` sobre `POST /runs` para el límite de concurrencia.

---

## 7. Fases de entrega

Cada fase termina en algo ejecutable y con su criterio de aceptación.

| Fase | Alcance | Aceptación | Est. |
|------|---------|-----------|------|
| **P0 — Extracción** | Monorepo pnpm; mover `scenarios`/`execution-plan`/`budgets`/`contract` a `packages/runner-core` parametrizados por `ProjectConfig`; el dashboard actual sigue funcionando pasándole su config como literal | `npm test` actual sigue en verde sin tocar la API destino; golden file de la matriz generado y congelado | 2–3 d |
| **P1 — Cimientos API** | NestJS + CQRS + TypeORM + migraciones; `auth` e `iam` completos; Docker Compose con Postgres | Registro, login, refresh con rotación, RBAC probado por endpoint; suite de integración con Testcontainers en verde | 3–4 d |
| **P2 — Contrato como dato** | `projects`, `specs` con `spec-import`; importación por URL y por upload; drift check | Importar `bundled.yaml` produce las 46 operaciones idénticas a `contract-operations.ts`; test de paridad estructural en verde | 4–5 d |
| **P3 — Entornos y config** | `environments`, `credentials` cifradas, y las seis secciones de `config`; `tools/migrate-digital-catalog.ts` | La configuración hardcodeada existe como filas; `GET /projects/:id/scenarios` devuelve la matriz completa | 3–4 d |
| **P4 — Motor de ejecución** | `runs`, `execution`, saga, cola (memoria + BullMQ), SSE, persistencia de steps, guardas SSRF y `writesAllowed` | Corrida completa contra el target simulado; los 6 escenarios E2E del §6.4 en verde; una corrida sobrevive al cierre del navegador | 4–5 d |
| **P5 — Front nuevo** | SPA Vite; login; selector de proyecto; el dashboard reconectado; entornos, config, historial | Paridad visual y funcional con la UI actual; corrida en vivo por SSE; sin ninguna constante de dominio en el bundle | 5–6 d |
| **P6 — Corte de paridad** | Correr el proyecto Digital Catalog migrado contra el backend E2E real | Mismos veredictos que `npm run test:e2e` y `npm run test:auth` actuales, caso por caso; informe de cobertura reproduce el conteo del README | 2–3 d |
| **P7 — Empaquetado** | Compose de un comando, imágenes publicadas, tokens de CI, `README` de despliegue, OpenAPI propio | `docker compose up` levanta todo y un proyecto de ejemplo corre solo; una corrida se lanza desde CI con token y devuelve exit code | 2 d |

**Total: 25–32 días de una persona** (~5–6 semanas). P2/P3 y P5 se paralelizan si hay dos.

---

## 8. Decisiones que conviene fijar antes de empezar

1. **El generador Python muere.** `scripts/gen_dashboard_endpoints.py` y `make dashboard-check`
   dejan de tener sentido: el contrato se importa en runtime y el drift lo detecta el producto.
   Se conservan durante P0–P6 como oráculo del test de paridad, y se retiran en P7.
2. **La spec se importa, no se enlaza.** Cada `SpecVersion` es un snapshot con hash. Un contrato
   que cambia bajo los pies durante una corrida es exactamente el fallo que la herramienta
   existe para detectar; no puede ser también su modo de operación.
3. **El envelope se deriva del schema siempre que se pueda.** `EnvelopeProfile` es fallback para
   specs incompletas, no la vía principal. Si no, se pierde la mejor aserción que hay hoy.
4. **Sin presupuesto no hay aserción.** Se conserva literal la decisión de `budgets.mjs`.
5. **Escrituras contra producción bloqueadas por defecto.** `writesAllowed` es opt-in explícito
   por entorno, con confirmación en la UI.
6. **Multi-tenant desde la primera migración.** Añadir `org_id` después es una migración de datos
   con riesgo de fuga entre clientes; ponerlo desde el principio es una columna.

## 9. Riesgos

| Riesgo | Impacto | Mitigación |
|--------|---------|-----------|
| La generalización pierde aserciones específicas (geo, D-29, cursor corrupto) | Alto — el producto queda peor que el original | Test de paridad de P0 como *gate* obligatorio de P6; los generadores especiales se conservan como plugins configurables |
| SSRF desde el backend alojado | Alto — acceso a red interna | Validación de IP resuelta, denylist de rangos, cap de redirecciones; auditoría de seguridad antes de exponer |
| Crecimiento de `run_steps` | Medio — coste y lentitud | Retención por proyecto y compresión de cuerpos desde P4, no después |
| SSE detrás de proxies corporativos | Medio — el progreso no llega | Fallback a polling de `GET /runs/:id` cada 2 s, detectado por el cliente |
| Alcance del front crece (editor visual de config) | Medio — retraso | P5 entrega editores JSON con validación por schema; el editor visual es post-lanzamiento |
| vinext beta abandonado a mitad de camino | Bajo | El corte a SPA ocurre entero en P5, no de forma incremental |
