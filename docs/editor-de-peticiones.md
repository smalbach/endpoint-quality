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
| 3   | Cabeceras propias por plantilla                            | `parameters` son solo parámetros del contrato | 2 ✔   |
| 4   | Cuerpo no-JSON (form-data, urlencoded, raw)                | `body` es `Record<string, unknown> \| null`   | 2 ✔   |
| 5   | Fila con interruptor (`enabled`)                           | para quitar un parámetro hay que borrarlo     | 2 ✔   |
| 6   | Autocompletado al escribir `{{`                            | el motor interpola, el editor no ayuda        | 2 ✔   |
| 7   | Exportar como cURL                                         | no existía                                    | 3 ✔   |
| 8   | Importar cURL / Postman / Insomnia / markdown              | solo entra OpenAPI 3.x                        | 3 ✔   |

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

### Tanda 2 — El formulario · **cerrada** (`ef97235`, `abba9dd`, `cfadc65`)

Cabeceras propias, `enabled` por fila, tipos de cuerpo, autocompletado al escribir `{{`.

Tres decisiones que conviene no volver a discutir:

- **Lo apagado va en un segundo mapa al lado del primero**, nunca como una marca dentro:
  `disabledParameters`, `disabledHeaders`, `disabledFields`. Es la forma que ya tenían las
  `disabledVariables` de un entorno y vale por lo mismo — `parameters` y `headers` siguen
  significando lo que se envía, en todas partes, así que `scenarioFor` no filtra nada y **el motor
  no aprende el concepto**.
- **`body` es una unión etiquetada** —`none` / `json` / `raw` / `form-data` /
  `x-www-form-urlencoded`— y no cinco campos opcionales. En el escenario del motor el JSON sigue
  siendo `body`, porque es lo que la comprobación de persistencia compara campo a campo, y lo demás
  entra por `payload`; quién es cuál lo decide `scenarioFor`, y solo `scenarioFor`. El golden de
  paridad no se toca.
- **Serializar es lo último**, ya en el ejecutor: un `{{nombre}}` codificado antes de sustituirse
  mete un espacio sin escapar en un formulario y el destino lee dos campos donde se escribió uno.

Quedan dos migraciones: `1700000011000` (las tres columnas nuevas) y `1700000012000` (`body` a
`{ type, … }`, con `NOT NULL` y `{"type":"none"}` por defecto).

### Tanda 3 — Entrar y salir · **cerrada** (`90e78b6`, `3ad6c2c`, `55ec579`)

Importar cURL (uno suelto o un markdown lleno), colección Postman v2.1, Insomnia. Exportar cURL
desde el panel de respuesta. Informe HTML y JUnit XML como `?format=` de `GET :runId/report`.

Lo que conviene no volver a discutir:

- **Sale una plantilla, nunca una operación.** Toda petición importada tiene que caer sobre una que
  el contrato activo ya declara; la que no cae vuelve nombrada en `skipped`, que es información
  útil por sí sola. El emparejado va desde el final de la ruta —una colección lleva la base que
  usara su autor— y entre dos que encajan gana la de menos huecos.
- **Lo que no se importa**: la credencial (es del entorno, y guardarla pisaría la que la corrida
  iba a presentar, dejando en verde todos los casos de autorización), el `Content-Type` y el
  `Accept` (los decide el ejecutor) y lo que es del transporte. `auth` entra siempre como
  `default`: los otros tres valores existen para ser rechazados a propósito.
- **El cURL exportado lleva la credencial enmascarada** y lo dice. El valor claro no llega al
  navegador, y es sobre todo una ventaja: un cURL pegado en un ticket es un cURL por el que si no
  habría viajado el token de staging de alguien.
- **El informe no depende de nada externo.** Ni handlebars ni puppeteer: una página sin hoja de
  estilos, sin script y sin imagen, porque acaba de artefacto en un CI o abierta desde el disco.
  Un `?format=` que no se reconoce cae en JSON en vez de romper la tubería.

### Tanda 4 — Permisos por operación

Sección de configuración nueva, `access`: por operación, qué roles deben pasar y cuáles deben
recibir 403, más las reglas entre roles. La matriz genera un caso por celda. Es la más grande y la
única con diseño que discutir antes de escribir.

### Tanda 5 — Varios

Copiar configuración y flujos entre proyectos. Etiquetas propias sobre operaciones. Valores
computados `{{$uuid}}` y compañía.
