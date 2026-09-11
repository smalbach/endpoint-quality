# El editor de peticiones — qué falta del analizador, y en qué orden

Revisión de `security-analyzer` y `security-analyzer-front` con una pregunta concreta: qué tiene
aquel editor de endpoints —que funciona muy parecido a Postman— que aquí no hay, y qué de lo demás
merece traerse.

La conclusión que ordena el resto: **el contrato sigue siendo la fuente de los endpoints.** Allá un
endpoint es una fila que alguien crea, archiva, ordena e importa de un escaneo de GitHub. Aquí sale
del contrato importado, y eso es justo lo que hace que la deriva se detecte: poder inventarse uno a
mano rompería la propiedad que sostiene el producto. Lo que sí faltaba era poder decir cosas _sobre_
uno, y ensayarlo antes de lanzar nada.

---

## Lo que había allá y aquí no

### 1. El editor tipo Postman

Panel de petición con pestañas **Params · Headers · Body · Auth · Scripts · Access Control ·
Security Rules**, panel de respuesta **Body · Headers · Console**, y un botón que envía contra
`POST /endpoints/:id/test`.

| #   | Pieza                                                      | Estado al empezar                             | Tanda |
| --- | ---------------------------------------------------------- | --------------------------------------------- | ----- |
| 1   | Enviar una petición suelta y ver la respuesta              | no existía                                    | 1 ✔   |
| 2   | Panel de respuesta (estado, ms, tamaño, cabeceras, cuerpo) | no existía                                    | 1 ✔   |
| 3   | Cabeceras propias por plantilla                            | `parameters` son solo parámetros del contrato | 2     |
| 4   | Cuerpo no-JSON (form-data, urlencoded, raw, binary)        | `body` es `Record<string, unknown> \| null`   | 2     |
| 5   | Fila con interruptor (`enabled`)                           | para quitar un parámetro hay que borrarlo     | 2     |
| 6   | Autocompletado al escribir `{{`                            | el motor interpola, el editor no ayuda        | 2     |
| 7   | Exportar como cURL                                         | no existía                                    | 3     |
| 8   | Importar cURL / Postman / Insomnia / markdown              | solo entra OpenAPI 3.x                        | 3     |

### 2. Permisos por rol y por endpoint

`RoleEndpointPermission { roleId, endpointId, hasAccess, dataScope: all|own|none }` y
`CrossRoleDataRule { sourceRole, targetRole, endpoint, canRead/canWrite/canDelete }`. De ahí salen
sus casos BOLA/IDOR.

Aquí hay credenciales por rol en el entorno y un `credential: "none" | "insufficient" | "api-key"`
**global**. No se puede decir «el rol _vendedor_ no debe poder leer `getPedido` de otro». Es la
única función de seguridad del analizador que encaja con lo que este producto es. → tanda 4.

### 3. Importar de otro proyecto

`GET import/available-projects`, `.../endpoints|flows|environments`, `POST from-project`. Copiar
configuración y flujos a un proyecto nuevo. → tanda 5.

### 4. Informes

Allá JSON, HTML (handlebars) y PDF (puppeteer). Aquí solo JSON en `GET :runId/report`. Falta HTML y
**JUnit XML**, que es lo que hace que un CI enseñe los casos rojos. PDF no: puppeteer por un botón
de imprimir no sale a cuenta. → tanda 3.

---

## Lo que no se trae, y por qué

- **La fila de endpoint editable a mano.** Rompería que el contrato sea la fuente. Lo que hacía
  falta —decir algo sobre una operación— ya está en `operationParameters`.
- **`preRequestScript` / `postResponseScript` sobre `node:vm`.** `vm` no es una frontera de
  seguridad, y el runner corre en el servidor con los secretos del proyecto en memoria. La
  alternativa sana son valores computados declarativos: `{{$uuid}}`, `{{$now}}`, `{{$randomInt}}`,
  `{{$base64:x}}`, `{{$hmacSha256:clave:texto}}`. Cubre casi todo lo que la gente escribe en esos
  scripts sin ejecutar código ajeno. → tanda 5.
- **Pruebas de carga** (`perf-plans`, `loadProfile`, `thresholds`, ventanas de métricas), **escáner
  de GitHub** y **análisis con IA**. Otro producto.
- **Entornos**: ya estaban, y mejor —`initial`/`current`/`sensitive`, `disabledVariables` como mapa
  aparte, la máscara que significa «sin cambio», credenciales por rol.
- **Grupos de flujos**: ya cubiertos por las suites y `RunSource.kind: "suite"`.

---

## Las tandas

### Tanda 1 — Enviar ahora · **cerrada** (`cef90ad`)

`POST /orgs/:o/projects/:p/request-preview`. Manda lo que hay en el formulario, guardado o no, y
contesta en la misma llamada con lo que respondió el destino y con las comprobaciones que una
corrida habría hecho.

Lo que la hace fiable es que va por el mismo `CaseExecutor`: mismas credenciales, mismo
`writesAllowed`, mismo contrato en vivo. Lo que la hace soportable es que **no encola, no escribe
fila, no mueve totales** —se ensaya mucho, y un historial lleno de ensayos no lo lee nadie—.

Para que las dos rutas se preparen igual, `RunOrchestrator.prepare` salió a
`ExecutionContextFactory` (`apps/api/src/modules/runs/infrastructure/execution-context.ts`) y el
mapeo de plantilla a escenario se fue a `scenarioFor` en
`apps/api/src/modules/workflows/domain/model.ts`.

### Tanda 2 — El formulario

Cabeceras propias, `enabled` por fila, tipos de cuerpo. `RequestTemplateView.body` pasa de
`Record<string, unknown> | null` a algo como `{ type, content }` — **con migración**, porque hay
plantillas guardadas. Autocompletado al escribir `{{`, alimentado de las variables del entorno
seleccionado.

### Tanda 3 — Entrar y salir

Importar cURL (uno suelto o un markdown lleno), colección Postman v2.1, Insomnia. Salen plantillas,
no operaciones: el contrato sigue mandando. Exportar cURL desde el panel de respuesta. Informe HTML
y JUnit XML como `?format=` de `GET :runId/report`.

### Tanda 4 — Permisos por operación

Sección de configuración nueva, `access`: por operación, qué roles deben pasar y cuáles deben
recibir 403, más las reglas entre roles. La matriz genera un caso por celda. Es la más grande y la
única con diseño que discutir antes de escribir.

### Tanda 5 — Varios

Copiar configuración y flujos entre proyectos. Etiquetas propias sobre operaciones. Valores
computados `{{$uuid}}` y compañía.
