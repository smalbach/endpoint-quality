# Endpoint Quality

Verificación de contratos HTTP como producto: multi-proyecto, multi-entorno, con inicio de
sesión. Ejecuta la matriz de casos que una especificación OpenAPI declara y afirma sobre la
respuesta real — schema, envelope, presupuesto de latencia, autorización y persistencia.

**Un 200 no es un test que pasa.**

## Verlo funcionando

Un comando, y trae con qué demostrarlo:

```bash
scripts/demo.sh
```

Levanta Postgres, aplica el esquema, arranca la API y la interfaz, y añade **una API de muestra
con un fallo puesto a propósito**: el borrado es blando y la lectura por id se olvidó del flag, así
que `DELETE /widgets/{id}` responde el `204` que su contrato declara y sigue sirviendo la fila.
Después crea la cuenta, importa el contrato de la muestra desde su `/openapi.json`, escribe la
configuración del proyecto y lanza la matriz una vez.

Termina con 13 casos en verde y 2 en rojo. Los rojos son ese fallo: una suite que compruebe
códigos de estado ve el `204` correcto y da el endpoint por bueno; los casos `delete-read` y
`deleted-read` releen después de borrar y ahí se ve.

    Interfaz    http://localhost:8080   demo@example.com / Una-contraseña-de-demo-1
    API         http://localhost:3001   su propio contrato en /openapi.json
    Muestra     http://localhost:9100

La contraseña pide mayúscula, minúscula, número y símbolo desde que existe «¿Olvidaste tu
contraseña?». Un volumen de demo creado antes conserva la cuenta con la contraseña de entonces:
`scripts/demo.sh down` y vuelta a levantar, o restablecerla desde la pantalla de entrada.

`scripts/demo.sh down` lo para y borra el volumen. Si algún puerto está ocupado:
`EQ_WEB_PORT=8081 scripts/demo.sh` — también `EQ_API_PORT`, `EQ_POSTGRES_PORT` y
`EQ_SAMPLE_PORT`.

## Desplegarlo

```bash
cp docker/.env.example docker/.env    # y genera los tres secretos: ver más abajo
docker compose -f docker/compose.yml up -d
```

### Ver los cambios del código en Docker

Los contenedores sirven la imagen con la que se construyeron: un cambio en el código no aparece
hasta reconstruirla. Compilar primero hace que un error de tipos salga aquí y no a mitad del
`docker build`:

```bash
pnpm --filter @eq/web build && pnpm --filter @eq/api build && docker compose -f docker/compose.yml up -d --build api web
```

`migrate` vuelve a correr solo antes de que arranque `api`. Después, recarga el navegador sin caché
(Cmd+Shift+R) para no quedarte con el JavaScript anterior.

Cuatro servicios: `postgres`, `migrate`, `api`, `web`. `migrate` es un paso propio con su propio
código de salida, y `api` no arranca hasta que termina bien. No es `migrationsRun` al arrancar a
propósito: eso ata «el esquema cambió» a «un proceso arrancó», cada réplica de un despliegue lo
intentaría a la vez, la API atendería peticiones con el DDL a medias, y una migración que falla
parecería un _crash loop_ en vez de una migración fallida.

La interfaz queda en `http://localhost:8080` y la API detrás de `/api`, **mismo origen**. Eso no es
cosmético: la cookie de refresh es `httpOnly` y `SameSite=Strict`, y para que lo segundo signifique
algo no puede haber un segundo sitio. Si sirves la interfaz desde otro dominio, tendrás que
reconstruirla con `VITE_API_URL` y aflojar la cookie, que es exactamente lo que esta forma evita.

### Las variables que importan

| Variable                                  | Por defecto             | Qué pasa si te equivocas                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | _ninguno_               | La API **se niega a arrancar** sin ellos. Un valor por defecto en un fichero versionado firma las sesiones de todo el mundo con la misma clave. Cambiarlos cierra todas las sesiones.                                                                                                                |
| `SECRETS_KEY`                             | _ninguno_               | Cifra las credenciales de los destinos con AES-256-GCM. **Perderla es perderlas**: no hay forma de descifrarlas sin ella, que es la única propiedad que hace que guardarlas valga la pena. Guárdala donde guardes las contraseñas de producción.                                                     |
| `ALLOW_PRIVATE_TARGETS`                   | `false`                 | El motor pide URLs que escribe quien usa el producto. En `true`, cualquiera con una cuenta puede apuntarlo a `169.254.169.254` o a tu base de datos y leer la respuesta. Déjalo en `false` salvo que el producto y los destinos vivan en la misma máquina de alguien.                                |
| `RETENTION_BODIES_DAYS`                   | `30`                    | Pasados esos días se vacían las peticiones y respuestas guardadas de cada corrida, y queda la marca de cuándo. El veredicto y sus aserciones siguen: una corrida de marzo sigue contestando «esto estaba en verde, y esto falló» por unos cientos de bytes. `0` es «nunca», y es la tabla que crece. |
| `RETENTION_RUNS_DAYS`                     | `365`                   | Pasados esos días la corrida entera desaparece, con sus casos y sus pasos. `0` es «nunca».                                                                                                                                                                                                           |
| `QUEUE_DRIVER`                            | `memory`                | `memory` ejecuta la cola en el propio proceso: sin infraestructura, y una corrida muere si la API se reinicia. `redis` es lo que quiere una instancia compartida.                                                                                                                                    |
| `CORS_ORIGINS`                            | `http://localhost:8080` | Solo hace falta si sirves la interfaz desde otro origen.                                                                                                                                                                                                                                             |
| `PUBLIC_API_URL`                          | `http://localhost:3001` | Dirección pública de la API (con su prefijo, si lo tiene). Con ella se construye la URL de un solo uso que entrega un nodo **Esperar webhook**; sin ella solo la puede llamar alguien en la misma máquina.                                                                                           |
| `EQ_*_PORT`                               | 8080 / 3001 / 5432      | Los puertos publicados hacia fuera. Nada más.                                                                                                                                                                                                                                                        |

Genera los tres secretos así, una vez, y guárdalos:

```bash
openssl rand -base64 48 | tr -d '\n='
```

### Redis, cuando haga falta

```bash
QUEUE_DRIVER=redis docker compose -f docker/compose.yml --profile redis up -d
```

Con `memory`, una corrida vive en el proceso que la lanzó. Con `redis` sobrevive a un reinicio y
varias avanzan a la vez. El mismo interruptor enciende el **relé de progreso**: con varias
instancias detrás de un balanceador, la corrida la ejecuta la que cogió el trabajo y la mira quien
haya caído en otra, así que los eventos se retransmiten por pub/sub. Es pub/sub y no un stream a
propósito: el progreso no vale nada tarde, y el registro duradero es la base de datos —quien se
pierda un evento tiene la verdad en el siguiente sondeo. Con `memory` el relé no hace nada, que es
lo correcto cuando solo hay un proceso.

## Desde una pipeline

Una corrida es un recurso en un servidor, así que un trabajo de CI puede lanzarla, esperarla y
romper la build. El dashboard del que sale esto no podía: sus resultados vivían en `useState` y
morían con la pestaña.

```bash
EQ_API=https://eq.example.com EQ_TOKEN=eqt_… \
  node tools/eq-run.mjs --project "Digital Catalog" --environment staging
```

Sin dependencias: un fichero que corre cualquier Node 22. Viaja además dentro de la imagen de la
API, así que `docker compose run --rm api node tools/eq-run.mjs …` funciona sin clonar nada.

Los códigos de salida distinguen las tres cosas que le pueden pasar a un trabajo: **0** la corrida
pasó, **1** hay casos en rojo —y los imprime con la aserción que falló—, **2** no se pudo ejecutar:
faltan argumentos, el token no vale, la API no responde. Los casos _saltados_ —una escritura contra
un entorno de solo lectura— no rompen la build salvo que se lo pidas con `--fail-on-skip`: no son
un hallazgo sobre la API, y reportarlos como tal enseña a la gente a ignorar el rojo.

Dos banderas que existen para una tubería y no para una persona:

```bash
node tools/eq-run.mjs --project "Digital Catalog" --environment staging \
  --labels critico,pagos \
  --junit informe.xml
```

`--labels` corre solo las operaciones con alguna de esas etiquetas —las del equipo, escritas en la
sección `labels`, no las del contrato—, así que una tubería dice «corre lo crítico» una vez y sigue
diciéndolo, en vez de arrastrar una lista de ids que caduca en cuanto alguien añade una operación.
Cualquiera de las dos, nunca todas: es lo que significa escribir dos.

`--junit` escribe el informe en el formato que todos los runners leen, con el texto del fallo al
lado del test que lo produjo. Sin él, una tubería puede decir «la corrida falló» y nada sobre cuál
de 311 casos lo hizo. El mismo informe sale por HTTP con `GET :runId/report?format=junit`, y hay
también `?format=html` para una página que se abre —sin hoja de estilos, sin script y sin imagen,
porque acaba de artefacto en un CI o abierta desde el disco seis meses después—.

El token se emite desde la organización (`POST /orgs/:id/tokens`) y se enseña **una vez**: se
guarda con hash.

## En local, sin contenedores

```bash
pnpm install
createdb endpoint_quality
pnpm --filter @eq/api migration:run
./dev.sh                          # API en :3001 y Vite en :5173
```

Para tener algo que verificar, en otra terminal:

```bash
node examples/sample-api/server.mjs                       # :9000
EQ_API=http://localhost:3001 EQ_TARGET=http://localhost:9000 node tools/seed-demo.mjs
```

## Qué hay que configurar, y qué no

Un contrato que declara su `requestBody` ya ha dicho qué acepta cada escritura, así que los cuerpos
salen de ahí: **un proyecto recién apuntado a un contrato escribe sin que nadie configure nada**.
Se respetan `example`, `default` y `enum` primero —son el autor diciendo qué mandar—, luego los
campos obligatorios, los formatos (`date-time`, `email`, `uuid`…) y los rangos declarados. Es
determinista, para que dos corridas se puedan comparar.

Lo que un contrato nunca dice, y sí pone el proyecto:

- **qué valor existe de verdad** — un `store_id` que devuelve 200 y no 404;
- **qué payload choca** con una fila que ya está ahí, que es el caso 409;
- **qué forma tiene el envelope** de este equipo, cuando no hay schema declarado para ese estado;
- **cuánto debería tardar** cada cosa.

### Colecciones de Postman

Una colección importada **es una colección**: su árbol se guarda tal cual —carpetas, peticiones,
orden, variables y los `pm.test` de cada una— y la sección **Colecciones** la enseña como Postman la
enseña: el árbol a la izquierda y a la derecha Params, Headers, Body, Auth y Scripts. «Enviar» manda
la petición que hay en pantalla; «Correr» lanza la colección entera o una carpeta contra un entorno,
con sus vueltas y su espera entre peticiones, y el informe crece en vivo con el estado, el tiempo y
los tests de cada una. «Exportar» devuelve el `.postman_collection.json`, listo para `newman`.

Lo que un `pm.collectionVariables.set` escribe **viaja a la petición siguiente**, que es lo que hace
que la cadena de una colección de verdad —crear una fila, leerla, borrarla— funcione igual que allí.
Enviar a mano y correr la colección componen los scripts de la colección y de las carpetas de encima
con la misma función, así que no pueden significar cosas distintas.

Antes una colección entraba partida en flujos, un grafo por carpeta con las aristas deducidas del
orden: dejaba de ser la colección de nadie, no volvía a salir a Postman y no se corría como allí. Lo
que sigue escribiendo flujos es la captura de tráfico, que no tiene fichero de nadie detrás.

### Entornos y flujos reutilizables

Cada entorno mantiene variables de texto al estilo Postman. Se pueden usar como `{{variable}}` en
parámetros, rutas y cuerpos JSON. La pestaña **Entornos** los lista a la izquierda y edita el
seleccionado a la derecha: una tabla con una casilla por fila —una variable **apagada conserva su
valor y no se sustituye**, que es lo que evita borrarla para dejar de usarla— y una vista de texto
(`nombre:valor` por línea, `//` delante para las apagadas, o un objeto JSON pegado tal cual) para
las veinte que alguien trae de otro sitio. Nada se guarda hasta pulsar «Guardar».

Las apagadas se almacenan en su propia columna, no como una bandera dentro del mapa: así
`variables` sigue siendo exactamente lo que una corrida sustituye y nadie tiene que filtrarlo antes
de usarlo. Los secretos siguen separados en credenciales cifradas y nunca se mezclan con las
variables visibles. Una petición a la que le falta una variable **no sale a la red**: el paso queda
bloqueado diciendo cuál falta, en vez de pedir `/users/{{userId}}`.

La pestaña **Flujos** añade dos cosas que un proyecto posee, cada una en su propia tabla:

- **pruebas reutilizables** — una operación del contrato con sus parámetros, su cuerpo, su
  credencial y el estado que espera. Son filas porque existen para reutilizarse: las nombran varios
  flujos, editarlas los alcanza a todos, y borrar una que está en uso responde 409 en vez de
  romper una corrida esta noche;
- **flujos dirigidos** que las encadenan y capturan valores de un cuerpo (`data.id`) o de una
  cabecera, publicándolos como variables para los pasos que dependen de ellos.

El grafo se guarda entero, en un solo documento: sus aristas y su orden _son_ el dato, y escribir
nodos y aristas por separado permitiría el estado «nodo borrado, arista apuntándolo». Lo que
Postgres no puede sostener —que no haya ciclos, que cada paso nombre una prueba de este proyecto—
lo comprueban el esquema del motor y el comando, al guardar.

El diagrama y el JSON son dos vistas del mismo documento, y las posiciones de los nodos se guardan
con él. Al ejecutar, el motor ordena el grafo, salta los descendientes de un paso fallido y
registra cada nodo como un caso normal de la corrida. Las variables se copian al inicio: una
captura afecta a esa corrida, no modifica el entorno guardado ni interfiere con otra ejecución
concurrente.

La configuración siempre gana sobre lo derivado: un schema dice qué es estructuralmente válido, un
proyecto sabe qué es aceptable. `examples/sample-api/config.json` es un ejemplo entero y corto.

Seis de las ocho secciones se editan con formulario en la interfaz —`implemented` es una lista de
comprobación contra las operaciones del contrato, y las reglas de presupuesto y de envelope se
ordenan con flechas, porque casan a la primera y el orden decide cuál gana—. `scenarios` y `bodies`
se quedan en JSON a propósito: guardan plantillas de caso y payloads enteros, y un formulario sobre
JSON arbitrario es un peor editor de JSON. El textarea sigue a un clic en todas.

## Su propio contrato

La API publica el suyo en `/openapi.json`, **con los errores que responde y con lo que llevan
dentro sus cuerpos**: 45 operaciones, 220 respuestas declaradas, todas las de error como RFC 9457.
No es cortesía — la matriz se genera desde lo que una operación declara, así que un contrato con
solo el 200 no produce ni matriz de autorización, ni caso de no-encontrado, ni de cuerpo inválido, y
uno cuyos cuerpos son «un objeto» no produce ninguna escritura que se pueda ejecutar.

Los cuerpos se derivan de `class-validator`, no se escriben a mano con `@ApiProperty`: repetir cada
restricción al lado de la primera es cómo el documento acaba mintiendo sobre la regla que la API
aplica. **El documento no puede separarse de la validación porque sale de ella.**

Lo que permite la prueba más barata de si esto generaliza: importar la propia API como un proyecto
más. Sin configurar nada, salen **182 casos** y 165 de las 220 respuestas quedan cubiertas. Los
huecos se nombran solos: no hay generador de casos para el 429, provocar un rate limit a propósito
es una decisión y no un caso automático.

## Tres backends, un contrato

La API no es _la_ API: es **una** implementación de un contrato que otras dos cumplen.

    apps/api      NestJS 11 + TypeORM     :3001   la implementación de referencia
    apps/api-py   FastAPI + asyncpg       :3002
    apps/api-go   net/http + pgx          :3003

Las tres corren **a la vez, contra el mismo Postgres, con los mismos secretos**. El front trae un
selector —en la pantalla de acceso y en la cabecera— y lo que se elige ahí lo sigue todo el flujo.
Cambiar de backend no cierra la sesión: la cookie de refresco es del origen y las tres firman con
la misma clave, así que se entra por Node, se cambia a Go y se sigue dentro.

Eso no se puede fingir. O el formato es el mismo hasta el último byte —scrypt con los mismos
parámetros, SHA-256 en base64 y no en hexadecimal, HS256 con los mismos claims, columnas en
`camelCase` entrecomilladas— o no entra.

```bash
node tools/conformance/run.mjs
```

Corre el mismo guion de HTTP contra los tres y compara **contra la referencia**, no contra un
cuerpo escrito a mano: normaliza lo que cambia entre corridas y afirma sobre lo que queda. Es la
definición operativa de la paridad — un módulo está portado cuando su bloque pasa aquí, y no
cuando alguien lo declara.

    Conformidad · 51 casos × 3 backends
    Paridad: los 3 backends contestan lo mismo en los 51 casos.

Cada implementación publica además `GET /backend`: quién es, sobre qué corre y qué módulos cubre.
El front lo lee **antes** de conectarse y dice lo que ese backend todavía no trae, en vez de
dejarte descubrirlo al llegar a la pantalla que falta.

Hoy cubren `auth` e `iam` enteros y el CRUD de `projects`; el objetivo declarado es la paridad
total de las 221 rutas, por módulos, y la hoja de ruta con el orden está en
**[docs/backends-poliglotas.md](docs/backends-poliglotas.md)**.

## Estructura

    apps/api          NestJS 11 + @nestjs/cqrs — comandos, consultas, saga de ejecución
    apps/api-py       FastAPI + asyncpg — la misma API, en Python
    apps/api-go       net/http + pgx — la misma API, en Go
    apps/web          Vite + React 19 + Tailwind + React Flow — SPA, sin SSR
    packages/
      runner-core     Dominio puro: generación de escenarios, plan de ejecución,
                      presupuestos, validación JSON Schema. Sin framework.
      spec-import     OpenAPI 3.0/3.1 → Operation[]
      contracts       Lo que contesta la API, declarado una vez. Solo tipos, sin
                      runtime: `Date` en el servidor, `string` en el cable.
      import-detect   Qué es lo que alguien acaba de soltar, decidido por su
                      contenido. La misma función en el navegador y en el servidor.
    docker            Dockerfiles y compose; compose.demo.yml añade la muestra
    examples/
      sample-api      El destino de la demostración, con su fallo a propósito
    tools             eq-run (CI), seed-demo, migración del proyecto original,
                      conformance (la prueba de paridad entre los tres backends)
    scripts           demo.sh, parity-cut.sh

## Origen

Extraído de `geronimo-martings/documentation/endpoint-quality-dashboard`, donde el contrato, los
fixtures, los presupuestos del RFP y las credenciales estaban compilados dentro del bundle. Aquí
son filas que alguien edita.

Que no se perdió nada no es una opinión: `scripts/parity-cut.sh` ejecuta la misma matriz con el
ejecutor de aquel dashboard y con el motor de este contra el mismo backend, y compara **veredicto
contra veredicto, caso por caso**. 214 casos sin autorización y 311 con ella, idénticos. La única
divergencia que apareció resultó ser un defecto del original, y está contada en
`docs/phase-log.md`.

## Plan y registro

- `docs/decoupling-plan.md` — diagnóstico del acople, modelo de dominio, superficie REST,
  estrategia de pruebas y las 7 fases con sus criterios de aceptación.
- `docs/phase-log.md` — una entrada por fase cerrada, con la evidencia, las decisiones y la deuda
  que deja. Los fallos que costaron caro están ahí con su causa.

## Seguridad

El motor hace peticiones HTTP a URLs que escribe el usuario, lo cual es SSRF si no se controla. Lo
que hay: se resuelve el DNS y se comprueba la **IP**, no el texto; se vuelve a comprobar en cada
redirección; se conecta a la IP literal conservando el `Host` original; hay tope de tamaño de
respuesta y de tiempo; y una escritura no se reenvía nunca a través de una redirección.
`ALLOW_PRIVATE_TARGETS`, `MAX_REDIRECTS` y `MAX_RESPONSE_BYTES` son las perillas. §4.8 del plan
tiene el razonamiento.

Lo demás: contraseñas con scrypt (RFC 7914, suelo de OWASP), token de acceso en memoria y refresh
en cookie `httpOnly` `SameSite=Strict`, rotación con **detección de reuso** —presentar dos veces el
mismo refresh cierra la sesión entera—, credenciales de destino cifradas con AES-256-GCM y
enmascaradas antes de escribirse en cualquier fila, y RFC 9457 en todos los errores.
