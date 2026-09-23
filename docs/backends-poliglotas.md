# Backends políglotas — un front, tres implementaciones

El producto tiene una API en NestJS con **221 rutas** repartidas en 19 módulos. Este documento
describe cómo esa API deja de ser _la_ API y pasa a ser _una_ implementación de un contrato que
otras dos —FastAPI y Go— cumplen, y cómo el front elige con cuál habla **antes de conectarse**.

El objetivo declarado es la paridad total. La forma de llegar es por módulos, con una prueba
ejecutable que dice en cada momento cuánto falta.

---

## 1. Por qué no es un ejercicio de estilo

Reescribir un backend en otro lenguaje es una demo. Tener **tres backends intercambiables en
caliente contra los mismos datos** es otra cosa: obliga a que el contrato esté escrito en algún
sitio que no sea el código de uno de ellos, y castiga cada detalle que se dio por supuesto.

Tres cosas que esto saca a la luz y que un backend solo nunca enseña:

- **Dónde estaba el contrato de verdad.** Un `422` con `errors[].field` no es un detalle del
  `ValidationPipe` de Nest: es parte de lo que el front espera. Si FastAPI contesta el `422` de
  Pydantic con su `detail[]`, el front se rompe aunque el código de estado coincida.
- **Qué tenía de accidental el esquema.** TypeORM escribe columnas en `camelCase` entrecomilladas.
  Un backend que asuma `snake_case` no falla al compilar: falla en la primera consulta.
- **Qué es realmente una sesión.** El token de acceso es un JWT HS256 y el de refresco un opaco
  con SHA-256 en base de datos. Si los tres firman con el mismo secreto y leen la misma tabla,
  **una sesión abierta en Nest sigue viva en Go**. Eso no se puede fingir: o el formato es el
  mismo hasta el último byte, o no entra.

## 2. La arquitectura

```
                    ┌──────────────────────────────────────┐
                    │  apps/web  (React + Vite)            │
                    │  selector de backend, persistido     │
                    └───────┬──────────┬──────────┬────────┘
                       /api │   /api-py│   /api-go│
                    ┌───────▼───┐ ┌────▼─────┐ ┌──▼────────┐
                    │ apps/api  │ │apps/api-py│ │apps/api-go│
                    │ NestJS 11 │ │ FastAPI   │ │ net/http  │
                    │ :3001     │ │ :3002     │ │ :3003     │
                    └───────┬───┘ └────┬──────┘ └──┬────────┘
                            └──────────┼───────────┘
                                ┌──────▼──────┐
                                │  PostgreSQL │   un esquema, unas migraciones
                                └─────────────┘
```

**Una sola base de datos y un solo esquema.** No es una comodidad: es la condición que hace que
cambiar de backend sea transparente. Si cada implementación tuviera su base, cambiar de backend
sería cambiar de producto, y el selector enseñaría tres listas de proyectos distintas.

**Las migraciones son de `apps/api`.** Un solo dueño del DDL, y los otros dos no emiten `CREATE`
ni `ALTER` jamás. Tres procesos aplicando migraciones sobre la misma base es una carrera con
final impredecible; además, TypeORM ya tiene el historial y partirlo en tres no aporta nada.

**Los tres secretos son los mismos** (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `SECRETS_KEY`).
De ahí sale la propiedad más vistosa del conjunto: entras por el backend de Node, cambias a Go
sin recargar, y sigues dentro.

## 3. El contrato que los tres cumplen

Lo que una implementación tiene que reproducir, por orden de lo que rompe antes:

| Pieza                    | Qué exige                                                                                                                                                          | Dónde está en el original                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| **Problem Details**      | RFC 9457 en **todos** los errores, `application/problem+json`, `type` = `https://endpoint-quality.dev/problems/<code\|kind>`, títulos en español, `errors[].field` | `shared/errors/problem-details.filter.ts`         |
| **Códigos**              | `not-found`→404, `conflict`→409, `invalid`→**422**, `unauthenticated`→401, `forbidden`→403, `rate-limited`→429                                                     | el mismo fichero                                  |
| **Contraseñas**          | scrypt N=2^17 r=8 p=1, 32 bytes, digest `scrypt$N$r$p$salt_b64$hash_b64`, entrada normalizada NFKC                                                                 | `shared/crypto/password-hasher.ts`                |
| **Tokens opacos**        | 32 bytes aleatorios en base64url; se guarda `sha256(token)` en **base64**                                                                                          | `shared/crypto/opaque-token.ts`                   |
| **Acceso**               | JWT HS256, claims `{sub, email}`, TTL de `ACCESS_TOKEN_TTL`                                                                                                        | `auth/infrastructure/jwt-access-token.service.ts` |
| **Refresco**             | cookie `eq_refresh`, httpOnly, `SameSite=Strict`, `path=/`, `secure` en producción; **también** en el cuerpo                                                       | `auth/presentation/auth.controller.ts`            |
| **Rotación**             | un refresco gastado que vuelve a presentarse revoca la sesión entera (`usedAt`, `sessionId`)                                                                       | `auth/domain/model.ts`                            |
| **Bloqueo**              | 5 intentos fallidos → 15 minutos, y el bloqueo contesta lo mismo que una contraseña mala                                                                           | `auth/application/commands/login-user.ts`         |
| **Autorización**         | rol resuelto **contra la base en cada petición**, nunca desde el JWT; escalera `viewer<editor<admin<owner`                                                         | `auth/infrastructure/guards/auth.guard.ts`        |
| **Token de servicio**    | prefijo `eqt_`, atado a una organización, techo de `editor`                                                                                                        | el mismo fichero                                  |
| **Secretos del destino** | AES-256-GCM, formato `v1.iv_b64.tag_b64.ct_b64`                                                                                                                    | `shared/crypto/secret-cipher.ts`                  |
| **Traza**                | `X-Trace-Id` en **toda** respuesta y `traceId` como última clave del cuerpo de un error; se acepta el que traiga el cliente si casa `^[A-Za-z0-9_-]{8,64}$`        | `shared/logging/trace-context.ts`                 |
| **Columnas**             | identificadores en `camelCase`, entrecomillados en SQL                                                                                                             | migraciones                                       |

### El descriptor: `GET /backend`

Ruta pública que **toda** implementación sirve. Es lo que hace que el front pueda adaptarse en vez
de adivinar:

```json
{
  "id": "python",
  "name": "FastAPI",
  "runtime": "python 3.11 · fastapi · asyncpg",
  "version": "0.1.0",
  "reference": false,
  "modules": { "auth": "full", "iam": "full", "projects": "full", "runs": "none" }
}
```

`full`, `partial` o `none` por módulo. El front lo lee al elegir backend y marca en la interfaz lo
que ese backend todavía no cubre, con su motivo. Nada revienta por sorpresa: una sección que el
backend elegido no implementa se ve apagada, no se ve rota.

`GET /health` sigue igual que siempre en los tres, byte por byte, porque es la sonda que el
producto se aplica a sí mismo.

### Lo que enseñó la primera vez que la referencia se movió

Mientras esto se escribía, la rama principal añadió registro de operaciones con contexto de traza.
Parecía interno —un `Logger` cambiado por un puerto propio— y no lo era: metió `traceId` en el
cuerpo de todo error y `X-Trace-Id` en toda respuesta. Al fusionar, el guion cantó **46
divergencias** de golpe.

Dos cosas que vale la pena no olvidar:

- **Leer el diff no bastó.** Se miró el filtro de errores y se concluyó que solo cambiaba de dónde
  sale la traza. El campo nuevo se asigna cuatro líneas más abajo, fuera del objeto literal, y se
  pasó por alto. Lo que no se pasó por alto fue correr el guion antes de empujar.
- **La cabecera se escapó al cuerpo.** El 500 de FastAPI salía con `traceId` dentro y sin
  `X-Trace-Id` fuera, porque el manejador de lo inesperado lo instala Starlette por encima de
  todos los middlewares. El guion solo lo vio cuando pasó a exigir la cabecera en **todas** las
  respuestas, no solo en las que fallan — que es la comprobación que faltaba.

## 4. La prueba de paridad

`tools/conformance/` es un ejecutable sin dependencias que corre **el mismo guion de HTTP** contra
cualquier URL base y dice qué cumple y qué no:

```bash
node tools/conformance/run.mjs --backend all
```

No es un test de cada backend: es _la definición operativa_ de la paridad. Un módulo está portado
cuando su bloque pasa en los tres, y no cuando alguien lo declara. Cada caso afirma código de
estado, forma del cuerpo y, donde importa, la cabecera `Set-Cookie` y el `content-type`.

Esto es lo que convierte «paridad total» de una intención en un número que se puede enseñar.

## 5. Estado y hoja de ruta

Orden elegido por dependencia: sin sesión no hay nada, sin organización no hay proyecto, sin
proyecto no hay contrato.

| Fase | Módulos                                                                | Rutas | Node | Python | Go  |
| ---- | ---------------------------------------------------------------------- | ----: | :--: | :----: | :-: |
| 0    | health, backend                                                        |     2 |  ✅  |   ✅   | ✅  |
| 1    | auth                                                                   |     9 |  ✅  |   ✅   | ✅  |
| 2    | iam (organizaciones, miembros, invitaciones, tokens)                   |     9 |  ✅  |   ✅   | ✅  |
| 3    | projects (núcleo CRUD)                                                 |     6 |  ✅  |   ✅   | ✅  |
| 4    | environments, config                                                   |   ~20 |  ✅  |   ⏳   | ⏳  |
| 5    | endpoints, specs, collections                                          |   ~40 |  ✅  |   ⏳   | ⏳  |
| 6    | runs + motor (`@eq/runner-core`) y SSE                                 |   ~35 |  ✅  |   ⏳   | ⏳  |
| 7    | workflows, security-runs, performance                                  |   ~50 |  ✅  |   ⏳   | ⏳  |
| 8    | mocks, docs, monitors, channels, captures, roles, code-scan, dashboard |   ~50 |  ✅  |   ⏳   | ⏳  |

La fase 6 es la frontera real: `@eq/runner-core` son ~25.000 líneas de plan de ejecución,
aserciones, resolución de variables y envelopes. Portarlo es rehacer el juicio del producto, no su
fontanería, y es donde una paridad mal hecha se nota en un veredicto distinto en vez de en un 500.
Cuando llegue, el guion de conformidad tendrá que comparar **veredictos**, no solo respuestas.

## 6. Cómo se añade un módulo

Mismo procedimiento en los dos lenguajes nuevos:

1. Leer el controlador de Nest y anotar rutas, roles (`@RequireRole`) y códigos (`@HttpCode`).
2. Leer los handlers para la **forma exacta** de la respuesta y los `code` de los errores de
   dominio (`project-not-found`, `email-taken`, …): el front ramifica sobre ellos.
3. Escribir el repositorio en SQL directo contra las columnas entrecomilladas.
4. Escribir las rutas, reutilizando las dependencias de identidad y rol ya hechas.
5. Añadir el bloque al guion de conformidad y correrlo contra los tres.
6. Subir el módulo a `full` en el descriptor. **Ese es el último paso, no el primero**: el
   descriptor no es una promesa, es un resumen de lo que ya pasa la prueba.

## 7. Decisiones que se tomaron y por qué

**SQL directo en vez de un ORM en los dos nuevos.** El esquema no es de ellos y no pueden
cambiarlo. Un ORM con sus propias entidades duplicaría la definición de 40 tablas para no poder
migrar ninguna, y la primera divergencia entre su modelo y el real sería silenciosa.

**Una función por ruta en Go, sin framework.** `net/http` con el enrutado por patrones de Go 1.22
cubre lo que hace falta. Meter un framework sería añadir una dependencia para ahorrar treinta
líneas y perder la propiedad más útil de esta implementación: que se lee entera.

**El selector vive en el front, no en un proxy.** Un balanceador que reparta entre los tres sería
transparente y **no demostraría nada**: quien mira la pantalla no sabría con cuál está hablando.
Aquí se elige a mano, antes de entrar, y la cabecera dice en todo momento quién contesta.
