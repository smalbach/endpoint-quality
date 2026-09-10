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
