# Registro de fases

Una entrada por fase cerrada de `decoupling-plan.md`, con la evidencia que la cierra.

---

## P0 — Extracción · cerrada

**Alcance**: monorepo pnpm; `packages/runner-core` con la generación de escenarios, el plan de
ejecución, los presupuestos y la validación JSON Schema parametrizados por `ProjectConfig`; el
golden de la matriz actual congelado.

**Evidencia**

    packages/runner-core $ node --experimental-strip-types --test test/*.test.ts
    ℹ tests 43   ℹ pass 43   ℹ fail 0

- `test/golden/matrix.json` — generado por `test/golden/generate.ts` desde los módulos del
  dashboard acoplado, sin tocarlos: **46 operaciones, 196 respuestas declaradas, 311 casos**
  (214 sin los de autorización), las cuatro colas y los dos modos de orden.
- `test/parity.test.ts` — el motor generalizado, alimentado con Digital Catalog *como datos*,
  reproduce ese fichero campo por campo: cada caso, cada descripción, cada status esperado, cada
  path resuelto, cada presupuesto y el orden exacto de cada cola.
- `test/scenarios.test.ts` — el mismo motor sobre un proyecto que no es Digital Catalog (una API
  de blog, con otros nombres de parámetro, otro envelope, otros scopes y sin presupuestos). Es la
  mitad que demuestra que la configuración es configuración y no las constantes con otro nombre.

**Lo que el test de paridad encontró**: `bulkUpsertProducts` tiene su propio envelope
(`ProductBulkResult`), declarado en el legacy *antes* de la regla genérica del prefijo `bulk`.
La primera versión de la configuración lo perdía. Es exactamente el tipo de detalle que una
revisión a ojo no ve y por el que la fase existe.

**Criterios de aceptación**

| Criterio | Estado |
|----------|--------|
| Golden generado y congelado desde el código acoplado | ✅ `test/golden/matrix.json` |
| El motor parametrizado reproduce la matriz sin pérdidas | ✅ 5 tests de paridad |
| El dashboard acoplado sigue intacto | ✅ solo se le añadió `docs/`; `lib/` sin tocar |
| Tipado estricto limpio | ✅ `tsc --noEmit` sin errores |

**Deuda que P0 deja anotada**

- El legacy vive copiado en `test/legacy/` para producir el golden. Se borra en P7, junto con
  `scripts/gen_dashboard_endpoints.py` del repo backend.
- El golden se regenera a mano. Cuando llegue P2 y la spec se importe en runtime, el generador
  debe leer `bundled.yaml` en vez del `contract-operations.ts` congelado.
- `packages/spec-import` y `packages/contracts` están creados y vacíos: son P2.

---

## P1 — Cimientos de la API · cerrada

**Alcance**: `apps/api` con NestJS 11 + CQRS + TypeORM y migraciones versionadas; los módulos
`auth` e `iam` completos; Docker Compose con Postgres.

**Evidencia**

    apps/api $ pnpm test
    ℹ tests 69   ℹ pass 69   ℹ fail 0

    apps/api $ pnpm build
    tsc -p tsconfig.json && tsc-alias -p tsconfig.json   # sin errores

Reparto: 30 unitarias de dominio y criptografía, 17 de sesión sobre HTTP, 22 de RBAC, más
10 contra Postgres real (abajo).

**La base de datos, contra Postgres real.** Los 10 tests de `test/db/` quedaron pendientes en
primera instancia porque el demonio de Docker estaba parado. Se ejecutaron después contra el
PostgreSQL 17 local, en una base aislada (`endpoint_quality_test`), sin tocar las del backend
Digital Catalog:

    EQ_TEST_DATABASE_URL=postgres://smalbach@127.0.0.1:5432/endpoint_quality_test pnpm --filter @eq/api test:db
    ℹ tests 10   ℹ pass 10   ℹ fail 0

Cubren migraciones aplicadas **y revertidas** desde vacío, unicidad de correo y de slug, claves
foráneas, borrado en cascada y los índices que sostienen cada comprobación de autorización.
Cuando no hay base alcanzable se saltan imprimiendo el motivo, nunca en silencio:

    ﹣ migraciones # sin EQ_TEST_DATABASE_URL: levanta Postgres y reexporta la variable

**Decisiones que conviene conocer**

- **La rotación de refresh tokens guarda los gastados en vez de borrarlos.** Rotar por sí solo
  no detiene un token robado: el ladrón refresca y sigue. El robo solo se manifiesta cuando el
  usuario legítimo presenta el token ya gastado, y eso solo es detectable si la fila sigue ahí.
  Al detectarlo se revoca **la sesión entera**, no ese token: no hay forma de saber cuál de las
  dos partes está preguntando, y dejar viva la cadena deja dentro a la equivocada.
- **Los roles no viajan en el JWT.** Se resuelven contra la base en cada petición. Meterlos en el
  token ahorra una consulta y cuesta que una membresía revocada siga funcionando quince minutos.
- **El guard de autenticación es global y las rutas se excluyen con `@Public()`.** Al revés, un
  controlador nuevo nace desprotegido y el fallo es silencioso.
- **Un token de servicio actúa como `editor` y solo en su organización.** No gestiona miembros ni
  credenciales: un secreto de CI filtrado no puede convertirse en un robo de cuenta.
- **scrypt y no argon2id.** El puerto permite cambiarlo. argon2 es dependencia nativa, y en un
  producto self-hosted un `pnpm install` que falla al compilar un binario tiene peor resultado de
  seguridad que un KDF memory-hard de la biblioteca estándar. Parámetros: el mínimo de OWASP.
- **Todo error sale como Problem Details.** El producto que verifica que otras APIs los emiten no
  puede responder `{"statusCode":500}`.

**Deuda que P1 deja anotada**

- `apps/api` es CommonJS y `packages/runner-core` es ESM puro. P4 es la primera fase que necesita
  importar uno desde el otro; hay que resolverlo entonces (doble emisión en `runner-core`, o
  pasar la API a ESM).
- La invitación devuelve el token en la respuesta porque no hay envío de correo. Sirve para la
  API y para CI; antes de exponerlo a usuarios finales hace falta el envío real.
- `SECRETS_KEY` y `AesGcmSecretCipher` existen y están probados, pero nada los usa todavía: son
  para las credenciales de destino de P3.
