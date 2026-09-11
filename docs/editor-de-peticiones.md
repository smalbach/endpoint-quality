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

Aquí había credenciales por rol en el entorno y un `credential: "none" | "insufficient" | "api-key"`
**global**. Era la única función de seguridad del analizador que encaja con lo que este producto es.
→ tanda 4 ✔

### 3. Importar de otro proyecto

`GET import/available-projects`, `.../endpoints|flows|environments`, `POST from-project`. Copiar
configuración y flujos a un proyecto nuevo. → tanda 5 ✔

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
  scripts sin ejecutar código ajeno. → tanda 5 ✔
- **Pruebas de carga** (`perf-plans`, `loadProfile`, `thresholds`, ventanas de métricas), **escáner
  de GitHub** y **análisis con IA**. Otro producto.
- **Entornos**: ya estaban, y mejor —`initial`/`current`/`sensitive`, `disabledVariables` como mapa
  aparte, la máscara que significa «sin cambio», credenciales por rol.
- **Grupos de flujos**: ya cubiertos por las suites y `RunSource.kind: "suite"`.

---

## Las tandas

Las cinco están cerradas. Lo que queda escrito abajo es por qué cada una quedó con la forma que
tiene, que es lo que hace falta para tocarlas otra vez.

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

### Tanda 4 — Permisos por operación · **cerrada** (`3f3004e`, `c967fd4`, `41874a3`, `97698b7`)

Sección `access`, la novena: por operación, qué roles deben pasar y cuáles deben recibir un
rechazo, más las reglas entre roles. Un caso por celda.

Las decisiones, que se discutieron antes de escribir:

- **Un rol es una credencial con nombre.** `primary`, `insufficient` y `alternate` describen en qué
  _falla_ una credencial; un rol describe quién la tiene. Pasan a ser nombres reservados y el resto
  lo declara el proyecto. Sin migración: la columna ya era `varchar(20)`, lo que lo cerraba era un
  enum en el DTO. En el motor, `auth` gana la forma `role:<nombre>` — un campo con prefijo y no un
  segundo campo al lado, porque hay una sola respuesta por caso a «con qué credencial sale esto».
- **Los roles se declaran en la configuración**, no se leen de las credenciales de un entorno.
  «Esta API tiene estos roles» es del proyecto; «este token es el del vendedor» es del entorno.
  Leerlos del entorno haría que la matriz cambiara de forma según dónde se lanzara. Un rol sin
  credencial en este entorno deja el caso en `config`, nunca en un veredicto sobre el endpoint.
- **`allow` y `deny` se guardan las dos**, y ninguna es el complemento de la otra. El silencio es
  «todavía no se ha dicho», nunca «no debe pasar».
- **Un rechazo acepta 403 y 404.** Una API bien hecha esconde la existencia; exigir uno solo
  pondría en rojo un estilo y no un permiso. Para eso el motor aprende `alsoAccepted`, vacío en
  todo lo que genera la matriz derivada del contrato.
- **El caso entre roles es un flujo de dos pasos**, y el recurso se crea durante la corrida: ir a
  por un id semilla no prueba nada, porque una fixture es de quien digan las fixtures. El paso de
  preparación no es el caso — si falla, el flujo para en vez de anotar un hallazgo sobre algo que
  nunca existió. La limpieza va como el dueño, no como el rol del caso.

Una trampa que salió al abrirlo en el navegador y conviene no repetir: un valor por defecto que
solo existe en el esquema de zod **no** es un valor por defecto del que el resto del código pueda
fiarse. Las secciones se fusionan superficialmente, así que una guardada sin un campo opcional
sustituye al objeto entero. `defineProjectConfig` fusiona `access` clave a clave, como ya hacía con
`text`; cualquier sección futura con un objeto anidado y campos opcionales necesita lo mismo.

### Tanda 5 — Varios · **cerrada** (`efcc44b`, `59b4dd3`, `1c3af48`)

Valores computados, etiquetas propias sobre operaciones, y copiar entre proyectos.

- **Los computados son valores, no programas**, que es lo que permite no ejecutar el código de
  nadie. Lo impuro entra como **una semilla por caso** —un identificador, un instante, un número—
  y la firma como función, así que el motor sigue sin reloj, sin azar y sin criptografía. Una
  semilla por caso y no por aparición: un flujo que pone `{{$uuid}}` en una cabecera y en el cuerpo
  quiere decir el mismo valor, y su paso de relectura quiere decirlo otra vez. Las nombradas se
  sustituyen antes que las computadas, y ese orden es lo que deja que un computado tome una
  variable como argumento.
- **Las etiquetas son las del equipo, no las del contrato**, y lo que las hace valer una sección es
  poder lanzar por ellas. El historial guarda con qué se pidió y no en qué se resolvió aquel día.
- **Copiar rehace los ids y remapea las referencias** —un flujo nombra sus pruebas dentro de un
  `jsonb`— y **no cruza ningún secreto**: las credenciales no van y las variables secretas llegan
  con su nombre y vacías, con `writesAllowed` de vuelta a su valor de partida. Los datasets tampoco
  van: son datos que pertenecen al proyecto para el que se escribieron.

Queda por hacer, si alguna vez hace falta: el editor de `scenarios` y el de `bodies` siguen siendo
un textarea de JSON, y ahí la decisión es que un formulario sobre JSON arbitrario es un editor de
JSON peor que un editor de JSON.
