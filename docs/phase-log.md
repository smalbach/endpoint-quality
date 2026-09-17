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
- `test/parity.test.ts` — el motor generalizado, alimentado con Digital Catalog _como datos_,
  reproduce ese fichero campo por campo: cada caso, cada descripción, cada status esperado, cada
  path resuelto, cada presupuesto y el orden exacto de cada cola.
- `test/scenarios.test.ts` — el mismo motor sobre un proyecto que no es Digital Catalog (una API
  de blog, con otros nombres de parámetro, otro envelope, otros scopes y sin presupuestos). Es la
  mitad que demuestra que la configuración es configuración y no las constantes con otro nombre.

**Lo que el test de paridad encontró**: `bulkUpsertProducts` tiene su propio envelope
(`ProductBulkResult`), declarado en el legacy _antes_ de la regla genérica del prefijo `bulk`.
La primera versión de la configuración lo perdía. Es exactamente el tipo de detalle que una
revisión a ojo no ve y por el que la fase existe.

**Criterios de aceptación**

| Criterio                                                | Estado                                         |
| ------------------------------------------------------- | ---------------------------------------------- |
| Golden generado y congelado desde el código acoplado    | ✅ `test/golden/matrix.json`                   |
| El motor parametrizado reproduce la matriz sin pérdidas | ✅ 5 tests de paridad                          |
| El dashboard acoplado sigue intacto                     | ✅ solo se le añadió `docs/`; `lib/` sin tocar |
| Tipado estricto limpio                                  | ✅ `tsc --noEmit` sin errores                  |

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

---

## P2 — El contrato como dato · cerrada

**Alcance**: `packages/spec-import` (OpenAPI 3.0/3.1 → operaciones, drift, huella); módulos
`projects` y `specs` con importación por URL, upload e inline, versionado, activación y
comprobación de drift; el guard SSRF que la importación por URL exige.

**Evidencia**

    packages/spec-import $ node --experimental-strip-types --test test/*.test.ts
    ℹ tests 35   ℹ pass 35   ℹ fail 0

    apps/api $ pnpm test
    ℹ tests 115  ℹ pass 115  ℹ fail 0

    apps/api $ EQ_TEST_DATABASE_URL=… pnpm test:db
    ℹ tests 13   ℹ pass 13   ℹ fail 0

**El criterio de aceptación, cumplido dos veces.** `spec-import/test/parity.test.ts` lee
`bundled.yaml` y reproduce `contract-operations.ts` campo por campo: 46 operaciones, mismo orden,
mismos parámetros compartidos, mismos estados. Y `apps/api/test/http/projects.test.ts` lo repite
**a través de la API**, importando el documento real por HTTP hacia un proyecto. El generador
`scripts/gen_dashboard_endpoints.py` queda formalmente redundante; se retira en P7.

**Tres fallos que encontraron los tests, no una revisión a ojo**

1. **Ordenación dependiente del locale.** Usaba `localeCompare`, que trata `{` como puntuación:
   `/v1/products/{product_id}` salía antes que `/v1/products/bulk`, mientras que Python compara
   por codepoint. Más allá de la paridad, significaba que **el orden de ejecución de una corrida
   dependía del locale de la máquina que importó el contrato**.
2. **El tope de cuerpo de Express.** El DTO anunciaba 8 MB; Express parsea 100 KB por defecto y
   el contrato de Digital Catalog pesa 118 KB. El límite declarado era mentira, y el fallo salía
   como **500 en vez de 413** porque `body-parser` lanza un `Error` con `status`, no una
   `HttpException`. Corregidos ambos: una constante compartida por `main.ts`, el harness de test
   y el DTO, y una rama en el filtro para los 4xx de middleware.
3. **Choque entre `operationId` y clave primaria.** `ImportedOperation.id` es el nombre que el
   contrato da a la operación; la fila también tiene un `id`. Al guardar, el UUID pisaba al
   `operationId` — y `diffOperations` empareja versiones **por `id`**, así que el drift habría
   comparado dos juegos de UUID recién generados y reportado _todas_ las operaciones como
   eliminadas y vueltas a añadir en cada importación. La clave de la fila pasa a llamarse
   `rowId`.

**El guard SSRF llega en P2, no en P4.** Importar un contrato por URL ya es el servidor pidiendo
una dirección que escribe un cliente. Sin guard, "importa el contrato desde esta URL" es un campo
de formulario que lee `http://169.254.169.254/latest/meta-data/` — credenciales de la instancia,
sin autenticación. Cubierto por 20 tests, incluidos los que corren contra un servidor real:
redirección hacia el endpoint de metadatos, bucle de redirecciones, `::ffff:169.254.169.254`,
respuesta sin fin y timeout. `ALLOW_PRIVATE_TARGETS` sigue en `false` por defecto; existe porque
apuntar a `http://localhost:8100` desde un portátil es el uso normal en self-hosted.

**Decisiones que conviene conocer**

- **Los problemas de importación se recogen, no se lanzan.** Una operación sin `operationId` no
  puede impedir que las otras 45 se importen. Los `error` paran la importación; los `warning` no.
- **Los mismos bytes resuelven a la misma versión.** Reimportar un documento sin cambios devuelve
  la fila existente, que es lo que permite que un drift check programado no engorde la tabla.
- **Se guarda el documento crudo, no solo las operaciones.** La validación de schema durante una
  corrida lo lee, y un contrato que cambia mientras la matriz lo recorre es justo el fallo que la
  herramienta existe para detectar: no puede ser además su modo de funcionamiento.
- **Una referencia `$ref` a otro fichero se reporta, no se resuelve.** Ir a buscarla convertiría
  la importación de una spec en un falsificador de peticiones apuntando a nuestra propia red.
- **Un id de otro proyecto es 404, nunca 403.** Un 403 confirmaría que el id existe, que es un
  oráculo entre clientes.

**Deuda que P2 deja anotada**

- Las cabeceras para un contrato tras autenticación se envían pero **no se persisten**: son una
  credencial y no hay clave con la que cifrarlas hasta P3. Mejor no guardarlas que guardarlas en
  claro.
- La deuda ESM/CJS de P1 se resolvió: `spec-import` se escribe como ESM con especificadores
  `.ts` y emite CommonJS con `rewriteRelativeImportExtensions`. `runner-core` necesitará lo mismo
  en P4.
- El drift check es bajo demanda. Programarlo (y avisar) es post-P7.

---

## P3 — Entornos y configuración · cerrada

**Alcance**: módulo `environments` con credenciales cifradas por rol; módulo `config` con las
secciones validadas; `GET /scenarios`, que ensambla contrato + configuración + entorno y devuelve
la matriz; `tools/migrate-digital-catalog.ts`.

**Evidencia**

    apps/api $ pnpm test
    ℹ tests 140  ℹ pass 140  ℹ fail 0

    apps/api $ EQ_TEST_DATABASE_URL=… pnpm test:db
    ℹ tests 15   ℹ pass 15   ℹ fail 0

**El criterio de aceptación.** `apps/api/test/http/config.test.ts` crea un proyecto por la API,
importa el `bundled.yaml` real, escribe las ocho secciones **una a una por
`PUT /config/:section`, como lo haría un operador**, y compara `GET /scenarios` contra el golden
de P0: **46 operaciones, 311 casos**, mismos nombres, mismas descripciones, mismos estados
esperados, mismas rutas resueltas, mismos presupuestos, y las dos colas de ejecución idénticas
caso por caso. Sembrar el repositorio directamente habría probado el motor y saltado justo la
mitad que esta fase añade.

Con eso, la cadena se sostiene entera: contrato leído en runtime, fixtures como filas, motor que
no conoce ninguno de los dos, y la misma matriz que producía la versión con cinco módulos de
literales.

**Un fallo que encontró el test**: `z.record` sobre una clave de enum exige en zod 4 que estén
**todas** las claves, así que un `scopes.byMethod` que solo nombra `DELETE` se rechazaba por los
seis métodos que deliberadamente no menciona. Es `z.partialRecord`.

**Desviación consciente del plan.** El plan dibujaba tablas normalizadas — `parameter_samples`,
`budget_rules` con `position`. La configuración se guarda como **un documento JSONB por sección**:

- el orden **es** dato: los presupuestos y los escenarios condicionales casan por primera
  coincidencia, y un array lo dice mejor que una columna `position`;
- una sección se escribe entera, así que una edición a medias no es un estado que exista;
- nada consulta entre proyectos "todas las reglas por debajo de 50 ms", que es lo único que la
  forma normalizada compraría.

Lo que cuesta es que Postgres no puede validar la forma, y por eso los esquemas zod viven **junto
a los tipos** en `@eq/runner-core` — un validador en la capa de transporte se separa en silencio
del tipo que describe — y toda escritura pasa por ellos. Hay además una comprobación en tiempo de
compilación de que las secciones cubren `ProjectConfig` entero: añadir un campo y olvidar una
sección es un error de build, no un motor leyendo un default que nadie eligió.

**Decisiones que conviene conocer**

- **Un proyecto sin configurar no falla: genera lo que el contrato permite.** Los defaults están
  casi vacíos a propósito. Un proyecto nuevo produce el listado sin filtros y los 401/403 que el
  contrato declara, y nada que dependa de conocer el dominio: nunca finge saber un EAN que nadie
  le dijo.
- **`writesAllowed` y `authEnforced` nacen apagados.** La primera corrida contra una URL de
  producción no puede ser la que descubre que el interruptor estaba puesto.
- **Un caso bloqueado se lista igual.** Esconderlo haría que la matriz pareciera más pequeña que
  el contrato, que es lo único que un informe de cobertura no debe hacer nunca. Y los dos motivos
  se distinguen, porque el arreglo es distinto: falta autorización en el destino, o falta permitir
  escrituras.
- **Los tres campos de credencial del dashboard acoplado (`token`, `readToken`, `apiKey`) son
  ahora roles**: `primary`, `insufficient`, `alternate`. Uno por entorno y por rol, con índice
  único: dos filas respondiendo a "la insuficiente" harían que el token que envía un caso 403
  dependiese del orden de las filas.
- **El secreto se cifra con AES-256-GCM y no sale nunca**, ni en claro ni como ciphertext. Sin
  `SECRETS_KEY` la API se niega a guardarlo en vez de caer a una clave fija: una clave por defecto
  es lo mismo que no cifrar, y peor, porque el ciphertext parece significar algo.
- **Guardar credenciales es `admin`; curar la matriz es `editor`.** Es donde la escalera de roles
  se gana el sueldo: las dos cosas que pueden dañar algo fuera de este sistema — una credencial de
  staging ajena y el permiso de escribir en un destino — están un peldaño por encima del trabajo
  diario.

**Deuda que P3 deja anotada**

- `runner-core` emite ya CommonJS igual que `spec-import`; el paquete sigue escrito en ESM y el
  `dist` declara su formato con un `package.json` de una línea. La deuda de P1 queda saldada.
- `tools/migrate-digital-catalog.ts` no tiene prueba automatizada: necesita una API viva. Su
  reparto en secciones sí está cubierto — hay un round-trip que comprueba que
  `toSections(defineProjectConfig(merge(secciones)))` devuelve las mismas secciones — y el camino
  HTTP lo ejercita la suite de `config`.
- Las cabeceras de un contrato tras autenticación siguen sin persistirse. Ahora hay cifrador; el
  trabajo es conectarlo, y es media hora en P4.

---

## P4 — Motor de ejecución · cerrada

**Alcance**: `runner-core` gana el planificador de flujos y las aserciones; la API gana el
ejecutor, el orquestador, la cola con dos adaptadores, SSE y la persistencia de corridas.

**Evidencia**

    packages/runner-core $ node --experimental-strip-types --test test/*.test.ts
    ℹ tests 73   ℹ pass 73   ℹ fail 0

    apps/api $ pnpm test
    ℹ tests 159  ℹ pass 159  ℹ fail 0

    apps/api $ EQ_TEST_DATABASE_URL=… pnpm test:db
    ℹ tests 17   ℹ pass 17   ℹ fail 0

**El bucle se mudó del navegador al servidor.** `POST /runs` responde **202 con un id** y nada
más; la matriz avanza en un worker. Cerrar la pestaña, perder la conexión o lanzar desde CI y
olvidarse son ahora la misma cosa. En el dashboard acoplado el bucle vivía dentro de un
componente React: cerrar la pestaña abortaba la corrida a medias, y una corrida lanzada desde una
pipeline no era algo que pudiera existir.

**Los seis escenarios del §6.4 del plan, contra un servidor HTTP real** — no un `fetch` simulado,
que solo demostraría que el simulacro se comporta:

| Fallo del destino                   | Qué lo detecta                                                         |
| ----------------------------------- | ---------------------------------------------------------------------- |
| 200 con envelope roto               | Pasa el status, falla el schema. **La tesis del producto en un test.** |
| POST 201 que no persiste los campos | El paso `act` está bien; falla la relectura                            |
| DELETE 204 que no borra             | `delete-read` pasa, `deleted-read` falla                               |
| Destino lento                       | Falla el presupuesto y **solo** el presupuesto                         |
| 405 sobre operación declarada       | Diagnóstico propio; silencia el resto y detiene el flujo               |
| Errores sin Problem Details         | `{ "error": "..." }` se rechaza                                        |

Más las guardas: sin `writesAllowed` **no sale nada a la red** (comprobado contando las
peticiones que llegan al destino), una URL base inalcanzable falla como _conexión_ y no como
schema, y con `authEnforced` la matriz 401/403 se ejecuta de verdad usando las dos credenciales
por rol.

**Un fallo real del motor que encontraron los tests.** Un DELETE que responde 204 se juzgaba
contra `{ data: Resource }` y fallaba por envelope y por content-type. La configuración de
Digital Catalog tenía una regla explícita para eso, así que la paridad no lo veía — pero
cualquier proyecto nuevo habría visto todos sus DELETE en rojo. **Un 204 no puede llevar cuerpo:
lo dice RFC 9110, no una convención de proyecto**, así que la regla vive ahora en el motor
(204, 205 y 304). La paridad con el golden se mantiene intacta.

**Decisiones que conviene conocer**

- **Los flujos multi-paso son un generador sin E/S.** En el dashboard acoplado vivían dentro del
  componente React, enredados con su estado: qué body enviaba un caso dependía de si React había
  re-renderizado entre dos `await`. Aquí el flujo dice qué pedir, el ejecutor lo pide, y la lógica
  se prueba sin servidor.
- **Toda mutación crea su propia entidad.** Un PUT sobre la fila semilla cambia lo que leen todos
  los casos posteriores de la matriz. Y todo lo que se crea se borra: sin esa limpieza, la segunda
  corrida de un POST sobre una clave natural es un 409 que reporta la corrida anterior.
- **El documento en vivo se lee una vez por corrida.** Releerlo por caso significaría que el
  último caso se afirma contra un contrato que el primero no vio — que es exactamente la deriva
  que esta herramienta detecta, así que no puede ser además su modo de funcionamiento. Si no se
  puede leer, la corrida sigue con la verificación de envelope y lo dice.
- **La cancelación se comprueba entre casos, nunca dentro de uno.** Parar en medio de un
  `create-read` deja una fila sin su paso de limpieza.
- **Los totales se recalculan desde las filas**, no se incrementan en memoria: un worker que
  reinicia no pierde la cuenta.
- **Un caso saltado no es un fallo.** Una corrida con saltados y ningún fallo **pasa**: un caso
  que el entorno rechazó no es un hallazgo sobre la API, y reportarlo como tal enseña a ignorar
  el rojo.
- **Las credenciales se enmascaran antes de escribir la fila**, nunca al leerla: una redacción en
  lectura está a una consulta de olvidarse.
- **`bullmq` se carga con un especificador variable.** Es dependencia opcional de verdad: una
  instalación self-hosted con `QUEUE_DRIVER=memory` no debe fallar al compilar por una cola que
  no usa.

**Deuda que P4 deja anotada**

- **SSE es in-process.** Con `QUEUE_DRIVER=redis` y más de una instancia de API, un seguidor
  conectado a la instancia B no ve nada de una corrida que ejecuta la instancia A. El _fallback_
  por polling de `GET /runs/:id` lo cubre hoy; un relé por Redis pub/sub es el arreglo cuando
  multi-instancia sea real.
- **Sin política de retención.** `run_steps` guarda cuerpos completos y es la tabla que crece.
  `keepFullBodiesForDays` sigue pendiente.
- Las cabeceras de un contrato tras autenticación siguen sin persistirse, aunque el cifrador ya
  existe desde P3.
- La suite usa `--test-force-exit`: `fetch` mantiene sockets en el dispatcher global de undici y
  Node no expone forma pública de drenarlo. Sin el flag el proceso se queda colgado al salir con
  todas las aserciones ya en verde, que parece un timeout y es una fuga.

---

## P5 — El front · cerrada

**Alcance**: `apps/web`, una SPA de Vite + React 19 + Tailwind 4 con login, lista de proyectos,
la matriz reconectada, entornos, configuración, historial y corrida en vivo por SSE. Se abandona
vinext y el Worker de Cloudflare.

**Evidencia**

    packages/runner-core   73 pass   0 fail
    packages/spec-import   35 pass   0 fail
    apps/api              159 pass   0 fail
    apps/api (postgres)    17 pass   0 fail
    apps/web               28 pass   0 fail

**El criterio de aceptación, comprobado contra el artefacto.** `src/lib/bundle.test.ts` construye
la aplicación y busca en el JS emitido las constantes que hacían monotemática a la versión
acoplada: el EAN de las fixtures, `ean_sap`, las coordenadas de Bogotá, `Cundinamarca`,
`RFP §6`, `catalog:admin`, la URL base del backend, y las descripciones de los casos generados.
Ninguna aparece. Leer el código y concluir que se ve limpio no habría sido una comprobación: en
la versión acoplada esas constantes estaban repartidas por cinco módulos y cada una parecía
incidental donde estaba.

**Ese test encontró una fuga a la primera**: había dejado `http://127.0.0.1:8100` —la URL del
backend de Digital Catalog— como _placeholder_ del formulario de entornos.

**Cuatro fallos que solo aparecieron al ejecutar de verdad**

Ninguno lo veía la suite, y los cuatro son del tipo que un despliegue encuentra el primer día.

1. **`CLOCK` no era global.** Estaba registrado en `AppModule`, que no lo es, así que ningún
   handler de un módulo hijo lo resolvía y el proceso no arrancaba. El harness de test registra
   todos los proveedores en un módulo plano, así que no podía verlo: lo primero que lo vio fue
   arrancar el binario.
2. **`OrgRoleGuard` no resolvía sus dependencias** en `environments` y `runs`: `@UseGuards()`
   instancia el guard en el módulo del controlador, y esos no importaban `IamModule`.
3. **La cookie de refresh tenía `path=/auth`.** Detrás de un prefijo —`/api` con nginx, el mismo
   con Vite— el navegador ve `/api/auth/refresh`, que no casa. La cookie no se enviaba nunca, la
   renovación siempre fallaba, y **la sesión moría en cada recarga de la página**, en silencio:
   la aplicación simplemente mostraba el login. Es `path=/`; lo que protege esa cookie es
   `httpOnly` y `SameSite=Strict`, y ninguno de los dos depende de la ruta.
4. **El primer evento SSE enviaba una promesa**, que Nest serializa como `{}`. Un cliente que se
   conectaba a mitad de una corrida veía los totales a cero mientras las filas decían otra cosa.

Y una decisión que salió de usarlo: **el stream SSE queda fuera del throttler**. Una conexión
larga no es una tasa de peticiones, y contarla como tal crea una trampa — cuando el stream se
rechaza el cliente cae a _polling_, el _polling_ gasta el mismo presupuesto, y el stream ya no
puede reconectar.

**Verificado en un navegador, contra la API viva y Postgres real**: registro, sesión que sobrevive
a un recargado, lista de proyectos con el contrato v1.8.0, la matriz con sus **46 operaciones y
311 casos**, el selector de entorno marcando **179 casos que no se ejecutarán** en uno de solo
lectura, una corrida lanzada desde la interfaz avanzando **en vivo**, y el detalle de un caso con
sus cuatro aserciones — incluida `1 muestra: 2 ms (una medición no es un p95)`.

**Decisiones que conviene conocer**

- **El access token vive en memoria, nunca en `localStorage`.** Es la razón de que el refresh sea
  una cookie httpOnly: un XSS en esta página puede llamar a la API mientras la pestaña esté
  abierta, y no puede llevarse una credencial de treinta días.
- **Un 401 dispara una sola renovación, compartida por todas las peticiones en vuelo.** Sin eso,
  una página que lanza seis consultas al cargar manda seis renovaciones, cinco de las cuales
  presentan un token que la primera ya rotó — y el servidor, correctamente, lo lee como robo y
  cierra la sesión. Hay un test para exactamente ese caso.
- **El SSE se lee con `fetch` y un parser propio, no con `EventSource`.** `EventSource` no puede
  enviar cabeceras, y las alternativas eran el token en la URL —donde acaba en todos los logs— o
  el access token como cookie, que reabre CSRF en todas las rutas.
- **Los editores de configuración son áreas de JSON validadas por el servidor, no formularios.**
  Es una parada consciente: un formulario por sección es una semana, las formas todavía se
  mueven, y la API ya responde con la ruta exacta del campo que está mal.

**Deuda que P5 deja anotada**

- Un test intermitente: dos veces en la suite completa un `signUp` no devolvió token y el fallo
  apareció como un 401 en la línea siguiente. **No se ha encontrado la causa**; se añadieron
  aserciones en los helpers para que la nombren si vuelve, y tres pasadas seguidas van limpias.
  Ambas apariciones fueron con la API y Vite corriendo a la vez en la misma máquina.
- Los tipos de la API están escritos a mano en `apps/web/src/lib/types.ts`. `packages/contracts`
  es donde se encuentran cuando haya un segundo consumidor; con un cliente, la indirección no se
  paga sola.
- Sin editores visuales de configuración, sin gestión de miembros en la interfaz y sin `/settings/org`.

---

## P6 — Corte de paridad · cerrada

**Alcance**: correr el proyecto Digital Catalog migrado contra el backend E2E real y comparar
veredicto contra veredicto, caso por caso, con el ejecutor del dashboard acoplado. Reproducir el
conteo de cobertura del README acoplado.

### Cómo se compara un veredicto con un veredicto

Las fases anteriores compararon _listas de casos_. Esto compara _resultados_, que es lo único que
prueba que el producto juzga igual. Para eso hacía falta un oráculo ejecutable:

- `tools/parity-cut/legacy/route.ts` es una copia **byte a byte** de
  `app/api/run/route.ts` — la lógica de veredicto entera: status, envelope, content type, JSON
  Schema, presupuesto de latencia. Solo se reescriben dos imports, y `next/server` apunta a un
  shim de quince líneas que devuelve un `Response` de verdad, para poder llamar al handler como
  una función sin instalar Next en un arnés de comparación.
- `tools/parity-cut/legacy/orchestrate.ts` es el `runScenario` del componente React, que **no** se
  podía copiar porque era un closure sobre estado de React. Su cabecera enumera las tres ediciones
  aplicadas — quitar los `setResults`, llamar a `POST` directamente, y convertir el estado del
  componente en parámetros — y ninguna rama cambia.
- el lado del producto va **por la API pública** con una sesión real: entorno apuntando al
  destino, credenciales guardadas, `POST /runs`, esperar, leer. Nada toca la base de datos. Un
  atajo aquí probaría la paridad de una función interna, no la del producto.

Cada lado corre contra una base **recién reiniciada**. La matriz escribe, el dashboard acoplado
limpia detrás de sí _para poder repetirse_, y "para poder" no es "demostradamente lo hace": una
fila que sobreviva convierte el `POST` del segundo lado en un 409 sobre una UNIQUE, y eso se
reportaría como fallo del desacoplamiento sin serlo.

### Evidencia

    $ EQ_EMAIL=… EQ_PASSWORD=… scripts/parity-cut.sh

    Corte de paridad sin --auth contra http://127.0.0.1:8100
      casos legacy    214      casos producto  214
      verdes legacy   116      verdes producto 116
    Paridad: idéntica, caso por caso.

    Corte de paridad con --auth contra http://127.0.0.1:8100
      casos legacy    311      casos producto  311
      verdes legacy   134      verdes producto 144
    Veredictos que no coinciden (10) …

    Aislando la causa: legacy con una sola credencial en auth:default
      verdes legacy   144      verdes producto 144
    Paridad: idéntica, caso por caso.

### La única divergencia, y por qué el producto tiene razón

Los diez desacuerdos van todos en la misma dirección —legacy en rojo, producto en verde— y todos
sobre las escrituras, que son las únicas operaciones que el backend implementa de verdad. Una sola
causa, en el dashboard acoplado:

    credentialsFor(scenario)  // auth: "default"
      if (token)  credentials.Authorization = `Bearer ${token}`;
      if (apiKey) credentials["X-API-Key"] = apiKey;    // ← las dos a la vez

Comprobado contra el backend con `--auth`:

    DELETE /v1/stores/999999  con Bearer                 → 404
    DELETE /v1/stores/999999  con Bearer + X-API-Key     → 401
      "This operation only accepts an OAuth2 bearer token, not an API key."

Es D-29 vista desde el otro lado. Una operación que no declara `ApiKeyAuth` responde 401 a la
presencia de una clave por muy bueno que sea el bearer — así que **rellenar el campo de API key,
que los casos 403 y D-29 exigen rellenar, pone en rojo toda la matriz de escritura por un motivo
ajeno al endpoint**. Es exactamente la clase de falso rojo que este producto existe para no
producir: `auth: "default"` significa "la credencial que este caso presenta", en singular.

El producto manda solo la credencial `primary`. Para demostrar que los diez son _un_ defecto y no
diez regresiones, el snapshot lleva un `singleCredential` que neutraliza únicamente eso; con él la
paridad es idéntica en los 311. El guion lo ejecuta solo cuando la segunda pasada difiere, y falla
si quedan diferencias que esa causa no explique.

### Cobertura, ya no contada a mano

El README acoplado publicaba una tabla mantenida a mano: 196 respuestas declaradas, 195 con caso,
el hueco siendo el 503 de `/health`. Era verdad el día que alguien la contó y no tenía forma de
seguir siéndolo. Ahora es `GET /coverage`, calculada desde las mismas filas y el mismo motor que
`GET /scenarios`, y `apps/api/test/http/config.test.ts` reproduce la tabla banda por banda:

    200·201·204  46/46      401·403  90/90      404  33/33
    422          21/21      409        5/5      503   0/1

    totales: 46 operaciones · 196 declaradas · 195 con caso · 1 hueco

El hueco se **nombra**, no solo se cuenta: `{ healthCheck, GET /health, 503 }`. Un total es un
número con el que sentirse bien; la lista es sobre lo que alguien puede decidir. La medida es
deliberadamente tosca —una respuesta está cubierta si algún caso espera ese status en esa
operación— y dice que el caso existe, no que sea bueno. Lo que sí atrapa es el fallo que se
esconde: un 409 que el contrato declara, que nadie provoca nunca, y una corrida que vuelve verde
sin haberlo intentado. Se mide **sin entorno**, porque la cobertura es propiedad del contrato y de
la configuración: un destino de solo lectura bloquea sus escrituras, y contarlas como no cubiertas
diría "el contrato está sin probar" cuando lo que pasó es que alguien eligió un destino seguro.

### Lo que el corte cambió del producto

Dos cosas, y ninguna era del arnés:

1. **`GET /runs/:runId/report`**. Leer una corrida entera existía solo caso a caso, y esa vista
   lleva todos los cuerpos de respuesta; pedirla 311 veces contra un límite de 120 por minuto es
   un 429 —lo fue— y, sin límite, decenas de megabytes. El informe trae cada caso con sus
   aserciones y ningún cuerpo: una corrida de 311 casos son unos cientos de kilobytes. Es lo que
   un trabajo de CI lee, que es justo lo que P7 promete. Con dos pruebas: que trae todos los casos
   con sus aserciones, y que **no** lleva `request`, `expected` ni `actual`, porque si eso vuelve
   a colarse deja de ser usable de un tirón.
2. **El sondeo del arnés a 400 ms era de 150 peticiones por minuto**, por encima del propio límite
   de la API: una corrida larga estrangulaba las peticiones que la vigilaban. Para seguir una
   corrida en vivo está el stream; un guion que solo quiere el final puede esperar.

**Suites**: runner-core 73 · spec-import 35 · api 165 · api contra Postgres 17 · web 28.

### Deuda que P6 deja anotada

- El corte compara **el veredicto**, no la latencia: los dos lados miden procesos distintos en una
  máquina compartida y un presupuesto que cambia porque el portátil estaba ocupado es ruido.
- `tools/parity-cut/legacy/` es la segunda mitad del oráculo y se borra en P7 con el repo original.
- El defecto D-29 del dashboard acoplado queda documentado aquí y **no se arregla allí**: ese repo
  se retira en P7 y tocarlo invalidaría el oráculo de esta misma fase.

---

## P7 — Empaquetado · cerrada

**Alcance**: `docker compose up` de un comando que levanta todo y trae un proyecto de ejemplo que
corre solo; corridas desde CI con token y código de salida; README de despliegue; OpenAPI propia.

### Un comando, y algo que verificar

`scripts/demo.sh` levanta Postgres, aplica el esquema, arranca la API y la interfaz, añade una API
de muestra, crea la cuenta, importa el contrato **desde el `/openapi.json` vivo de la muestra**,
escribe la configuración del proyecto y lanza la matriz una vez. Verificado desde cero —
`down -v`, borrando `docker/.env`— y en el navegador contra los contenedores: login a través de
nginx, sesión que sobrevive a una recarga, la matriz con su línea de cobertura, el historial y la
vista de evidencia nombrando el paso que falla.

Termina en **13 verdes y 2 rojos**, y los rojos son un fallo puesto a propósito en la muestra: el
borrado es blando y la lectura por id se olvidó del flag, así que `DELETE /widgets/{id}` responde
el `204` que su contrato declara y sigue sirviendo la fila. Una suite de códigos de estado lo da
por bueno. Es deliberadamente un fallo corriente y deliberadamente _aislado_ —el flag se respeta en
todas partes menos en esa lectura— para que la limpieza siga liberando el nombre, la matriz se
pueda repetir y salgan dos filas rojas en vez de una cascada que nadie lee.

**El compose de la demo es un fichero aparte y no un perfil** porque cambia `ALLOW_PRIVATE_TARGETS`
en el servicio `api`: el destino es un contenedor de al lado con nombre DNS privado, así que la
demo no funciona sin abrirlo, y un despliegue de verdad no debe heredarlo por descuido.

### Tres cosas que no funcionaban y nadie había ejecutado

1. **La imagen de la API nunca arrancó.** Moría con `Cannot find module '@eq/spec-import'`: el
   Dockerfile copiaba uno de los tres manifiestos del workspace, así que pnpm no enlazaba nada, y
   la etapa de runtime copiaba `node_modules` sin los `packages/*` a los que apuntan los enlaces.
   No lo veía nadie porque nadie la había construido.
2. **No había migraciones en la imagen.** `pnpm migration:run` pasa las fuentes TypeScript por el
   CLI de TypeORM, que está bien en un portátil y es imposible en una imagen sin fuentes ni
   compilador: habría arrancado contra un esquema vacío. Ahora es `apps/api/dist/migrate.js`, con
   su servicio, su código de salida y un _advisory lock_ de Postgres para el caso de dos
   contenedores de init a la vez. **No `migrationsRun` al arrancar**: eso ata «el esquema cambió» a
   «un proceso arrancó», cada réplica lo intenta, la API atiende con el DDL a medias, y una
   migración fallida parece un _crash loop_.
3. **Tres de las cuatro pestañas de proyecto te echaban del proyecto.** Eran rutas relativas, y
   react-router las resuelve contra **la ruta en la que se renderiza el enlace**, no contra la URL
   de la barra de direcciones; este layout está montado en `/`, así que `runs` era `/runs`, no
   casaba con nada y caía en el comodín que redirige a la lista de proyectos. Sobrevivió dos fases
   porque todas las pantallas se alcanzaban por los botones que navegan con ruta completa. Lo
   encontró hacer clic en una pestaña.

### Desde una pipeline

`tools/eq-run.mjs`: token dentro, matriz fuera, y un código de salida que distingue las tres cosas
que le pueden pasar a un trabajo — **0** pasó, **1** hay rojos (y los imprime con la aserción que
falló), **2** no se pudo ejecutar. Los saltados no rompen la build salvo `--fail-on-skip`.

Sin dependencias a propósito: una herramienta que necesita `npm install` para decirte si tu API
está sana le ha metido una cadena de suministro a tu pipeline. Viaja dentro de la imagen de la API,
así que el camino que ve alguien el primer día es el mismo que usa su pipeline.

Hizo falta **`GET /auth/context`**: un token de servicio no tenía forma de descubrir su propia
organización. `/auth/me` es sobre una persona y lo rechaza, correctamente, y toda ruta de proyecto
necesita un id de organización. Una credencial que funciona y no se puede usar.

### La API publica ahora lo que responde cuando algo va mal

El documento que generaba Nest describía el camino feliz: una respuesta por operación, la que
devuelve el handler. El 401 de un token que falta, el 404 de un proyecto ajeno, el 422 de un cuerpo
inválido — nada declarado. **Un producto que verifica contratos publicando medio contrato** es el
chiste contándose solo, y tiene una consecuencia concreta: la matriz se genera desde `statuses`, así
que con solo un 200 no hay matriz de autorización, ni caso de no-encontrado, ni de cuerpo inválido.

Los errores se declaran desde la forma de la ruta y no decorador a decorador, porque 45 operaciones
de `@ApiResponse` son 45 sitios donde el documento se separa del guard que de verdad decide. Eso
compra uniformidad y cuesta una forma de estar equivocado, así que la afirmación se comprueba donde
se puede: **cada GET documentado se llama sin token**, y la respuesta tiene que ser 401 exactamente
cuando el documento dice que la ruta necesita uno.

De 45 respuestas declaradas se pasó a **220**.

### Y entonces se le apuntó a sí misma

La prueba más barata de si algo de esto generaliza: importar `http://…/openapi.json` de la propia
API como un proyecto más.

    45 operaciones · 220 respuestas declaradas · 182 casos · 165 respuestas con caso

    200 23/23   201 7/7    401 41/41   403 35/35   404 35/35   422 19/19
    204  5/14   202 0/1    429  0/45

Sin una línea de configuración. Los huecos que se nombra a sí misma son honestos y quedan
anotados: **no hay generador de casos para 429** —provocar un rate limit a propósito es una
decisión, no un caso automático—, los nueve 204 sin caso son operaciones sin colección de la que
colgar un flujo de borrado, y el 202 es el arranque asíncrono de una corrida.

**Suites**: runner-core 80 · spec-import 35 · api 170 · api contra Postgres 17 · web 32.

### Lo que P7 deja abierto, a propósito

- **Imágenes publicadas**: los Dockerfiles construyen y las imágenes funcionan, pero publicarlas
  necesita un registro y credenciales de quien despliega. No es una decisión que se tome desde
  aquí.
- **La retirada del oráculo**: el plan decía retirar `scripts/gen_dashboard_endpoints.py` y los dos
  `test/legacy/` en P7, «junto con el repo original». El repo original **sigue vivo**, y mientras
  siga vivo borrar los snapshots solo quita la capacidad de repetir el corte de paridad sin ganar
  nada. Además `gen_dashboard_endpoints.py` vive en otro repositorio y su `make dashboard-check`
  depende de él: retirarlo es una decisión sobre el build de otro proyecto. Queda como el último
  paso, cuando se decida jubilar el dashboard acoplado.
- ~~La deuda anterior sigue en pie: el stream SSE es por proceso, no hay política de retención de
  `run_steps`, las cabeceras de auth del origen del contrato no persisten, los tipos de la API en
  el front están a mano, y no hay editores visuales de configuración ni gestión de miembros.~~
  Cerrada abajo, en «Cerrar la deuda».
- **Los cuerpos de petición no se derivan del contrato.** Un proyecto nuevo apuntado a un contrato
  que declara su `requestBody` sigue necesitando una sección `bodies` escrita a mano para que las
  escrituras no salgan todas en 422. La demostración lo enseña —esa configuración está en
  `examples/sample-api/config.json` y es media demostración— pero derivar un ejemplo del JSON
  Schema declarado es lo que separa «funciona configurándolo» de «funciona apuntándolo». Es el
  siguiente trabajo con más valor por línea.

---

## Apuntar en vez de configurar · cerrada

La deuda que P7 dejó señalada como el siguiente trabajo con más valor por línea: un proyecto nuevo
apuntado a un contrato que declara su `requestBody` seguía necesitando una sección `bodies` escrita
a mano, y hasta que alguien la escribía **todos sus POST, PUT y PATCH volvían en 422**. Eso se lee
como un hallazgo sobre la API y era un hueco de esta herramienta. El contrato tenía la respuesta
desde el principio; la importación la estaba tirando a la basura.

### Lo que se hizo

`spec-import` guarda el JSON Schema del `requestBody`, con los `$ref` resueltos **en todo el
árbol** y no solo en la raíz — los refs suelen estar en las hojas, y dejarlos sin resolver produce
un ejemplo con la cadena `$ref` dentro, que es peor que no tener ejemplo. Una columna `jsonb`
nullable lo persiste; nula significa «nada que derivar», que es exactamente lo que hacía cada fila
antes de que la columna existiera, así que los contratos importados con la versión anterior siguen
comportándose igual y reimportar es lo que los rellena.

`runner-core` gana `exampleFromSchema`. Las reglas, y el porqué de cada una:

- **Lo que dice el documento gana**: `example`, `default`, `const`, `enum`, en ese orden y a
  cualquier profundidad. Un `example` en el cuerpo entero es el autor diciendo qué mandar.
- **Los obligatorios siempre; los opcionales solo si el documento les dio valor.** El payload
  mínimo válido es el que más probablemente se acepte, y un 422 provocado por un campo opcional que
  nadie pidió se lee como un fallo del endpoint.
- **Salvo que no haya ninguno obligatorio**, y entonces todos los que declare. Declararlo todo
  opcional es lo que _es_ un `PATCH`: su payload mínimo válido es `{}`, que es no mandar nada, y a
  eso varias APIs responden 422 con razón.
- **`readOnly` no viaja.** Lo dice OpenAPI, y una API que valida estricto responde 422 — seríamos
  nosotros provocando el fallo que luego reportamos.
- **`minLength`, `maxLength`, `minimum`, `multipleOf`, `minItems`** se respetan. Un valor que
  incumple la restricción que el propio contrato publicó sería esta herramienta escribiendo el 422.
- **Determinista.** Un cuerpo que cambia entre corridas hace dos corridas incomparables y un fallo
  irreproducible.
- **Nunca un objeto vacío.** Un objeto vacío _es_ el caso `invalid-body`; devolverlo aquí haría que
  el caso de creación y el de cuerpo inválido mandaran el mismo payload y esperaran lo contrario.
- **El 409 no se deriva.** Necesita un payload que choque con una fila que ya está ahí, que es
  conocimiento sobre los datos y no sobre el schema. `conflictBody` sigue siendo configuración, y
  sin él sencillamente no hay caso de conflicto.

Y **la configuración sigue mandando**: un schema dice qué es estructuralmente válido; un proyecto
sabe qué es _aceptable_ — qué tienda existe, qué EAN es real, qué nombre está cogido.

### La prueba

La sección `bodies` de la demostración se borró. Lo único que quedó de ella es un `conflictBody`,
que es justo la línea que hay que explicar. La corrida sigue en **15 casos, 13 verdes y 2 rojos**, y
los rojos siguen siendo el fallo sembrado. Los cuerpos de `createWidget` y `patchWidget` los pone
ahora el contrato.

El corte de paridad de P6 se volvió a ejecutar entero: **idéntico**, las dos pasadas. Digital
Catalog define sus 21 cuerpos, así que la configuración gana y no cambió nada — que es la propiedad
que se quería.

### Y por el camino, otra vez el mismo defecto un nivel más abajo

Apuntar el producto a su propio contrato tras esto seguía dando **22 casos de escritura sin
cuerpo**. El motivo: Nest genera `{"type":"object","properties":{}}` para cada DTO, porque las
clases llevan decoradores de `class-validator` y ningún `@ApiProperty`. El contrato decía que cada
escritura acepta «un objeto» y nada más.

La solución obvia —`@ApiProperty` en las cincuenta y tres propiedades— no se tomó por una razón:
repetiría cada restricción una segunda vez, al lado de la primera, sin nada que mantenga las dos de
acuerdo. Un `@MinLength(12)` y un `@ApiProperty({ minLength: 8 })` en el mismo campo compilan los
dos, y el documento estaría mintiendo sobre la regla que la API aplica.

`describe-bodies.ts` lee las reglas en vez de repetirlas: `class-validator` guarda cada una con el
nombre del validador que la produjo, y eso basta para escribir la misma regla como JSON Schema.
**El documento no puede separarse de la validación porque sale de ella.** Los anidados
(`@ValidateNested`) se resuelven por `design:type` y se escriben en línea, porque Nest nunca puso
esas clases en `components` y una referencia colgaría.

Resultado: de 22 escrituras sin cuerpo a **5**, y las cinco son honestas — tres operaciones que no
llevan cuerpo, una que acepta JSON arbitrario (`PUT /config/{section}`), y el arranque de corrida.
Una prueba recorre el documento y falla si cualquier operación declara un cuerpo y no dice qué
lleva dentro, que es lo que hace que la lista de DTOs no se pueda olvidar.

### Deuda

- ~~`EnvironmentDto` declara **todos** sus campos opcionales porque lo comparten el POST y el
  PATCH~~ — corregido abajo.
- Los formatos que `exampleFromSchema` no conoce caen al marcador genérico. Es correcto —inventar
  un valor para una regla que no entiende metería en el contrato una afirmación que nada respalda—
  pero un `pattern` con una expresión regular sencilla sí se podría satisfacer.

## Un DTO por petición, no por recurso

`EnvironmentDto` era una sola clase para crear y para modificar, y compartirla obligaba a marcar
**todos** sus campos como `@IsOptional()`: un `PATCH` que solo enciende `writesAllowed` no puede
verse forzado a reenviar el nombre.

Eso no se notaba hasta que el contrato pasó a derivarse de esos mismos validadores. Entonces el
documento empezó a decir que `POST /environments` no exige nada — que `{}` es una forma válida de
crear un entorno. No lo es: el handler responde 422 nombrando `name`. **El documento describía una
API que no existe**, que es exactamente el fallo que este producto busca en los demás.

`CreateEnvironmentDto` exige `name` y `baseUrl`; `UpdateEnvironmentDto` no exige nada, que es lo
que un update parcial _es_. El 422 sale ahora del pipe, donde se decide por la forma de la
petición y no por lógica de negocio tres capas más abajo. El handler conserva sus comprobaciones:
un command bus se alcanza desde sitios donde ningún `ValidationPipe` corre, y el invariante es del
dominio, no de HTTP.

La regla de la URL no se duplicó. `normalizeBaseUrl` sigue siendo el único sitio que decide qué es
una URL base válida; un `@IsUrl()` en el DTO sería una segunda definición libre de discrepar con la
primera —y de hecho discreparía, porque `isURL` rechaza por defecto `http://127.0.0.1:8100`, que es
el destino de las pruebas.

Dos pruebas nuevas: una lee el documento y comprueba que `CreateEnvironmentDto` exige los dos
campos y `UpdateEnvironmentDto` ninguno; otra llama a la API y comprueba que responde eso mismo —
`{}` es 422 nombrando ambos campos, y un `PATCH` con solo una bandera deja el nombre donde estaba.

Suites: runner-core 95 · spec-import 35 · api **177** · api/Postgres 17 · web 32.

## Cerrar la deuda

Seis cosas anotadas en su momento como «lo siguiente». Están hechas, y lo que sigue es qué se
aprendió de cada una, que casi nunca fue lo que decía la nota.

### Un `pattern` es el contrato hablando

Un campo con `pattern: "^[A-Z]{3}-\\d{4}$"` recibía `"ejemplo"`. La nota decía «se podría
satisfacer una expresión regular sencilla»; lo cierto es más fuerte: es el único sitio donde «no
adivinar más allá del documento» no aplica, porque el patrón _es_ el documento, y mandar otra cosa
es escribir uno mismo el 422 que luego se reporta.

`exampleFromPattern` cubre literales, clases, rangos, escapes, grupos, alternancia y repetición
contada. Lo que no cubre lo **abandona en vez de aproximarlo** —un valor que parece cumplir una
regla y no la cumple manda a alguien a mirar el endpoint— y todo lo que genera se comprueba contra
el `RegExp` de verdad antes de usarse, así que el módulo puede equivocarse pero no puede colar un
valor incorrecto.

### La tabla que no tenía techo

`run_steps` era la única parte del sistema sin límite. Lo que hizo la política tratable fue notar
que las dos mitades de una fila pesan distinto: los cuerpos son casi todo el tamaño, y la lista de
aserciones son unos cientos de bytes y son lo que hace que una corrida de marzo siga contestando
«esto estaba en verde, y esto falló». De ahí dos plazos y no uno.

`prunedAt` y no un objeto vacío, porque un `actual` nulo porque nadie contestó es un timeout y uno
nulo porque se retiró seis meses después es una petición completa. La interfaz lo dice con todas
las letras; sin eso una corrida vieja se lee como una pared de timeouts.

Sin cron y sin lock: el barrido es idempotente, así que dos instancias barriendo a la vez gastan
una consulta. Las pruebas contra Postgres **instancian el repositorio de verdad** en vez de
reescribir su SQL, que es la única forma de que no pasen mientras el repositorio está mal.

### Un contrato detrás de login

La columna cifrada existía desde la primera migración y siempre se escribía null. Guardar las
cabeceras es la mitad fácil; la mitad que importa es **contra qué se reutilizan**: solo contra la
misma dirección, o cualquiera con permiso de editor apunta la importación a su propio servidor y
recibe el token de staging de otro en la petición.

Con eso, `source` pasa a ser opcional: omitirlo relee donde el proyecto leyó la última vez. Un
drift check programado deja de necesitar un secreto dentro de su petición, que era el motivo real
por el que no existía.

### El progreso cruza instancias

`QUEUE_DRIVER=redis` ya decía «hay más de un proceso», así que el relé usa el mismo interruptor: la
corrida la ejecuta quien cogió el trabajo y la mira quien haya caído en otra instancia, y eso
coincidía por suerte.

Pub/sub y no un stream, a propósito: el progreso no vale nada tarde y el registro duradero es la
base de datos. Local primero y relé después, para que un broker lento no se meta en el camino de
ejecutar un caso. Y lo que llega de fuera no se retransmite, que es lo que impide que dos
instancias se reenvíen el mismo evento sin parar.

### Una sola declaración de lo que contesta la API

La nota decía «tipos a mano en el front». El fallo concreto fue peor y ya había ocurrido: cuando
`run_steps` aprendió a que le retiren los cuerpos, la API empezó a contestar `request: null` y el
navegador siguió con un tipo que decía que estaba siempre. **Un compilador no puede cazar una
mentira que le contaron dos veces.**

`@eq/contracts`, solo tipos, escritos una vez sobre un parámetro de fecha —`Date` en el servidor,
`string` en el cable— porque es lo único en lo que los dos lados difieren de verdad. La causa de
fondo, sin embargo, estaba en el dominio: `RunStep` llevaba `unknown` en sus tres payloads, y
`unknown` es asignable a cualquier cosa. El casteo vive ahora en el repositorio, que es la frontera
con `jsonb`, y una sola vez.

### La interfaz que faltaba

`/settings/org` con personas, invitaciones y credenciales de servicio; y seis de las ocho secciones
de configuración con formulario. Cuáles seis es un juicio: `scenarios` y `bodies` guardan
plantillas y payloads enteros —JSON arbitrario por definición— y un formulario sobre eso es un peor
editor de JSON que un editor de JSON. El textarea sigue a un clic en todas.

Dos cosas que los editores cuidan y que un formulario ingenuo se salta: **el orden es dato** —las
reglas casan a la primera, así que las flechas deciden cuál gana— y **un opcional vacío no es un
opcional ausente**: `pathSuffix: ""` casa con toda ruta que acabe en nada, que son todas, y el
schema lo acepta.

Probarlo en el navegador encontró un fallo que ninguna prueba tenía: `useOrganization` devolvía
`organizations[0]`, y aceptar una invitación deja a alguien en dos organizaciones —darse de alta
también funda una propia— así que el invitado aterrizaba en la suya, vacía, y la invitación parecía
no haber hecho nada. Verificado ahora de punta a punta contra la demo.

### Lo que no se cerró, y por qué

- **Publicar imágenes** necesita un registro y unas credenciales que son de quien despliega.
- **Retirar el oráculo** sigue siendo una decisión sobre el build de otro repositorio.
- **El `signUp` intermitente** no se ha vuelto a ver en decenas de corridas completas de la suite.
  No se declara arreglado: no se ha reproducido, que no es lo mismo.

Suites: runner-core **104** · spec-import 35 · api **195** · api/Postgres **21** · web **48**.

## Entornos, pruebas reutilizables y flujos · cerrada

La matriz que un contrato declara se genera sola. Lo que un contrato nunca dice es «crea esto y
vuelve a leer lo que te devolvió», y hasta aquí no había forma de escribirlo: ni variables por
entorno, ni una petición guardada, ni un orden entre dos de ellas.

### Filas, y no una novena sección de configuración

El primer intento las guardaba como una sección más de `project_config`. Se descartó por lo que una
prueba reutilizable **es**: la nombran varios flujos, editarla tiene que alcanzarlos a todos, y
«bórrala» tiene que ser una pregunta con respuesta. Dentro de un documento JSON eso son tres
recorridos a mano y ninguna garantía.

El grafo, en cambio, sí es un documento, y por el mismo razonamiento que ya estaba escrito para
`project_config`: la unidad de cambio es el grafo entero. Guardar nodos y aristas por separado
admite el estado «nodo borrado, arista apuntándolo», que no debe poder existir; y la propiedad que
de verdad importa —que no haya ciclos— no es una que Postgres pueda sostener de todos modos.

Lo que la base de datos no puede sostener lo sostiene el comando, y por eso son un 422 y un 409 al
guardar en vez de un caso rojo a las tres de la mañana: un paso que nombra una prueba inexistente
se rechaza, y borrar una prueba que algún flujo usa también. La consulta que lo comprueba mira
dentro del `jsonb` sin índice a propósito: un proyecto tiene decenas de flujos, y un índice GIN se
pagaría en cada guardado para acelerar una pregunta que solo se hace al borrar.

### Lo que apareció al escribirlo

- `walk` y `walkWorkflow` habían divergido en tres semanas de vida: un caso sin pasos era `skipped`
  en la matriz generada y `failed` en un flujo. Es una función ahora, `caseStatusFor`, y con ella se
  fueron las otras dos copias.
- Interpolar `{{variables}}` clonaba el `ProjectConfig` **entero** una vez por caso. Con 311 casos y
  cero variables eran 311 copias profundas para no sustituir nada.
- El regexp del nombre de una variable estaba escrito tres veces.
- `workflowId` se validaba al ejecutar. Una corrida encolada que acaba en `error` pone el mensaje a
  minutos del clic que lo causó; ahora es un 422 nombrando el campo.

### El editor no se probó hasta que se abrió

Los nodos no se podían arrastrar: faltaba `onNodesChange`. Y al añadirlo seguían sin verse, con
`visibility: hidden`, porque React Flow guarda de cada nodo lo que **midió** y reconstruir el array
desde el documento en cada render tiraba esa medida. Ninguna prueba lo habría cazado: es un
contrato entre dos estados, no una función.

Lo que sí se prueba, y sin renderizar nada, es la lógica de grafo — borrar un nodo se lleva sus
aristas, conectar es idempotente, un ciclo se nombra antes de guardar —, siguiendo el patrón que ya
seguía `config-draft.ts`. Doce pruebas, sin `@testing-library/react`.

### Lo que el repo no tenía

Ni linter, ni formateador, ni CI. `pnpm lint` en la raíz era `pnpm -r lint` y ningún paquete
declaraba ese script: pasaba en verde sin ejecutar una regla. Ahora hay ESLint con las reglas de
capas que el plan de arquitectura prometía —`domain/` no importa TypeORM, `packages/` no importa
framework—, Prettier a 120 columnas en un commit de solo formato con su `.git-blame-ignore-revs`, y
un CI con Postgres de servicio para que `test:db` no se salte: sin `EQ_TEST_DATABASE_URL` esa suite
no falla, se salta, y un CI que informa verde sin haber aplicado una migración es exactamente el
fallo que este producto existe para detectar.

Suites: runner-core **116** · spec-import 35 · api **206** · api/Postgres **22** · web **65**.

### Lo que queda

- La suite de la API es **intermitente**: en cinco ejecuciones completas dos fallaron, cada vez en
  un test distinto y ninguna reproducible. Coincide con el `signUp` intermitente que ya estaba
  anotado y sigue sin reproducirse a propósito.

## Lo que se trajo del analizador de seguridad

Dos repos de referencia —`security-analyzer` y su front— y una pregunta: qué tienen ellos que aquí
falte, en pruebas, flujos y variables de entorno.

**En pruebas, nada.** Los dos repos tienen cero ficheros de test. El back trae `jest` configurado
en `package.json` con su `testRegex` y ni un solo `.spec.ts`; el front no declara ni el script.
Aquí ya había `node --test` con dobles en memoria, vitest, la matriz dorada, la paridad contra el
dashboard acoplado y un CI con Postgres de servicio. No había nada que aplicar, y decirlo es parte
del análisis: la comparación honesta es la que también informa de las casillas en las que el otro
proyecto está detrás.

**En variables de proceso, tampoco.** Allí `process.env` en crudo; aquí un esquema de zod validado
al arrancar. Lo que sí faltaba era la otra cosa que se llama igual: las variables _del producto_.

### Una variable pasa a tener tres campos

`{ initial, current, sensitive }`. Los dos primeros son el par de Postman y existen porque depurar
con un token de usar y tirar reescribía lo que se lleva el siguiente que clona el proyecto. El
tercero decide tres cosas a la vez: AES-256-GCM en la columna, ocho puntos en la respuesta, y esos
ocho puntos volviendo en un `PATCH` significan «déjalo como estaba».

Lo último es la parte que la implementación evidente hace mal, y el repo de referencia la hace mal:
su `update` cifra lo que le llegue, máscara incluida, así que guardar el formulario sin tocar el
secreto lo convierte en `••••••••` y la corrida empieza a presentar ocho puntos como token. Aquí la
máscara es un centinela, y destaparla es su propia petición con rol `admin` en vez de un
`?reveal=true` sobre la lista: un parámetro en la lista deja la lectura ordinaria y la sensible en
la misma línea de un registro.

### Un paso deja de ser solo una petición

El motor comprobaba lo que se le puede exigir a un contrato. Un paso ahora afirma además lo suyo
—doce operadores sobre estado, cuerpo, cabecera o duración—, se reintenta con espera y factor
acotables por estado, y dice qué pasa si falla: saltar lo que dependa, continuar, o detener el
flujo. Y puede esperar antes, condicionarse sobre lo que contestó otro paso, o recorrer una lista
que otro devolvió, un caso por elemento.

Tres decisiones que no se copiaron:

- **No hay tipos de nodo.** Allí `condition`, `loop` y `delay` son nodos; aquí son propiedades del
  paso. Todo lo que una corrida registra es sobre una petición que se hizo, y un nodo de condición
  —que no la tiene— sería una fila de `run_cases` que significa otra cosa que el resto de la tabla.
- **No hay nodo `script`.** Su sandbox es `node:vm`, que no es un límite de seguridad: ejecutar ahí
  código de quien usa el producto es una fuga conocida a `process` por los constructores de
  cualquier objeto que se filtre. Si se mete, va en un proceso aparte con límites, no en
  `runInContext`.
- **Las comprobaciones que pasan salen en el informe.** Una comprobación que desaparece cuando
  acierta es una comprobación que nadie puede decir que se ejecutó, que es el mismo fallo que un
  tic verde que no afirma nada.

`Assertion` gana `severity`, y con ella la deriva: los campos que una respuesta trae y su propio
documento no declara se informan como aviso. `additionalProperties: false` es lo que convierte «no
declarado» en «prohibido», y eso lo decide el esquema, no el motor. `holds()` es el único sitio que
decide qué cuenta como pasar, porque los cuatro que lo decidían por su cuenta tenían que ponerse de
acuerdo el día que apareció el primer aviso.

### Datos y suites

Un flujo se recorre una vez por fila de un conjunto de datos, y varios flujos se encadenan en una
suite con un solo veredicto. El anidamiento decide qué comparte con qué: una fila es un recorrido
independiente —las variables vuelven a las del entorno— y los flujos dentro de una fila sí las
comparten, porque una suite cuyo primer flujo inicia sesión y cuyos ocho siguientes la gastan es
justo para lo que existen.

Las listas van en `jsonb` y no en tablas de filas, por el mismo motivo por el que el flujo guarda
su grafo en una columna: lo que cambia es la lista entera. Lo que cuesta es la cascada —borrar un
flujo que una suite nombra es 409— que es la respuesta que este producto ya daba en cualquier otro
sitio donde existiera una referencia.

Suites: runner-core **132** · spec-import 35 · api **233** · api/Postgres 22 · web **80**.

### Lo que queda

- La intermitencia de la suite de la API **sigue ahí y no la trajo esto**: en el árbol limpio, sin
  ningún cambio, una de cada cinco ejecuciones falla. Los síntomas cambian —un 404 en `/scenarios`,
  un 401 al crear un proyecto, un 400 al importar el contrato— y ninguno reproduce en solitario.
- La interfaz de todo esto está comprobada por tipos y por las funciones puras que la sostienen,
  pero **no se ha abierto en un navegador**.

## Cerrar la lista

Lo que quedaba después de traer el analizador, hecho de una vez. Dos trabajos en
paralelo —el CSV y el intermitente— y el resto en serie, porque se pisaban en el
orquestador y en el contrato.

### El intermitente no era el throttler, era el puerto

La suite fallaba una de cada tres, cada vez en otro test, y nunca en solitario.
La causa resultó no tener nada que ver con el producto: `createTestApp`
terminaba en `app.init()` y dejaba el servidor **sin escuchar**. Supertest,
cuando recibe un servidor sin dirección, abre uno por CADA petición con
`listen(0)`… que sin host bindea el comodín **IPv6** `::`, mientras supertest
compone la URL contra el literal `127.0.0.1`. Dos direcciones distintas, así que
el kernel reparte un puerto efímero en `::` sin saber que otro proceso ya tiene
ese número en IPv4.

Cuando coincidían, la petición se iba a un extraño y volvía con lo que ese
extraño contestara: un 404 pelado, un 401 con `{"error":"Unauthorized"}`, un 400
diciendo «WebSockets request was expected» —un servidor de desarrollo ajeno de la
propia máquina—. 889 binds al comodín en una sola ejecución.

Explica las tres cosas que no encajaban: por qué los síntomas cambiaban, por qué
nada reproducía solo, y por qué los cuerpos venían vacíos o eran de otra
aplicación. Escuchar una vez en `127.0.0.1` lo cierra, y `harness.test.ts`
afirma esa decisión porque nada más en la suite notaría que alguien vuelve a
`init()`: el fallo se parecía a una suite verde cuatro veces de cada cinco.

### Paralelismo, y dónde se comprueba que es seguro

El recorrido pasa de ser un bucle sobre el orden topológico a estar guiado por lo
que está listo. Con `concurrency: 1` se comporta exactamente igual que antes, que
es la propiedad que permitió cambiarlo sin tocar una sola prueba de las 244 que
ya había.

La decisión que importa no es el planificador, es **dónde se comprueba que
paralelizar no rompe nada**. Las variables de una corrida son un solo mapa y dos
pasos sin camino entre ellos no tienen orden, así que dos que puedan coincidir no
pueden capturar el mismo nombre, y el que obtiene una sesión es una barrera. Se
rechaza **al guardar el flujo**: si dependiera del número de concurrencia, un
flujo correcto hoy sería una carrera el día que alguien lo suba, sin haberlo
tocado.

Lo que queda fuera a propósito: las vueltas de un bucle siguen en serie. Cada una
ata el mismo nombre en el mismo mapa, y paralelizarlas pide darle a cada vuelta
su propio ámbito de variables.

### Lo demás

- **De quién es el fallo.** Ocho clases en `run_cases.failure`, leídas de las
  aserciones para que no puedan contradecirlas. El orden es donde están las
  decisiones: un 5xx lo es aunque además traiga el cuerpo mal, y el presupuesto
  va el último porque una respuesta lenta _y_ rota es una respuesta rota.
- **Capturas por cookie y por expresión regular**, compartidas con el paso que
  publica la sesión: «dónde está el valor» es una sola pregunta.
- **CSV pegado** en los conjuntos de datos, con el separador contado en la
  cabecera y comillas RFC 4180 de verdad. Una fila descuadrada es un error y no
  algo que rellenar: las dos reparaciones son silenciosas y las dos son una
  conjetura.
- **A dónde se fueron los milisegundos**: DNS, espera del destino y descarga.
  `connect` y `tls` no están a propósito — sacarlos de `fetch` es atarse a las
  tripas de `undici` para partir un número que luego hay que mantener honesto.
- **Un aviso mientras se reintenta**, que es lo único que una corrida hace que
  tarda y no produce nada que mirar.

Suites: runner-core **150** · spec-import 35 · api **253** · api/Postgres 22 ·
web **97**.

### Lo que queda

- La interfaz de lo último —paralelismo, clasificación del fallo, CSV— está
  comprobada por tipos y por sus funciones puras; la de las tajadas anteriores sí
  se abrió en un navegador.
- Las vueltas de un bucle, en serie, por lo dicho arriba.
- El módulo de rendimiento del analizador (planes, ventanas, comparativas) sigue
  sin traerse: nunca entró en el alcance.

## Una colección de Postman, en el proyecto

Lo que la gente tiene de verdad no es un OpenAPI: es la colección de Postman que
ya usa. Traerla entera, y no a trozos, es lo que hace esta tajada — y son dos
cosas distintas dentro del mismo fichero.

### Las URL son endpoints; los tests son un flujo

El importador de ficheros de endpoints ya leía Postman v2.1. Lo que faltaba era
la otra mitad, la que nadie puede volver a teclear: **el orden de la carpeta, el
`{{id}}` que pasa de un paso al siguiente y lo que cada respuesta tiene que
cumplir**. Eso, en Postman, solo se puede decir como scripts.

El reparto es estrecho a propósito:

- **Una carpeta de primer nivel es un flujo**, y lo que está en la raíz de la
  colección es uno más. Es la única agrupación que el formato ofrece; agrupar por
  cualquier otra cosa sería este importador decidiendo cuál es el escenario de
  alguien.
- **El orden son las aristas.** El runner de Postman recorre una carpeta de
  arriba abajo, así que cada nodo depende del anterior. Una cadena y no un
  abanico: dos peticiones sin arista entre ellas podrían correr a la vez, que no
  es lo que la colección hacía.
- **Una petición que el contrato declara es un nodo de petición guardada; una que
  no, un nodo `fetch` con su llamada escrita.** No se inventa una operación, que
  es la propiedad sobre la que se apoya todo el producto. Y el nodo `fetch`
  existe justo para esto: la llamada que el contrato no describe.
- **Crear o actualizar, por nombre.** Importar la misma colección dos veces es el
  caso ordinario —cambió un test, la carpeta ganó un paso— y «Pedidos (copia 2)»
  dejaría a alguien averiguando cuál de tres es el vivo. Lo que no se toca es el
  estado del flujo ni sus conjuntos de datos: esas decisiones se tomaron aquí y
  no en Postman.

### El traductor de scripts se rinde entero, o no se rinde

Un `test` de Postman se lee como comprobaciones y capturas del nodo cuando se
entiende, y **se guarda tal cual en un nodo `script` cuando no**. Lo primero es
mejor porque una comprobación se lee en el inspector, se edita sin escribir
código y sale nombrada una por una en el informe, mientras un nodo script
enseñaría una línea verde.

Lo que ordena el resto: **no hay traducción a medias**. Esto no es un intérprete
de JavaScript, y traducir la mitad de un `pm.test` callando lo que no se supo
leer dejaría un flujo verde sobre una respuesta que nadie comprobó. Así que basta
una sentencia que no se entienda —un `for`, un `to.be.empty` sin inverso, un
`pm.environment.set` del cuerpo entero— para que el script entero se conserve y
lo ejecute el sandbox con su API `pm`, que ya existía.

Dos decisiones más, pequeñas y con consecuencia:

- **El nodo destino de un `test` es un `script` y no un `validate`.** Solo el
  primero escribe variables de la corrida, que es la mitad de lo que un test de
  Postman hace: `pm.environment.set("id", …)` es lo que el paso siguiente gasta.
- **El estado que afirma el test sale de las comprobaciones** y pasa a ser lo que
  el nodo espera. El estado ya _es_ la aserción principal de un caso en este
  producto; dejarlo en los dos sitios nombraría la misma afirmación dos veces y
  permitiría que se contradijeran.

Una credencial escrita a mano en una cabecera se cae y el nodo presenta la sesión
de la corrida; `Bearer {{token}}` se queda, porque dice dónde está el secreto en
vez de ser uno.

Suites: api **+33** (27 unitarias del lector y del traductor, 6 HTTP de las dos
importaciones contra la API de verdad).

### Pasarle una colección de verdad, y arreglar lo que se rompió

Una colección generada de un proyecto real —53 peticiones, 54 scripts, cinco
carpetas— entró entera: 5 flujos, ninguna petición ilegible. Pero **37 de los 53
tests se conservaban como script, y de esos casi todos reventaban dentro del
sandbox con un `TypeError` en la primera línea**. Un rojo que no habla del
destino es peor que no importar: nadie puede distinguirlo de un fallo de verdad.

Lo que faltaba no era exótico; es lo que escribe cualquiera que haya escrito
tests en Postman:

- **`pm.collectionVariables` y `pm.globals`**, que no existían. Son el almacén
  con el que una colección pasa un id de un paso al siguiente. Aquí son
  `pm.variables` —una corrida tiene **un** mapa plano de variables, que es por lo
  que `{{nombre}}` resuelve igual en todas partes— y no `pm.environment`, a
  propósito: en un script de endpoint `pm.environment.set` **persiste** en el
  entorno guardado, y una variable de colección nunca estuvo ahí.
- **`to.have.all.keys` / `to.have.any.keys`**, que es como se afirma un sobre.
  `all` y `any` no pueden ser palabras de adorno: con `all` sobrar una clave es un
  fallo, y tratarlas como ruido convertiría una afirmación en la otra.
- **`pm.response.headers.get("Content-Type")`**, porque el de Postman es una
  `HeaderList` con método y el de aquí era un objeto pelado. Ahora responde por
  las dos vías.
- **`pm.request.url.query`**: la URL sigue siendo su texto —se interpola, se
  registra y se compara como tal— y además trae la query parseada, que es lo que
  lee la aserción «`links.self` devuelve los parámetros que se mandaron».

Y el lector de scripts aprendió dos formas que la colección real usaba y que se
perdían enteras: **un nombre atado a una parte del cuerpo** (`const data =
pm.response.json().data`, que leído como la raíz dejaba todo un nivel desplazado)
y **un literal de lista u objeto** (`to.eql([])`).

Resultado sobre la misma colección: de 16 a **21 tests traducidos** a
comprobaciones —de 12 a 22 comprobaciones y de 5 a 7 capturas— y, lo que
importaba, **los 54 scripts corren en el sandbox sin que falte una sola API**.

Los 32 que siguen guardándose como script lo hacen por dos razones que son la
respuesta correcta: 18 afirman el sobre con `to.have.all.keys` —para lo que no
hay operador declarativo, y el sobre ya lo comprueba la sección `envelope`— y 12
recorren la lista con `.map()`, que es código y no una afirmación.

### Lo que queda

- Los scripts de **nivel colección** —los que Postman ejecuta alrededor de cada
  petición— no se importan: copiarlos en cada nodo enterraría cada flujo bajo las
  mismas cuarenta líneas. Se avisa en el resultado.
- El bloque `auth` de una petición o de una colección tampoco: la credencial es
  del entorno, y eso no cambia.
- Un `{{id}}` en la ruta no se reconoce como parámetro de ruta, así que
  `GET /things/{{thingId}}` y `GET /things/{id}` entran como dos endpoints
  distintos hasta que alguien lo edite.

## Una sola puerta, como la de Postman

El panel de la tajada anterior pedía marcar casillas: «las URL como endpoints»,
«los tests como flujos». Es pedirle a alguien que conteste una pregunta que el
fichero ya contesta, y estaba enterrado en los ajustes del proyecto, que es donde
nadie lo busca.

Así que se miró cómo lo hace Postman —una puerta, `Import`, arriba de la barra— y
se copió la forma, no la pantalla.

### Lo que se reconoce, y por el contenido

Nada pregunta qué es un fichero: se decide mirándolo. **Por contenido y nunca por
el nombre**, porque lo que baja Postman se llama como le da la gana y
`Catalog-API.json` es igual de probable que sea una colección o un entorno.

| Se reconoce                         | Va a                  |
| ----------------------------------- | --------------------- |
| Colección de Postman v2.1           | endpoints y flujos    |
| Entorno o globals de Postman        | un entorno            |
| **Volcado** de Postman (todo junto) | cada pieza a su sitio |
| OpenAPI 3.x, JSON o YAML            | el contrato           |
| Exportación de Insomnia v4          | endpoints             |
| Comandos cURL                       | endpoints             |

Un **volcado estalla en sus piezas**: «Export data» produce un fichero con todas
las colecciones y todos los entornos dentro, que es como se mueve un equipo
entero, y se lee como las varias cosas que es. Se mira **antes que nada**, porque
contiene las otras formas: buscar `item` primero leería el volcado como su
primera colección y perdería el resto sin que nadie lo notara.

Lo que no se puede leer se dice con algo que hacer, no con «no se reconoce». Una
colección v1 contesta lo mismo que contesta Postman —«expórtala como v2.1»— y un
HAR dice que todavía no. Y **un fallo no hunde el lote**: cuatro ficheros donde
el segundo es una v1 importa los otros tres.

### Primero el plan, luego el import

La mitad que faltaba. Se pregunta al servidor **en seco** —`dryRun`, no escribe
nada— y lo que vuelve es la lista: «esto es una colección → endpoints y flujos»,
«esto es un entorno → un entorno», «esto es una v1 → expórtala como v2.1». Luego
se confirma. Un import que se puede leer antes de confirmarlo es uno que nadie
tiene que deshacer.

Tres vías de entrada, las mismas tres que importan aquí: ficheros —arrastrando o
eligiendo, varios a la vez— texto pegado, y una URL, que se lee por el mismo
guard SSRF que cualquier otra petición saliente. La cuarta de Postman, un
repositorio, ya es otra cosa en este producto: el Escáner.

### El orden no es incidental

El contrato entra **antes** que la colección aunque lleguen en el mismo lote.
Tener contrato o no decide si las peticiones de la colección caen sobre sus
operaciones o entran como llamadas sueltas, así que los mismos dos ficheros en el
otro orden darían un flujo distinto. Después los entornos, que es lo que los
flujos necesitarán para correr. Después las colecciones.

Medido sobre la colección real del catálogo, con su contrato y su entorno en el
mismo lote: **7 flujos, 63 nodos de petición guardada y 1 solo `fetch`**. Sin el
orden, los 64 habrían sido llamadas sueltas.

El router no lee ningún formato: cada uno lo entendía ya el módulo dueño de su
destino —el contrato `specs`, los endpoints `endpoints`, los grafos `workflows`,
las variables `environments`— y volver a leerlo aquí sería un segundo parser
libre de discrepar del primero.

Suites: api **+24** sobre la tajada anterior (10 del detector, 4 HTTP de la puerta
única, 10 del lector de entornos).

## Una puerta de verdad: contarlas, y bajar de seis a una

La tajada anterior escribió la puerta única y no quitó las demás. Quedaban
**seis**, y eso era el problema entero:

| Dónde                    | Qué leía                      | Qué escribía                  |
| ------------------------ | ----------------------------- | ----------------------------- |
| Barra del proyecto       | todo                          | todo                          |
| Página de Endpoints      | un fichero, o un cURL         | **sólo endpoints**            |
| Cajón de flujos          | un proyecto exportado de aquí | **sólo los flujos de dentro** |
| Biblioteca de peticiones | una colección de Postman      | **sólo peticiones**           |
| Ajustes → contrato       | un OpenAPI, por URL o pegado  | el contrato                   |
| Ajustes → por elementos  | otro proyecto                 | lo elegido                    |

La de la barra era la buena y era la invisible: un botón fantasma de 11 píxeles
debajo del nombre del proyecto, que además no existe en la lista de proyectos. La
prominente era la de Endpoints, justo donde se mira — y soltarle la colección de
Postman daba sus URL, **ningún flujo, ningún entorno, y ni una palabra sobre lo
que había tirado**. «Los imports no funcionan como Postman» era literalmente eso.

Ahora hay una, y está donde Postman la tiene: arriba en la cabecera, con borde y
no fantasma, en todas las pantallas, dentro de un proyecto o fuera de él. Fuera
pregunta a cuál va, que es lo que hace Postman con el workspace. Con **Cmd+O**, el
mismo atajo. Y soltar un fichero en cualquier parte de la ventana la abre con él
dentro, que es la diferencia entre «¿dónde se importa esto?» y soltarlo.

Las tres puertas que leían un subconjunto se han borrado y sus botones llaman a
la única. El formato que sólo leía el cajón de flujos —un proyecto exportado de
aquí— lo reconoce ahora el detector, así que se puede soltar con el resto. Las dos
de los ajustes se quedan: una es la _fuente_ del contrato, que se relee luego con
su cabecera guardada, y la otra es copiar de otro proyecto, que no es un fichero.

### El detector, en un paquete, porque la respuesta tiene que ser la misma

`@eq/import-detect`. Puro, sin dependencias, ESM y CJS, importado por el
navegador y por la API.

Antes había que pulsar «Continuar», esperar un viaje de red y luego «Importar»,
para que el servidor contestara lo que el fichero dice en su primera línea. Ahora
la lista aparece **mientras sueltas** y el import es **un botón**. Dos copias de
esa función serían dos copias libres de discrepar, y la discrepancia se vería como
un diálogo prometiendo una cosa y un import haciendo otra; `targetsOf` se exporta
por lo mismo, para que la línea «va a endpoints, flujos» y el enrutado del
servidor sean la misma función y no dos tablas.

De paso, lo que el detector no sabía y la gente tiene: un `.zip` —que es lo que
baja «Export data» de Postman— se reconoce por sus bytes mágicos y manda a
descomprimirlo; una lista en la raíz se dice como lista; y cada pieza se cuenta,
porque «una colección» no dice si trae tres peticiones o sesenta y esa es justo la
pregunta de quien está mirando.

### Tres cosas que sólo aparecen al probarlo

**Un proyecto exportado se leía como un volcado de Postman.** El volcado se mira
antes que todo lo demás porque contiene las otras formas dentro; un proyecto
exportado trae un `environments`, así que caía en esa trampa. Ahora el marcador
explícito se mira primero. Lo encontró la prueba HTTP, no la lectura.

**El botón de la cabecera no hacía nada.** El provider envolvía el `Outlet` y no
la cabecera, así que el botón se montaba fuera del contexto y recibía el no-op por
defecto: ni un error en la consola. Arreglado, y `useImport` revienta fuera del
provider en vez de devolver un no-op, que es lo que escondió el fallo.

**«46 sin importar».** Importar una colección sobre su propio contrato deja casi
todo repetido, y ese número mandaba a buscar un problema que no existe. Ahora «ya
estaban» y «sin importar» se cuentan aparte.

Y un cuarto que no era del import: un id de proyecto inexistente llegaba a los
cuatro manejadores y volvía como cuatro mensajes de Postgres dentro de un 201, que
se lee como «el import funcionó pero todo falló». Un guardia antes de leer nada.

Suites: paquete nuevo **19**, api **592**, web **339**.

## Los dos huecos que quedaban: el `.zip` y la vuelta

Contadas las diferencias con Postman, quedaban dos que pesaban.

### El `.zip`, que es lo que de verdad baja «Export data»

No baja un JSON: baja un zip con todas las colecciones y todos los entornos
dentro. Decirle a alguien «descomprímelo y suéltalos» era mandarle a hacer a mano
el trabajo que el formato existe para evitar.

Se abre en el navegador, antes de que nada cruce la red, y por una razón que no es
de gusto: lo que viaja es texto, y un zip metido en un JSON como si fuera texto
llega con los bytes ya estropeados. Abrirlo antes deja además todo lo demás igual
—el detector, el plan, el import siguen viendo ficheros sueltos— y el arrastre
global usa el mismo lector, así que soltar el zip en cualquier parte de la ventana
hace lo que hace elegirlo dentro del diálogo.

**Sin dependencia nueva, y tampoco por ahorrar.** El detector es una función pura
que corre en los dos lados; meterle un paquete de terceros lo mete en el bundle
del navegador _y_ en el proceso que lee ficheros que sube un desconocido. Lo que
hace falta está en la plataforma —`DecompressionStream("deflate-raw")`, en el
navegador y en Node— y el resto son cuatro cabeceras con desplazamientos. Se lee
por el **directorio central** y no recorriendo cabeceras locales de frente, que es
lo que dice la especificación y lo único correcto: una cabecera local puede
declarar tamaño cero y remitir a un descriptor que va después de los datos.

De un zip no sale nada que no sea texto, nada fuera de su propio árbol —una entrada
llamada `../../etc/algo` se enseña por su última parte— y nada por encima de los
topes, que es lo que separa «este fichero no vale» de que se caiga el proceso.

Probado contra dos zips: uno escrito en la propia prueba, para meterle a mano las
entradas raras que traen los de verdad —carpetas, `__MACOSX`, una entrada sin
comprimir— y otro hecho por el `zip` del sistema, que es lo único que descarta que
el lector y el escritor de la prueba estén equivocados de la misma manera. Y sobre
el zip real del catálogo: **61 peticiones · 6 carpetas y tres entornos**, abiertos
y reconocidos sin tocar el servidor.

### Y la vuelta, porque era una puerta de un solo sentido

Se leía una colección y no se escribía ninguna. Un formato que se lee y no se
escribe es un formato en el que nadie mete su trabajo: no podías llevártelo, ni
pasarlo por `newman` en un pipeline, ni dárselo a quien no use esto.

Es **el inverso exacto** del lector, y por eso vive a su lado: lo que el lector
saca de un `event` de tipo `test` —las comprobaciones y las capturas— es lo que
esto vuelve a escribir como `pm.test` y `pm.collectionVariables.set`. Un nodo
script vuelve al sitio del que salió: con `from` puesto es el `test` de esa
petición, sin él es el `prerequest` de la siguiente.

No lee la base de datos. Pide la exportación propia —que ya existe, con sus
permisos y sus reglas sobre qué secretos no viajan— y traduce lo que vuelve. Leerla
otra vez aquí sería un segundo lector libre de discrepar del primero sobre qué sale
de un proyecto, y esa discrepancia sería un secreto dentro de un fichero.

**Ningún secreto sale**, con las mismas reglas que el import aplica al entrar: una
variable sensible sale con su nombre, sin valor y marcada `secret`; una cabecera de
credencial sale solo si su valor es enteramente `{{variables}}`, y si trae un token
escrito a mano sale desactivada y vacía. **Y lo que Postman no puede expresar no se
tira en silencio**: no hay ramas, ni esperas, ni bucles, así que esos nodos se
cuentan y se enseñan. Un fichero que parece completo y ha perdido la mitad del
grafo es peor que no poder exportar.

#### Dos ficheros, no un ajuste

Los flujos y los endpoints estaban en la misma colección, y la prueba de ida y
vuelta lo cazó en el primer intento: **cada ciclo añadía un flujo llamado
«Endpoints» que nadie había escrito**. No es un detalle de presentación — al volver
a entrar, una colección _es_ un flujo, porque eso es lo que una colección
significa aquí. Así que son dos exportaciones distintas: la de los flujos, que da
la vuelta sobre sí misma, y la del API entero, que es lo que quiere quien pide
«pásame esto a Postman» sin haber escrito un flujo todavía.

Y un aviso que sobraba: los entornos se traducían siempre, así que una colección
—que no lleva ninguna variable— salía llena de «la variable X es sensible y sale sin
valor». Avisar de algo que no está pasando. Ahora solo los traduce el fichero que
los lleva.

#### Lo que cierra el círculo

Sobre la colección real del catálogo, exportada y vuelta a importar en un proyecto
nuevo: **8 flujos, 100 nodos, idénticos a la salida, 0 fuera del fichero**. Es la
única prueba que dice que las dos mitades no se han separado, porque exportar e
importar son la misma afirmación leída en dos direcciones.

Suites: `@eq/import-detect` **25**, api **615**, web **339**.

## Paridad con Postman, ola 1: la autenticación, que era el agujero más grande

«Revisa toda la funcionalidad de Postman y clona todas las funcionalidades». La revisión primero,
porque decidió el orden: repasar la superficie de Postman contra lo que hay aquí, comprobando en el
código y no de memoria. Lo que salió, con lo que ya existía marcado como tal:

| Postman                                                       | Aquí, antes de esta ola                         |
| ------------------------------------------------------------- | ----------------------------------------------- |
| Petición suelta con params/headers/body/scripts               | Sí: el editor de endpoints, con `Enviar`        |
| Colecciones, carpetas, orden                                  | Sí: endpoints y flujos                          |
| Entornos y variables, sensibles                               | Sí, y además cifradas en columna                |
| Runner con iteraciones y ficheros de datos                    | Sí: datasets y suites                           |
| Tests `pm.*` en un sandbox                                    | Sí, en un proceso aparte                        |
| Import de colección/entorno/volcado/OpenAPI/Insomnia/cURL/HAR | Sí, por una puerta                              |
| Export en formato Postman                                     | Sí (ola anterior)                               |
| **13 tipos de autenticación**                                 | **No: heredar, ninguna, y un `Bearer` a mano**  |
| Cookie jar por dominio                                        | No                                              |
| Botón «Code»: la petición en 20 lenguajes                     | No: solo cURL                                   |
| Ejemplos guardados de respuesta                               | No                                              |
| Mock server sirviendo esos ejemplos                           | Parcial: nodo `mock` en un flujo                |
| Monitores con horario                                         | No                                              |
| Visualizer (`pm.visualizer.set`)                              | No                                              |
| WebSocket, gRPC, MQTT, GraphQL                                | Solo GraphQL                                    |
| Documentación publicable                                      | No                                              |
| Workspaces, forks y merge                                     | Parcial: organizaciones y copia entre proyectos |
| Proxy/Interceptor para capturar tráfico                       | No                                              |
| Consola de peticiones                                         | Parcial: el eco de `Enviar`                     |

El primero de la lista no era el más llamativo: era el que dejaba el resto sin servir. El bloque
`auth` de un fichero de Postman **se tiraba entero y sin decirlo** — cero referencias en el lector —
y una colección real no lleva su autenticación en cada petición, la lleva **en la colección** y las
peticiones la heredan. Importar una colección así traía las URL y dejaba todas las peticiones
contestando 401 sin que nada en la pantalla dijera por qué.

### Las firmas, contra el vector publicado de cada especificación

`packages/runner-core/src/auth.ts`: una función pura que recibe un descriptor y una petición y
devuelve cabeceras y parámetros. Los trece tipos, con los algoritmos de verdad — Digest (RFC 7616,
MD5/SHA-256/SHA-512-256 y sus variantes `-sess`), OAuth 1.0a (RFC 5849), AWS Signature v4, Hawk,
Akamai EdgeGrid, JWT firmado en el momento (HS/RS/PS), OAuth 2.0, Basic, Bearer y clave de API.

Cada uno se comprueba contra **el ejemplo de su propia documentación**, que es lo único que
distingue firmar de producir una cadena con pinta de firma: la respuesta a una firma mal calculada
es un 403 idéntico al de una credencial caducada, y nadie mira dentro de la cabecera. `get-vanilla`
y `get-vanilla-query-order-key` de la suite de AWS, la respuesta `8ca523f5…` del RFC de Digest y su
variante SHA-256, el mac `6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE=` del README de Hawk, el token
canónico de HS256, y la cadena base del RFC 5849 byte a byte.

Esa última hizo falta exportar (`oauth1BaseString`) en vez de comparar una firma: escribí la
constante de memoria, no coincidió, y al calcularla aparte resultó que la cadena base **sí** era la
publicada y la constante era mía. Lo comprobable desde fuera es la cadena; el HMAC lo calcula la
plataforma.

Dos cosas se dicen en vez de fingirse:

- **NTLM** no es una firma, es un protocolo de tres vueltas negociando por `Authorization`. Se
  reconoce y se explica.
- **Digest** no se puede firmar a ciegas: el `nonce` lo pone el servidor en su 401. El firmante
  devuelve `needsChallenge`, quien tiene la red pide ese 401 y se firma con su reto.

### Dónde entra, y qué no se guarda

El bloque se lee con su **herencia** resuelta —la petición manda sobre la carpeta, la carpeta sobre
la colección, y `noauth` es «esta no, aunque las de arriba sí», que no es lo mismo que no tener
bloque—, entra en el endpoint (columna nueva `auth`, `jsonb`, las filas de antes en `inherit`), en el
nodo `fetch` de un flujo, en el botón de enviar, en el `curl` que se copia, y sale otra vez al
fichero de Postman.

**Ningún secreto literal se guarda.** La columna es `jsonb`, y una contraseña ahí es una contraseña
en claro en la base de datos — lo que la tabla de credenciales y las variables sensibles existen
para evitar. Un valor que es solo `{{variables}}` sí se queda: eso no es el secreto, es el nombre
del sitio donde está, y ese sitio sí lo cifra. Lo que se cae se **nombra**, en el campo mientras se
escribe y en la lista del import, con la frase que dice qué hacer.

Un secreto vaciado conserva su clave vacía a propósito. Un campo de texto en blanco no: no es nada.
Ese vacío del secreto es la marca de que la credencial existe y no está aquí, y es lo que hace que
quien abra el fichero exportado vea qué le falta en vez de una petición que parece no necesitar
nada.

Y `-u usuario:clave` de un `curl` pegado ya no se tira: entra como `basic` con el usuario puesto y
la contraseña fuera. Antes se perdían los dos.

### Medido

Sobre el stack desplegado, con una colección cuya autenticación está arriba:

```
GET /firmado :: awsv4 {"region":"eu-west-1","service":"execute-api","accessKey":"AKIDEXAMPLE","secretKey":"{{awsSecret}}"}
GET /basico  :: basic {"password":"","username":"ana"}
export: 200 · fuera: 0 · ambas vuelven con su bloque auth
```

Y en la petición enviada de verdad, vista en el destino: `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/…`
con `SignedHeaders=host;x-amz-date`, el `Basic` con su base64, la clave de API en la query y no en
una cabecera, y NTLM diciendo que no sin mandar media negociación.

`runner-core 284 · api 642 · web 347 · lint 0 errores · typecheck limpio`

La UI de esta ola no se recorrió en un navegador: está cubierta por nueve pruebas del editor y por
las de extremo a extremo contra la API. El resto de la tabla sigue pendiente, en ese orden.

## Paridad con Postman, ola 2: el tarro de cookies

El segundo de la lista, y como el primero: no era el más llamativo, era el que dejaba una clase
entera de API sin poder probarse. Una API que autentica con cookie no se podía recorrer de punta a
punta. El login contestaba su `Set-Cookie`, la petición siguiente salía sin él, y todo lo que iba
detrás contestaba 401; la única salida era capturar la cookie con un script y volver a pegarla en
una cabecera a mano, que es justo el trabajo que un cliente HTTP existe para no hacer.

### Tres cosas que había que arreglar antes de poder guardar una cookie

Ninguna se veía. Las tres se encontraron al escribir el lector, no al usarlo.

1. **`Object.fromEntries(headers.entries())` se queda con la última `Set-Cookie`.** `entries()`
   devuelve una entrada por cabecera, así que con dos cookies el mapa guardaba la segunda y perdía
   la primera. Una captura `from: "cookie"` estaba leyendo una cookie que no era la que pedía. Se
   veía solo con un servidor que manda dos cabeceras de verdad: el destino de las pruebas las unía
   a mano con una coma, y esa coma tapaba el fallo. Ahora `setCookie` es la lista tal cual y
   `headers["set-cookie"]` lleva todas unidas.
2. **Un 302 tras un POST se rechazaba.** La regla era «no se reenvía una escritura», y para un 307
   o un 308 es correcta: conservan método y cuerpo, así que seguirlas repite la escritura en una
   dirección que nadie eligió. Pero un 301, 302 o 303 se sigue **como un GET sin cuerpo** —lo que
   hace cualquier navegador y lo que la RFC 9110 exige para el 303— y eso no es repetir nada: es
   leer en la dirección nueva. Sin esto, un login por cookie, que contesta 302 casi siempre, no
   llegaba nunca a su destino.
3. **Las cookies se calculan por salto, no una vez.** Una redirección puede ir a otro host o a otra
   ruta, y las cookies que le tocan son otras.

### Las reglas que dicen «no», que son casi todas

`packages/runner-core/src/cookies.ts`, puro: entra una respuesta y sale una cookie, entra una URL y
sale la cabecera. Lo que hay que acertar de la RFC 6265 es sobre todo seguridad, y ninguna de esas
reglas rompe nada visible cuando está mal — la petición sigue saliendo:

- **Un host no pone cookies para otro.** `Domain=ejemplo.com` desde `api.ejemplo.com` vale;
  `Domain=otro.com` no, y `Domain=com` tampoco. Ahí está el robo de sesión de toda la web.
- **Sin `Domain` la cookie es del host exacto**, no de sus subdominios. Es lo contrario de lo que
  parece.
- **`Secure` no viaja por http.** Con `localhost` como excepción, que es lo que hace el navegador.
- **La ruta acota, y el corte cae en una barra.** `Path=/admin` no llega a `/administracion`.
- **`Max-Age` manda sobre `Expires`** —no depende del reloj del cliente— y **cero borra**: así
  cierra sesión un servidor, y tratarlo como una cookie más deja la sesión abierta aquí después de
  haberla cerrado allí.

Lo rechazado se **nombra**. Una cookie que no se guarda porque el servidor la puso para otro
dominio es una explicación; el silencio es un 401 en la petición siguiente que nadie puede
explicar.

### Dónde vive

Una tabla por persona y proyecto, con la clave que identifica una cookie en la RFC —dominio, ruta y
nombre—, y el **valor cifrado**: una cookie de sesión es exactamente una credencial. Por persona
como el token de sesión, y por lo mismo: compartirla entre los miembros de una organización sería
darles la sesión de otro. Con `name` suelto por clave, renovar la cookie de `/admin` machacaría la
de `/`.

En la pantalla, al lado de «Enviar», donde Postman la pone: la lista con los valores tapados, «Ver»
como una llamada aparte, borrar una o vaciar el tarro, y una casilla para escribir una a mano
pegando la línea `Set-Cookie` tal cual —el formato que la gente ya tiene, copiado del inspector del
navegador, y que pasa por el **mismo lector** que las del servidor, así que las reglas son las
mismas y no una segunda versión que puede diferir—. Y en la respuesta, una pestaña que dice qué se
envió, qué guardó el servidor y qué no se guardó y por qué.

### En las corridas, con un límite deliberado

El tarro de una corrida vive lo que vive la corrida, como sus variables: dos corridas del mismo
flujo no ven la sesión de la otra. Con eso, un flujo cuyo primer paso entra y los ocho siguientes
gastan la sesión funciona **sin que nadie escriba de dónde sacar la cookie**.

Con una excepción que es la razón de ser de la mitad de las pruebas: un caso que presenta `none` o
`insufficient` está comprobando qué hace el objetivo con una credencial mala **a propósito**, y
darle la cookie de la sesión convertiría cada prueba negativa en un 200 verde que no prueba nada. Es
la misma regla que ya tenía la sesión del login, y la escribió esta vez una prueba que se puso roja.

### Medido

```
runner-core 311 · api 646 · web 354 · lint 0 errores · typecheck limpio
```

En una corrida de verdad: login sin `authorizes` y sin capturas, el paso siguiente pasa, y el caso
sin credencial sigue recibiendo su 401. Y contra el repositorio real, en una base aparte: la fila
sale cifrada (`v1.4+SRz3jQ…`), la lista tapa el valor, `reveal` lo enseña, y borrar la de `/admin`
deja la de `/`.

**Lo que se encontró de paso, y no es del cambio:** el `SECRETS_KEY` del `docker/.env` de esta
máquina es de 48 bytes y no de 32, así que en ese stack **cualquier** cifrado contesta 500 — una
variable sensible también. No hay nada cifrado guardado todavía (cero credenciales, cero sesiones),
así que se arregla generando una clave de 32 bytes.
