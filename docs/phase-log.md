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

## Paridad con Postman, ola 3: la petición como código, y un botón que sustituye a otro

El trabajo de una herramienta de peticiones acaba cuando alguien se lleva la petición **a su
servicio**. Hasta ahora la única salida era un `curl`, y de ahí a Go o a Python se pasaba
reescribiéndolo a mano. Una petición reescrita a mano es una petición que ya no reproduce lo que se
probó aquí, que es justo lo que este producto existe para evitar.

Dieciséis lenguajes: cURL, HTTPie, HTTP crudo, `fetch`, `axios`, Python `requests`, Go `net/http`,
Java `HttpClient`, C# `HttpClient`, PHP cURL, Ruby `Net::HTTP`, Rust `reqwest`, Swift `URLSession`,
Kotlin OkHttp, Dart `http` y PowerShell `Invoke-RestMethod`. El criterio para que uno entre no es
que exista, es que **sea la forma en la que la gente de ese lenguaje escribe de verdad una
petición**: por eso `net/http` y no un envoltorio, `HttpClient` y no `RestSharp`.

### El botón «cURL» ya no está

No se añadió un botón al lado: el de cURL **se borró**. Es la misma decisión que en Postman y por el
mismo motivo — cURL no es una función aparte, es _una entrada de la lista_. Dejar los dos habría
dado dos puertas a lo mismo, y la vieja, que solo sabe hacer una de las dieciséis cosas, seguiría
siendo la que se ve primero. El lenguaje elegido se recuerda: quien trabaja en Go lo va a pedir
muchas veces al día.

### Resolver la petición se hace una vez, no dieciséis

Sustituir variables, meter los parámetros en la ruta, montar la cadena de consulta, decidir qué
`Content-Type` lleva el cuerpo y qué aporta la autenticación es **donde están los errores
silenciosos**. Hacerlo dentro de cada generador serían dieciséis sitios donde equivocarse distinto,
y quince de ellos sin una prueba que lo mire. Así que hay un `SnippetRequest` —la petición ya
resuelta, sin lenguaje— y cada lenguaje es una función pura de ahí al texto.

El `curl` salió de ahí **idéntico byte a byte**: la prueba que ya existía compara la cadena
completa, y pasó sin tocarla. Es la única forma de demostrar que mover el `curl` a una lista de
dieciséis no le cambió nada. Después, `endpointCurl` se borró: sin llamadores, era una puerta
muerta, y su prueba pasa ahora por el camino nuevo.

### Las comillas, que es donde esto se rompe de verdad

Un generador de fragmentos falla de dos maneras, y la segunda es la mala:

1. El código no compila. Molesta, se ve en dos segundos, se arregla.
2. El código compila y **manda otra cosa**. Un `$` sin escapar en una cadena de PHP se convierte en
   una variable vacía. Un `#{` en Ruby ejecuta lo que haya dentro. El fragmento corre, contesta 200,
   y prueba algo distinto de lo que se probó aquí. Eso no se ve nunca.

Así que hay un escapador por familia y cada uno con su motivo: PHP y Kotlin y Dart escapan el `$`
porque interpolan; Ruby escapa la almohadilla; Rust escribe los caracteres de control con la forma
entre llaves y no con la de cuatro dígitos, que no compila; PowerShell dobla la comilla en vez de
escaparla y no toca el `$`, porque dentro de comilla simple no interpola. La barra se escapa
**antes** que nada, o se escapan las que se acaban de añadir.

### Lo que un lenguaje no puede hacer, lo dice

Una firma de AWS, de Hawk, de OAuth 1.0a o de EdgeGrid se calcula sobre la petición entera: no es
una cabecera que se pueda escribir. Un fragmento que la ponga a medias da un 403 que no explica
nada, así que sale un comentario que nombra lo que falta — y el aviso va **encima** del código, no
debajo de treinta líneas de Rust que nadie baja a leer.

Basic sí sale, y con lo que cada cliente trae de fábrica: `-u` en curl, `auth=` en requests,
`SetBasicAuth` en Go, `Credentials.basic` en Kotlin, `CURLAUTH_BASIC` en PHP. Digest lo negocian
solos únicamente curl y `requests`; los otros catorce se llevan el aviso en vez de una cabecera
inventada que el servidor rechazaría.

### Detalles que casi todos los generadores fallan

- **Go no compila con un `import` de sobra.** La lista se monta con lo que el fragmento acaba
  usando: sin cuerpo no entra `strings`, con multipart entran `bytes`, `os` y `mime/multipart`.
- **`request.Headers.Add("Content-Type", …)` lanza en C#.** Es una cabecera de contenido y va en el
  `HttpContent`. Y `using System.IO` entra solo cuando hay un fichero.
- **Un `multipart` no declara `Content-Type`:** el `boundary` lo genera el cliente, y escribirlo a
  mano rompe el cuerpo.
- **HTTPie manda `application/json` de serie,** así que escribirlo sería ruido; lo nombra cuando el
  tipo es otro.
- **El crudo cuenta el `Content-Length` en bytes, no en caracteres.** Con una «á» de datos reales
  son 108 bytes y 107 caracteres; declarar 107 corta el cuerpo.

### Dos fallos que salieron probando, no escribiendo

- **El `Basic` del crudo era un marcador.** Decía «base64 de usuario:clave», y esa entrada existe
  precisamente para poder mandar la petición por un socket: una cabecera que _describe_ el base64 no
  se puede mandar. Ahora se calcula, y el marcador queda solo para cuando hay un `{{variable}}` sin
  sustituir, donde no hay nada que calcular.
- **El aviso se colaba dentro del bloque de cabeceras del crudo.** Una línea que empieza por `#` no
  es una cabecera HTTP: mandada por un socket rompe la petición entera. En los otros quince el
  comentario viaja con el código copiado, que es lo que se quiere; aquí se queda solo en la lista
  de arriba.

### Cómo se comprobó

Once de los dieciséis pasaron por el parser o el compilador de su lenguaje: `ast.parse` de Python,
`node --check`, `php -l`, `ruby -c`, `bash -n`, `swiftc -parse` (cero errores), `rustc` (cero
errores de sintaxis; solo los de crate ausente, que es lo que un parse sin las crates puede probar)
y `javac` de verdad contra el JDK.

Y seis se mandaron **de verdad** contra un servidor que devolvía los bytes recibidos, para comparar
byte a byte: curl, `requests`, PHP, Ruby, `fetch` y el crudo por un socket con `nc`. El cuerpo de la
prueba llevaba `$`, `#{`, comillas de los dos tipos, barras, un salto de línea y un acento; los seis
entregaron el cuerpo idéntico, la cabecera con `"` y `\` intactos, y el `Basic` con el base64
correcto.

**Go, C#, Kotlin, Dart y PowerShell no se comprobaron con su toolchain:** no hay ninguno instalado
en esta máquina y no se instaló nada. Sus reglas —los `import` calculados de Go, el `Content-Type`
del contenido en C#— sí tienen prueba unitaria, pero eso no es lo mismo que un compilador y aquí se
dice en vez de dejarlo implícito.

`web 402 pruebas (48 nuevas) · api 646 · runner-core 311 · import-detect 25 · lint 0 errores · typecheck limpio`

## Paridad con Postman, ola 4: los ejemplos guardados, y dónde duerme un token

La pregunta _«qué devolvía esto la semana pasada»_ solo se respondía buceando en el historial de una
corrida. Y una colección de Postman con ejemplos entraba **perdiéndolos enteros**: el array
`response` de cada `item` no se leía en ningún sitio del repositorio.

Un ejemplo es un **par**, no una respuesta. Un 404 suelto no significa nada; un 404 junto a la
petición que lo produjo es documentación. Postman lo guarda así y es lo correcto, y además es lo
que permite las tres cosas para las que sirve: documentar el endpoint, alimentar un mock, y comparar
lo que contesta hoy contra lo que contestaba.

### Los secretos, que es la mitad del trabajo

Un ejemplo es exactamente donde una credencial se queda dormida para siempre. Se guarda una vez,
nadie la vuelve a mirar, y sale en la exportación, en la documentación y en el repositorio donde
alguien commitea el fichero. **Postman los guarda en claro.** Aquí no.

Tres capas, porque el secreto entra por tres sitios distintos:

1. **Las cabeceras de la petición.** `Authorization`, `Cookie`, una clave de API con cualquiera de
   sus quince nombres. Se van y **se nombran**: un ejemplo al que le falta la cabecera y no lo dice
   se lee como «esto funcionaba sin credencial», y alguien lo va a creer.
2. **El `Set-Cookie` de la respuesta**, que es la sesión que el servidor acababa de abrir.
3. **El cuerpo.** Esta es la difícil, porque el cuerpo _es_ el valor del ejemplo y no se puede
   tirar. Se conserva la forma —que es para lo que sirve— y se tapa el valor.

El `Content-Type` **se queda**, al contrario que en el importador de peticiones guardadas, que sí lo
tira. Allí el ejecutor lo deriva del cuerpo y uno viejo contradiría lo que de verdad se manda; aquí
es la mitad de lo que documenta una respuesta.

### Reconocer un JWT por su forma, no por el nombre del campo

El caso real que una lista de nombres no atrapa: un login devuelve el token en un campo que se llama
`data`, o `jwt`, o `t`, o directamente en la raíz del cuerpo. Así que además de los nombres se mira
la **estructura**: tres segmentos en base64url cuyo primero decodifica a un objeto con `alg` es un
JWT.

Y el riesgo simétrico, que es el que nadie prueba: **tapar de más**. `abcdefgh.ijklmnop.qrstuvwx`
tiene tres trozos y no es una credencial; `com.ejemplo.aplicacion` tampoco; `tokenCount` y
`passwordPolicy` no son secretos. Un ejemplo que ha perdido un campo que hacía falta se lee como el
contrato del endpoint, y entonces miente. Comprobar que el primer trozo decodifica es lo que separa
las dos cosas.

Un cuerpo que no es JSON **se deja tal cual y se dice que no se ha mirado dentro**. Buscar un secreto
en un HTML con una expresión regular corta el ejemplo por la mitad o tapa un identificador que hacía
falta. Lo honesto es no mirar y decirlo, en vez de dar a entender que está revisado.

### Dónde vive y dónde se ve

Tabla del **proyecto**, no de la persona — al contrario que el tarro de cookies o el token de sesión.
Un ejemplo es documentación, y documentación que solo ve quien la guardó no documenta nada. Clave
única por endpoint y nombre, y `ON DELETE CASCADE` sobre `endpoints`: un ejemplo sin su endpoint no
es nada. El borrado de un endpoint es blando, así que en la práctica los ejemplos sobreviven a un
borrado reversible y solo desaparecen cuando la fila se va de verdad.

En pantalla, en las pestañas de **la petición** y no en las de la respuesta: un ejemplo es del
endpoint, y las pestañas de respuesta solo aparecen después de enviar. El camino normal es **guardar
lo que ya tienes delante**, no teclear un ejemplo: un formulario en blanco con quince campos se
rellena una vez y no se vuelve a tocar, y entonces la lista se queda vacía. El botón está apagado
mientras no hay respuesta y dice por qué.

### La ida y la vuelta

- **Importar** una colección lee sus `response[]`, con el `originalRequest` cuando lo trae —y es el
  caso interesante: un ejemplo de 422 se guardó con un cuerpo inválido a propósito, y colgarlo de la
  petición actual contaría lo contrario de lo que pasó—. Sin `originalRequest`, la del `item`, que es
  lo que Postman enseña.
- Un ejemplo **sin código de estado se descarta.** Es el único campo sin valor por defecto honesto:
  uno que dijera «200» sin que el fichero lo dijera es una afirmación inventada sobre la API de
  alguien, y es justo lo que se va a leer como contrato.
- **La redacción se aplica al importar**, no solo al guardar a mano. Un fichero de Postman llega con
  los tokens en claro, y entrar por el importador no puede ser la puerta por la que un token se cuela
  en la base de datos. Lo mismo al restaurar un bundle: viene redactado, pero un bundle es un fichero
  que se edita a mano y confiar en que llega limpio sería lo mismo que no limpiar.
- **Exportar** los escribe de vuelta como el array `response`, con `code`, `status`,
  `_postman_previewlanguage` y el `originalRequest` entero. Nada que redactar en la salida: se limpia
  en la puerta, y así hay una puerta y no tres.

### Tres fallos míos, por el camino

- **`redactBody` devolvía el valor donde `Object.fromEntries` espera el par.** Cualquier cuerpo con
  un objeto dentro habría salido destrozado.
- **`languageContentType` espera un `{ language }`,** y `_postman_previewlanguage` es una cadena
  suelta: mi llamada devolvía siempre vacío, así que todos los ejemplos importados habrían caído a
  `text/plain` y ninguno se habría mirado por dentro.
- **`examples` duplicado** en el `PostmanItem` y en su `ParsedRequest`. Dos sitios que dicen lo
  mismo es un sitio que se va a quedar atrás.

### Cómo se comprobó

Contra la base de datos real, no solo en memoria: se guardó por HTTP un ejemplo con cinco secretos
distintos —una cabecera `Authorization`, una contraseña en el cuerpo de la petición, un
`access_token`, un JWT en un campo llamado `data`, y un `Set-Cookie`— y después se consultó la tabla:

```
SELECT count(*) FROM endpoint_examples
WHERE request::text || response::text ~ 'TOKEN-EN-CLARO|clave-real|SECRETO-DEL-CUERPO|...'
→ 0
```

Las pruebas del dominio no pueden demostrar eso. Se puede tener un `redactExample` perfecto y una
ruta que guarda el cuerpo sin llamarlo, y seguirían verdes con el token dentro.

También contra la base real: la cascada (borrar la fila del endpoint se lleva sus ejemplos), y en el
navegador la lista, abrir un ejemplo —el cuerpo llega con los valores tapados—, borrar uno, y el
botón apagado con su explicación cuando el destino está bloqueado y no hay respuesta que guardar.

Y la ida y vuelta completa por HTTP: una colección con tres ejemplos entra con dos —el que no trae
código de estado se descarta—, sin el token que traía el fichero, y sale otra vez en el `response[]`
del fichero exportado.

`api 689 pruebas (43 nuevas) · web 415 (13 nuevas) · runner-core 311 · lint 0 errores · typecheck limpio`

## Paridad con Postman, ola 5: importar un HAR, y tirar el 99% de lo que trae

Un HAR es lo que graba la pestaña de red de cualquier navegador, y es **el camino más corto que
existe** entre _«funciona en el navegador»_ y _«hay una prueba»_: se abre el inspector, se usa la
aplicación, se exporta, y dentro están las peticiones de verdad con sus cabeceras de verdad y —esto
es lo que ningún otro formato trae— **lo que el servidor contestó**. Es el único del que sale un
endpoint ya documentado con sus ejemplos, y por eso venía justo después de ellos.

Antes el detector reconocía la forma y decía «todavía no se lee: exporta las peticiones como curl».
Había una prueba que lo afirmaba, y ahora dice otra cosa.

### Lo que se tira, que es casi todo

Un HAR de una pestaña son doscientas entradas y **unas ocho son la API**. El resto es el HTML, los
bundles de JavaScript, las hojas de estilo, las fuentes, los iconos, la telemetría, y un `OPTIONS`
de preflight por cada petición con CORS. Importarlo tal cual daría doscientos endpoints donde los
que importan no se encuentran, y eso es **peor que no importar nada**: hay que borrar ciento noventa
a mano para llegar a lo que se venía a buscar.

Tres filtros, cada uno con su motivo:

- **El tipo que contestó el servidor**, y no la extensión de la URL, que puede no tener.
- **El `OPTIONS` de preflight**, que no lo manda la aplicación sino el navegador por su cuenta.
- **Los dominios de telemetría conocidos**, que no son la API que se prueba y a los que meter
  tráfico de prueba no le hace bien a nadie. El dominio se compara exigiendo el punto, igual que las
  cookies de la RFC 6265: `misentry.io` no es `sentry.io`, y `sentry.io.miapi.test` tampoco.

Lo tirado **se cuenta agrupado por motivo**. «Se importaron 8 de 213» sin explicación es un número
que nadie puede comprobar; ochenta y tres líneas iguales tampoco informan más que una.

### Y el riesgo simétrico, que es el que nadie prueba

Tirar de más. Un `application/problem+json` es la respuesta de error de una API de verdad —RFC
9457—, un endpoint que contesta `text/plain` existe, y un 204 no lleva ningún tipo. Si el filtro se
los come, el import se queda corto **en silencio**, que es el peor resultado posible. Cada uno de
esos casos tiene su prueba.

### La misma ruta veinte veces

En una sesión de navegador la misma ruta aparece una y otra vez. Las repetidas **no se descartan**:
la primera es el endpoint y las siguientes son más ejemplos suyos. Un 200, un 404 y un 422 de la
misma ruta es exactamente la colección de ejemplos que alguien querría tener y que a mano no va a
escribir nunca. La cadena de consulta no separa dos endpoints: `?page=1` y `?page=2` son la misma
ruta con dos respuestas.

### La credencial, con el tipo y sin el valor

Un HAR trae la cabecera `Authorization` **de verdad**, con el token de alguien dentro. El tipo se
conserva —es lo que hace falta para volver a mandarla y no es un secreto— y el valor no: un `Bearer`
entra como `{ type: "bearer", params: { token: "" } }`, y `Basic` y `Digest` igual. Un esquema que el
editor no sabe firmar se queda en `inherit` en vez de inventar un tipo.

Las pseudo-cabeceras de HTTP/2 —`:method`, `:path`, `:authority`— se quedan fuera: las escribe el
navegador, no son cabeceras, y mandarlas a mano da un 400.

Un cuerpo de respuesta en base64 se decodifica, que es cómo el navegador guarda cualquier cosa que
no sea texto. Y una entrada **sin código de estado no da ejemplo**: el HAR anota cero en una petición
que se canceló, y un ejemplo que dijera «0» o que se inventara un 200 sería una afirmación falsa
sobre la API de alguien.

### Comprobado con un HAR real, no solo con uno escrito para la prueba

Se grabó una sesión de verdad en el navegador de este producto —84 entradas, con sus tipos y sus
estados reales— y se pasó por el lector:

```
endpoints: 1
   GET /api/auth/refresh · ejemplos: 1
descartes:
   83 peticiones: son recursos de la página y no de la API (text/javascript)
```

De 84 queda **una**: la única llamada a la API que esa sesión hizo. Y era un
`application/problem+json`, que es justo el tipo que un filtro descuidado se habría comido.

Además, por HTTP de punta a punta con una sesión sintética que mezcla las siete clases de entrada:
entran dos endpoints, los descartes salen con su motivo, los dos ejemplos de la misma ruta cuelgan
del mismo endpoint, el cuerpo que se mandó entra con el endpoint que lo mandaba, y ni el token de la
cabecera, ni el del cuerpo, ni la cookie de sesión llegan a la base de datos.

`api 720 pruebas (31 nuevas) · web 415 · import-detect 25 · runner-core 311 · lint 0 errores · typecheck limpio`

## Paridad con Postman, ola 6: el servidor de mocks, y una URL pública de verdad

Los ejemplos de la ola anterior eran documentación. Esto los vuelve **ejecutables**: una URL que
contesta con lo que la API contestó una vez, sin tocar la API de verdad. Por eso venía después y no
antes — un mock sin ejemplos no tiene con qué contestar, y hacerlo primero habría obligado a
inventar un almacén de respuestas que luego habría que migrar.

Es el primer sitio de este producto donde una ruta abierta devuelve datos de un proyecto, así que la
mitad del trabajo está ahí.

### Público o privado, pero **dicho**

`visibility` no tiene valor por defecto, ni en el DTO ni en la pantalla: el botón de crear está
apagado hasta que se elige. No es fricción por gusto. Los cuerpos de ejemplo ya van sin credenciales
—eso lo hizo la redacción al guardarlos— pero siguen siendo datos reales de alguien, con sus
nombres, sus correos y sus identificadores. Cuando la opción cómoda es la abierta, se publica sin
decidirlo.

Un mock privado pide `x-api-key`, y de la clave **se guarda el hash**, con el mismo criterio que los
tokens de API: un volcado de la base de datos no entrega mocks. Se enseña una vez, en un aviso que
hay que cerrar a mano — un _toast_ se iría antes de copiarla, y no hay ningún otro sitio donde
mirarla.

El `publicId` es aleatorio de 128 bits y **no** es el `id` de la fila. En un mock público la URL es
la credencial, y separar los dos identificadores permite además rotarla sin tocar nada interno. Un
`publicId` que no existe y uno que existió dan la misma respuesta: distinguirlos convertiría la ruta
en un oráculo para adivinar URLs.

Las dos rutas están en `PUBLIC_PATHS` **a propósito**. Esa lista es el inventario de lo que responde
sin token, y hay una prueba que la compara contra lo que la aplicación de verdad contesta: algo que
se sirve abierto tiene que poder leerse ahí.

### Tres maneras de no contestar, y tres códigos

Un mock que contesta 404 sin explicación es indistinguible de un mock roto, y quien lo usa se queda
mirando la consola sin saber si escribió mal la ruta, si falta el ejemplo, o si el mock está apagado.

- **La ruta no existe** — 404, con la que sí se parece. «Pediste `/user/42`, el mock sirve
  `GET /users/{id}`» es lo único que hace falta saber casi siempre. Y tener el mismo número de
  segmentos **no** es parecerse: «¿querías `/pedidos`?» ante un `/usuarios` es peor que callarse.
- **La ruta existe con otro método** — 405 con `Allow`, que es lo que dice HTTP y lo que además
  resuelve el caso: se olvidó el `method` en el `fetch`.
- **La ruta existe y no tiene ejemplos** — 501, y no 404. El endpoint está declarado y nadie ha
  guardado nunca lo que contesta.

Y antes de todo eso, la pantalla dice «1 de 12 rutas tienen ejemplo». Un mock de un proyecto sin
ejemplos es una URL que contesta 501 a todo, y descubrirlo cuando el front ya está apuntado es media
tarde.

### Elegir entre varios ejemplos

Por orden: lo que pide quien llama (por nombre o por estado, que es lo que permite probar el camino
de error sin tocar el mock), lo que encaja con la petición, y si no, **el 2xx más bajo**.

No «el primero», que es lo que hace Postman: lo normal es guardar primero lo que sorprende —el
error— y entonces el mock contestaría 500 a todo y no serviría para montar nada.

Lo que encaja se puntúa sobre lo que el ejemplo **afirma**: un parámetro del que no dice nada no es
evidencia en ningún sentido, y uno que dice otra cosa **resta**. Sin eso, un ejemplo con veinte
campos ganaría siempre por tener más con los que coincidir.

Un nombre pedido que no existe es un 400 y **no** otro ejemplo. Servir otro sería lo peor que puede
hacer: la prueba que pidió el camino de error pasaría en verde contra el de éxito.

### El CORS del mock es el contrario del de la API

La API vive con una lista de orígenes y `credentials: true`, porque ahí hay una sesión que proteger.
El caso normal de un mock es un front a medio hacer en un puerto que cambia cada día, y una lista de
orígenes lo rompería en la primera hora. Así que abre a cualquier origen — y por eso mismo **no
admite credenciales**, que además es la única combinación que el navegador acepta junto a `*`.

`HEAD` lo contesta el ejemplo del `GET` sin cuerpo, porque quien pregunta por las cabeceras de un
recurso no está pidiendo otro recurso. Y un `OPTIONS` de verdad —el que un proyecto declara— sí llega
al motor: lo que lo separa del preflight es `Access-Control-Request-Method`.

### Las cabeceras que no se reenvían

No es higiene, es corrección. El cuerpo se guardó ya descomprimido, así que un `content-encoding:
gzip` heredado hace fallar a todos los clientes; una `content-length` vieja desincroniza la
respuesta; `date` guardada es una fecha falsa; y `strict-transport-security` es la política del
dominio ajeno sobre sí mismo.

Y el valor de una cabecera guardada **no lo escribió nadie**: lo contestó otro servidor o lo trajo un
HAR. Un salto de línea dentro partiría la respuesta en dos. Eso ahora tiene dos puertas: la
validación del ejemplo, que no lo deja entrar —**le faltaba**, y el importador construye ejemplos sin
pasar por ella—, y el saneado de quien sirve.

### Tres fallos míos, y dos solo se ven en la pila desplegada

- **`Access-Control-Allow-Credentials: true`**, que escribe el CORS global de Nest **después** del
  middleware del mock. Junto a `Allow-Origin: *` es justo la combinación que el navegador rechaza de
  plano. Se quita en el último momento, que es el controlador. Las pruebas no lo veían porque la
  aplicación de prueba no monta el CORS global: se encontró mirando los bytes de una respuesta real.
- **`x-eq-mock-reason: el 2xx m?s bajo`**. El valor de una cabecera HTTP no lleva UTF-8: Node escribe
  los bytes y el cliente los lee como latin-1. Los motivos pasaron a ser códigos ASCII
  (`lowest-2xx`, `by-name`, `by-status`, `request-match`) —que además se pueden buscar en un registro
  y comparar en una prueba— y el nombre del ejemplo, que es texto de alguien y va a llevar tildes, se
  codifica en porcentaje.
- **`nearestRoutes` proponía cualquier ruta con el mismo número de segmentos.** Lo pilló la prueba que
  escribí para lo contrario.

### Cómo se comprobó

Además del motor entero en memoria, la pila desplegada con nginx delante: se creó una cuenta, un
endpoint y dos ejemplos por HTTP, y después se llamó a la URL del mock **sin ninguna cabecera de
autenticación**.

```
GET /api/mock/<publicId>/v1/pedidos/42
HTTP/1.1 200 OK · x-eq-mock-endpoint: GET /v1/pedidos/{id}
                  x-eq-mock-example: 200 con el pedido · x-eq-mock-reason: lowest-2xx
{ "id": "42", "cliente": "Ana", "access_token": "••••••••" }
```

El `access_token` sale tapado: la redacción aguanta hasta la URL pública, que es donde importa. Y en
la tabla, los tres secretos que se mandaron —cabecera, cuerpo y `Set-Cookie`— salen a cero.

También contra la pila: el privado da 401 sin clave, 401 con otra y 200 con la suya; rotar deja fuera
a la vieja en el mismo momento; apagarlo da 503 diciéndolo; el preflight sale 204 sin
`allow-credentials`; y borrar la fila del proyecto se lleva sus mocks por la cascada.

En el navegador, el botón de crear con el nombre puesto y sin elegir visibilidad: apagado.

`api 802 pruebas (82 nuevas) · web 424 (9 nuevas) · import-detect 25 · runner-core 311 · lint 0 errores · typecheck limpio`

## Paridad con Postman, ola 7: la documentación publicada, y una lista de lo que entra

Los ejemplos de la ola 4 tenían dos consumidores posibles. El mock los sirve para que una máquina los
consuma; esto los **enseña** para que una persona de otro equipo entienda la API sin que nadie le
explique nada y sin darle acceso a este producto. Con esto, lo que se guarda en un proyecto sale por
los dos lados que Postman tiene, y la ola 4 deja de ser un almacén con una sola salida.

Es la segunda superficie pública del producto, y la primera que **pinta una pantalla** sin sesión.

### La decisión que da forma al módulo: una lista de lo que entra

Un endpoint guardado lleva dentro cosas que existen para poder _enviar_ la petición: el token de su
bloque `auth`, las cabeceras que alguien escribió a mano —`Authorization: Bearer eyJ…` entre ellas—,
el cuerpo con el que se probó y dos scripts. Publicar el endpoint sería publicar todo eso.

Así que `doc-page.ts` escribe `DocEndpoint` **campo a campo**. No hay ni un `...endpoint` en el
fichero, y eso no es estilo: es la diferencia entre que un campo nuevo aparezca solo en la página
pública —callado, el día que alguien añada `internalNotes`— y que no aparezca hasta que se decida. Al
revés, con una lista de lo que se quita, el campo nuevo se publica solo, que es exactamente cómo se
filtran las cosas.

Lo que nunca está en la lista: `auth.params`, los dos scripts, las filas con `enabled: false` —una
cabecera que no se manda no es el contrato de nada— y los endpoints que no están `active`.

**Las cabeceras llevan la política contraria** que al guardar un ejemplo, y a propósito, porque cambia
para qué sirve el dato. `redactHeaders` tira la cabecera entera: un ejemplo guardado no necesita
saber que había un `Authorization`. Una documentación sí — «esta ruta pide `Authorization`» es justo
lo que hay que decir. Así que el nombre se queda y el valor se tapa.

La única excepción en `auth` tiene el mismo tamaño: de una API key sale **el nombre** por el que
entra. Sin él, quien lee la página no sabe dónde poner su clave. Su valor no sale ni tapado. Un
usuario de `basic` no sale: es un dato personal de alguien, no documentación.

### La URL base se escribe, no se hereda

La documentación necesita una URL base para que el código de la página se pueda pegar. La tentación
es leerla del entorno activo del proyecto, y es justo lo que no se puede hacer: un entorno tiene
`{{token}}`, `{{apiKey}}` y el host interno de preproducción, y resolver variables contra él para
pintar una página pública es publicar sus valores. Así que el sitio tiene **su propia** URL base,
escrita a mano, validada como URL entera y **sin variables** —esta página no tiene entorno con el que
resolverlas—, y las variables de la documentación se quedan escritas como `{{variable}}`.

En la pantalla hay un botón que copia la del proyecto, y hay que pulsarlo. Así el valor que va a
salir publicado se lee antes de salir, en vez de aparecer ya puesto en un campo que nadie mira.

### Dos decisiones, y ninguna cómoda por omisión

`visibility` no tiene valor por defecto, como en un mock. Y hay una segunda que no es la misma:
`includeExamples` empieza en `false`. Publicar la **forma** de una API es una cosa y publicar sus
**datos** es otra — los cuerpos van sin credenciales, eso lo hizo la redacción al guardarlos, pero
siguen siendo respuestas reales con nombres, correos e identificadores de alguien. La que arrastra
datos no puede ser la que pasa sin mirarse.

### Dos direcciones para lo mismo, y `noindex`

`GET /shared/docs/<publicId>` devuelve JSON: es lo que consume una máquina y lo que lee el programa
del navegador. `/docs/<publicId>` en el origen del navegador es la página, y es la que se le manda a
una persona. Un `publicId` sirve para las dos.

No es `/docs` en la API porque ahí vive el OpenAPI de este producto, y esa colisión es de las que solo
aparecen en el despliegue.

Las dos respuestas llevan `X-Robots-Tag: noindex, nofollow`. Una documentación «pública» de aquí está
protegida solo por que su URL no se adivine, y un buscador que la indexe convierte eso en nada: deja
de hacer falta adivinarla porque está en una lista.

La clave de una privada se pide **en la página** y viaja en `x-api-key`, no en la URL: una URL con la
clave dentro acaba en el historial, en el registro del proxy y en el «compartir» de cualquiera. Se
guarda en el `localStorage` de quien la escribe, por `publicId`.

### Tres fallos míos, y el primero solo se ve en los bytes

- **nginx perdía el `X-Robots-Tag` de la página.** El bloque `location ^~ /docs/` lo añadía y
  resolvía con `try_files … /index.html`, que hace un **salto interno** a `location = /index.html` —
  y nginx **no** arrastra los `add_header` de la location de origen. La única señal era que la
  respuesta traía el `Cache-Control` del otro bloque. Con `rewrite ^ /index.html break` el documento
  se sirve dentro de la misma location y la cabecera sale. Ninguna prueba de este repositorio ve eso:
  se encontró leyendo las cabeceras de una respuesta real.
- **El aviso nombraba un `{{token}}` que no aparecía en el código.** `snippetNotes` recorre
  `auth.params` tanto si el plan los usó como si no, y una cabecera `Authorization` escrita a mano
  gana sobre el bloque `auth`. Ahora la página aplica la misma regla que `authPlan` antes de
  sintetizar nada: un aviso que no se corresponde con lo que se ve es peor que ninguno.
- **Los ocho puntos entraban en el fragmento de código.** Un `"password": "••••••••"` se pega tal
  cual y manda ocho puntos por contraseña. En el cuerpo del código los campos tapados salen como
  `{{password}}` —igual que ya se hacía con las cabeceras—, y el generador los cuenta en su aviso de
  lo que queda sin sustituir. Solo en JSON que parsea: adivinar dónde está el campo dentro de un XML
  con una expresión regular es la clase de cosa que corta el cuerpo por la mitad.

### Los dieciséis lenguajes son los mismos, no una copia

La página usa `renderSnippet` de la ola 3. Lo que Postman hace con un generador aparte por lenguaje,
aquí sale del que ya estaba probado, con su selector y sus avisos encima del código.

### Cómo se comprobó

La proyección entera en memoria, y casi cada prueba es la misma pregunta escrita de otra manera:
_esto que está en la fila, ¿aparece en la página?_ Y contra la pila desplegada, con nginx delante, se
publicó un endpoint con todo lo que no puede salir puesto —token en `auth`, otro en una cabecera,
contraseña en el cuerpo, dos scripts— y se leyó la URL **sin ninguna cabecera de autenticación**:

```
GET /api/shared/docs/<publicId>          → 200 · X-Robots-Tag: noindex, nofollow
GET /docs/<publicId>                     → 200 · X-Robots-Tag: noindex, nofollow

cabeceras: Authorization ••••••••  (tapada)   Accept application/json
cuerpo:    { "cliente": "Ana", "password": "••••••••" }
código:    curl -H 'Authorization: {{authorization}}' --data '{ …, "password": "{{password}}" }'
ejemplo:   201 · { "id": "42", "cliente": "Ana", "access_token": "••••••••" }
```

Los cuatro secretos que se mandaron —`TOKEN-DEL-ENDPOINT`, el de la cabecera, el del script y
`hunter2`— salen a cero en el volcado de la respuesta.

También contra la pila: la privada da 401 sin clave, 401 con otra y 200 con la suya; una `publicId`
inventada y una borrada dan el mismo 404; la clave en claro no está en la tabla; y borrar el proyecto
se lleva sus sitios por la cascada. En el navegador de verdad: la página privada pide la clave, la
acepta, y al recargar ya no la pide.

`api 843 pruebas (41 nuevas) · web 448 (24 nuevas) · import-detect 25 · runner-core 311 · lint 0 errores · typecheck limpio`

## Paridad con Postman, ola 8: los monitores, y el reclamo que lo hace posible

Todo lo anterior contesta cuando alguien pregunta. Un monitor pregunta él, a las tres de la mañana,
y dice que la API de producción lleva dos horas en rojo. Es el último gran hueco frente a Postman y
el que convierte el producto en algo que se deja puesto.

### Un monitor no es un tipo nuevo de corrida

Lo que dispara es la misma `StartRunCommand` que el botón de la pantalla, con el mismo plan y el
mismo entorno. Eso no es comodidad: significa que un monitor **no puede ejecutar nada que no se pueda
ejecutar a mano**, y que las validaciones del plan —el flujo existe, el conjunto de datos es de ese
flujo, la corrida no es gigantesca— están escritas una vez. Un planificador con su propio camino de
ejecución acaba corriendo algo distinto de lo que se probó, y nadie se enteraría hasta que hiciera
falta.

Lo único que cambia es quién la pidió: `triggeredByKind: "monitor"`. Una corrida que nadie lanzó no
la lanzó un usuario, y decir que sí sería mentir en el historial de quién tocó qué.

### Lo que un planificador hace mal en silencio

Son tres cosas y las tres viven en `schedule.ts`, que es una función pura de `(horario, instante)` al
instante siguiente:

- **No se acumula.** El turno se calcula desde el instante que se le da hacia delante, nunca sumando
  al turno perdido. Un monitor cada hora en un proceso que estuvo ocho horas caído dispararía ocho
  corridas seguidas nada más arrancar; así dispara una y vuelve a la cadencia.
- **La hora es la de una persona.** «Todos los días a las 9:00» puesto por alguien en Madrid tiene
  que seguir siendo a las 9:00 cuando cambie la hora, y un turno guardado en UTC se va una hora dos
  veces al año. El horario lleva su zona IANA y se resuelve con `Intl`, que ya trae Node: cero
  dependencias y la base de datos de zonas la mantiene otro.
- **Los dos días raros del año, dichos.** No se puede restar «el desfase» sin más, porque el desfase
  depende del instante y el instante es lo que se busca. Se prueban los dos desfases de alrededor y
  se mira cuál de los dos candidatos recupera de verdad la hora pedida: la hora que **existe dos
  veces** (otoño) da dos candidatos válidos y se coge el primero; la que **no existe** (primavera) no
  da ninguno y se coge el primer instante después del salto. En los dos casos el monitor corre una
  vez ese día, que es lo que se le pidió.

Y un mínimo de cinco minutos, que no es gusto: cada turno es una corrida entera contra un servicio de
alguien.

### El reclamo, que es el motivo de que esto no sea trivial

Dos instancias de la API con el mismo Postgres detrás ven los mismos monitores vencidos en el mismo
segundo. Sin nada que lo impida, las dos lanzan la corrida — y no es una carrera rara que pase de vez
en cuando: con dos instancias y un turno en punto, pasa **siempre**.

Lo cierra la base de datos y no un candado nuestro: `SELECT … FOR UPDATE SKIP LOCKED` dentro de una
transacción entrega cada fila a una sola instancia y hace que la otra la **salte** en vez de
esperarla — esperarla sería lanzar la corrida dos veces, una detrás de otra. En la misma transacción
se adelanta `nextRunAt`, porque hacerlo después deja una ventana en la que el monitor sigue vencido.

`nextRunAt` lo calcula el dominio y no el SQL, y por eso el puerto recibe una función: el horario
tiene zona, días de la semana y dos días raros, y eso no se escribe en una expresión de Postgres sin
duplicar las reglas donde no se pueden probar.

Por lo mismo, el planificador corre en **todas** las instancias y no en una «líder»: elegir una
haría que un despliegue sin ella dejara de vigilar en silencio.

### No se solapa, y una vuelta abierta no lo deja mudo

Si la corrida anterior sigue viva, el turno se salta y se anota por qué: un monitor cada cinco
minutos contra una API que tarda seis no es vigilancia, es una cola que crece hasta que alguien la ve.
Y no se le pregunta a la fila de la vuelta anterior sino **a la corrida**: si un proceso se murió con
una corrida a medias, su vuelta se quedó en «running» para siempre y el monitor no volvería a
disparar nunca. Se cierra al pasar y se sigue.

Una vuelta saltada no cuenta ni como fallo ni como acierto: no se midió nada. Y una corrida
**cancelada** tampoco es un fallo — la cancela una persona, y contarla como rojo despierta a alguien
por algo que otro acaba de hacer a mano.

### El historial es una tabla, no una vista sobre `runs`

Porque la retención **borra corridas viejas**, y un historial leído de `runs` se iría vaciando por
detrás sin que nadie lo pidiera. La fila de la vuelta es pequeña —estado, cuándo, cuántos casos— y
sobrevive al barrido, que es lo que un historial tiene que hacer. `runId` es una referencia suelta y
sin clave ajena, por eso mismo.

### El aviso: la URL es una credencial

Las reglas son las del nodo `notify` de un flujo y se reutilizan tal cual, porque el problema es el
mismo: quien tiene una URL de webhook entrante puede escribir en ese canal. El monitor guarda **el
nombre de la variable** y la URL sale del entorno, descifrada si es sensible; sale por `SAFE_FETCH`,
como toda llamada saliente; y el texto va redactado contra los secretos de ese entorno.

Con una regla propia: **un aviso que falla no rompe el monitor.** Si el canal está caído o la
variable no existe, se anota en la vuelta y la vigilancia sigue. Lo contrario —que un webhook mal
escrito apague la vigilancia— es el peor de los dos fallos.

Y se avisa **en el turno exacto**, no en todos los siguientes: con «al segundo fallo», un servicio
caído toda la noche mandaría un aviso por turno hasta que alguien silenciara el canal, y un canal
silenciado tampoco avisa del incendio siguiente. También se avisa de la recuperación, y solo si antes
se había llegado a avisar de la caída.

### Dos fallos, y los dos solo se ven en la pila desplegada

- **El reclamo adelantaba el turno y el guardado posterior lo pisaba.** Al cerrar la vuelta se guarda
  el monitor entero —la racha, el último resultado— y el objeto que venía del reclamo llevaba el
  turno viejo: se restauraba, el monitor volvía a estar vencido y disparaba **en cada tic**. En la
  suite no se veía porque el camino que guarda el monitor es el de las vueltas que _no_ lanzan
  corrida, y las de la suite lanzaban. Se vio en la base de datos: tres vueltas en tres minutos con
  un horario de cinco. Ahora el reclamo devuelve el monitor con el turno ya adelantado, y hay una
  prueba del camino con error que se pone roja sin el arreglo.
- **`SAFE_FETCH` no estaba en el módulo.** Lo exporta `SpecsModule`, y `MonitorsModule` no lo
  importaba: la aplicación no arrancaba. La suite no lo vio porque la aplicación de prueba provee ese
  token globalmente — una comodidad que esconde justo esta clase de fallo.

### Cómo se comprobó

El horario entero en memoria, con fechas concretas: las 9:00 de Madrid en invierno y en verano, la
hora que no existe, la que existe dos veces, medianoche, media hora de desfase, y el día de la semana
mirado en la zona del monitor y no en UTC.

Contra la pila desplegada, con el reloj del contenedor:

```
horario: todos los días a las 09:00 (Europe/Madrid)
turno:   2026-09-18T07:00:00Z            ← septiembre es CEST, así que 09:00 locales
disparó en t+25s · 1 vuelta · failed 13/13 · lanzada por: monitor <id>
turno después: 2026-09-18 07:00:00       ← y ahí se queda, no en cada tic
```

El aviso, también contra la pila: la fila del monitor guarda
`{"channel":"slack","urlVariable":"SLACK_WEBHOOK","afterFailures":1}` y **ninguna URL** —cero
coincidencias de `sample-api` en la fila—, la URL se resolvió del entorno, y `SAFE_FETCH` la rechazó
por ser red privada. La vuelta quedó con la nota «El aviso no salió: el canal no respondió» y el
monitor siguió contando: la nota no lleva la URL dentro, y el registro del servidor —que es de quien
opera— sí dice cuál era.

Y lo único que solo Postgres puede demostrar, con dos sesiones a la vez sobre la consulta del reclamo:

```
instancia A: a300b252-…  (transacción abierta, fila bloqueada)
instancia B: (0 rows)    ← la salta, no la espera
```

`api 903 pruebas (60 nuevas) · web 458 (10 nuevas) · import-detect 25 · runner-core 311 · lint 0 errores · typecheck limpio`

> **Nota del despliegue**, confirmada de paso: `SECRETS_KEY` de este `docker/.env` decodifica a 48
> bytes y tiene que ser de 32. Crear una variable de entorno **sensible** contesta 500 con
> `SECRETS_KEY debe ser una clave de 32 bytes en base64`, así que hoy un aviso no puede leer su URL
> de una variable cifrada en esta instalación. No se ha tocado la clave.

## Ola 8b: el canal correo de los avisos, y la decisión de guardar la dirección en claro

Un monitor ya avisaba a Slack, a Teams o a un webhook. Faltaba el correo, que es a donde avisa quien
no tiene un canal de chat con guardias — y es el único de los cuatro que va a una **persona** y no a
un sitio.

### La decisión: la dirección se guarda en claro, y la URL sigue sin guardarse

Parecen el mismo problema y no lo son. Una URL de webhook entrante **es una credencial**: quien la
tiene publica en ese canal, así que el monitor guarda el nombre de una variable y la URL vive en el
entorno. Una dirección de correo no autoriza nada — cualquiera puede escribir a ese buzón ya—, y esa
era la única razón por la que el webhook pasa por una variable.

Guardarla en claro compra además lo que importa de un canal de avisos: **se ve a quién se está
despertando**. Con la dirección detrás de un nombre de variable, saber quién recibe los avisos de un
monitor obligaría a abrir el entorno y descifrar un valor, y el teléfono de la madrugada es justo el
dato que hay que poder revisar de un vistazo. Por eso la tarjeta de la pantalla las enseña enteras:
esconderlas ahí desmontaría el argumento para guardarlas así. Y los destinatarios tampoco son un
atributo del entorno que se prueba —el mismo entorno lo comparten corridas a mano que no avisan a
nadie—, así que meterlos allí ataría el aviso a una variable que cualquiera puede renombrar.

Con los topes del resto del módulo: cinco destinatarios, porque una lista más larga es una lista de
distribución y una lista de distribución se hace en el servidor de correo, donde alguien puede darse
de baja. Y cada canal pide su campo y solo el suyo: un aviso por correo que arrastra el `urlVariable`
de cuando era un webhook se lee como si saliera por los dos sitios, así que al guardar se suelta.

### Lo que el correo no lleva

Ni valores de variables, ni cabeceras, ni cuerpos. Cuenta el proyecto, el monitor, su horario,
cuántos casos quedaron en rojo y el id de la corrida; el detalle se mira en la aplicación, donde hay
sesión y permisos. Un correo se reenvía, se archiva en el buzón de alguien y se indexa: un token que
acabe dentro ya no se puede recoger. Y lo dice dentro, para que quien lo recibe no lo busque.

La redacción contra los secretos del entorno pasó a hacerse **dato por dato** antes de componer el
mensaje, en vez de sobre el texto ya armado de un canal. Así los cuatro canales salen redactados del
mismo sitio y el quinto no puede olvidarse. Es también el motivo por el que un aviso por correo
necesita el entorno aunque no saque ninguna URL de él: de ahí sale la lista de secretos, y sin ella
no mandar es mejor que mandar.

Y las reglas de siempre: **el aviso no rompe la vuelta**. Un envío por destinatario, con su propio
`try`, porque un buzón que ya no existe no puede llevarse por delante el aviso de los otros cuatro.
La nota que queda en el historial dice cuántos salieron y no a quién: la ve todo el proyecto.

### Sin migración

`alert` ya era una columna `jsonb` que guarda el aviso entero, así que el canal nuevo cabe donde
estaba. Una migración aquí habría sido una migración que no cambia nada.

### Cómo se comprobó

En memoria: que el correo pide direcciones y el webhook sigue pidiendo un nombre de variable, que una
variable no cuela como buzón, que seis destinatarios no pasan, que la misma dirección dos veces no
manda el aviso dos veces, y que el detalle del error no repite la dirección mal escrita.

Por HTTP, contra el `RecordingMailer` del arnés —la suite no manda correo a ninguna parte—: que con
«tras dos fallos» el primero calla, el segundo manda un correo por destinatario, y el tercero no
repite; que la recuperación llega cuando el monitor vuelve al verde y **no** llega si la caída nunca
se avisó; que un valor sensible del entorno metido en el nombre del monitor sale redactado del asunto
y del cuerpo, y que no hay dentro ni cabeceras ni cuerpos de respuesta; y que un servidor de correo
que rechaza deja la vuelta contando, con una nota que no cita la dirección.

No se comprobó contra la pila desplegada: es un stack compartido y no se tocó.

`api 905 pruebas (12 nuevas) · web 461 (3 nuevas) · lint 0 errores · typecheck limpio`

## Ola 8c: tres huecos pequeños en paralelo, y dos fallos que solo se ven en la pila

Tres agentes en tres worktrees, uno por hueco, y la integración a mano. Lo que hay que saber de
repartirlo así: **dos de los tres árboles llegaron siete commits atrasados**, en `0b252f0`. Uno lo
detectó y se puso al día antes de empezar; el otro no, y midió sus pruebas contra un repositorio sin
las olas 1 a 8 — 608 en vez de 904, un número que no dice nada de `main`. Por eso su trabajo hubo
que rebasarlo y revisarlo entero, y por eso la cifra que vale es la que se corre al integrar y no la
que informa quien trabajó aparte.

### La pestaña de llamadas del mock

Una fila por petición que la URL del mock contestó: cuándo, método, ruta, código, qué ejemplo casó o
el código del «no», y cuánto tardó. La decisión es lo que **no** hay: ni cabeceras, ni cuerpo, ni la
cadena de consulta —ni cruda ni redactada, ni los nombres de los parámetros—. La petición que entra
a un mock es de un tercero y lleva su `Bearer`, su login y su `?api_key=`; guardarlas convertiría la
tabla en un almacén de credenciales ajenas alimentado por una ruta `@Public()`. Y no es disciplina:
el comando que escribe la fila **nunca recibe la petición**, así que no puede guardar lo que no
tiene.

Lo que sí sobrevive de la petición es la ruta, porque es la mitad de «pediste `/user/42` y el mock
sirve `/users/{id}`» — y una ruta puede llevar un secreto en un segmento. Es el único dato de quien
llama que queda, dicho aquí para que nadie lo descubra después.

Retención de 200 por servidor y no las 50 de `MONITOR_HISTORY`: un monitor escribe una fila cada
cinco minutos y un mock una por cada recarga de un front. La escritura va después de la respuesta y
es best-effort: un mock que se cae porque su bitácora se cayó es peor que un mock sin bitácora.
`mock-not-found` no se registra —no hay fila donde colgarlo, y contar URLs inventadas sería registrar
el escaneo de un desconocido—, pero `mock-disabled` y `mock-key-invalid` sí, porque ahí el mock
existe y es él quien decidió no contestar.

### El import por URL: credencial, zip y enlace

La credencial de la URL **no se guarda en ninguna parte**: ni tabla, ni resumen, ni log, ni vuelta en
la respuesta. Es la diferencia con la del contrato, que sí se guarda cifrada porque un chequeo de
deriva programado tiene que releer la misma URL él solo; un import es un acto único, así que
guardarla no compra nada y cuesta una fila que alguien puede leer. Los errores lo respetan: el de
forma nombra el problema («trae un salto de línea»), el de red dice «401 con la credencial que se
envió», y ninguno cita el valor.

El zip por URL necesitaba bytes, que viajan **a petición** (`responseAs: "bytes"`) y no como un campo
más: los llamantes de SAFE_FETCH son catorce y el motor hace miles de peticiones, y tenerlas todas
dos veces en memoria se paga donde no hace falta. Se reconoce por los cuatro bytes mágicos y el
nombre no vota, porque una URL que acaba en `.zip` y contesta un JSON no es un zip.

Y aquí está la corrección que la integración salvó: el agente escribió **un segundo lector de zip**,
porque en su base atrasada el primero no existía. Se cambió por `readZip` de `@eq/import-detect`, el
mismo que abre el zip que se arrastra a la pantalla. Un segundo lector de un formato que llega de
fuera es un segundo sitio donde equivocarse con los topes, y las dos puertas tienen que aceptar
exactamente lo mismo. Leerlo desde el servidor sacó además un fallo del lector compartido: **no
miraba el bit de cifrado**, así que una entrada con contraseña salía como «texto» —bytes de
criptografía decodificados a UTF-8—, y eso arreglaba también el fichero subido. Los topes ahora
tienen prueba donde viven: una entrada que **declara** más de lo que cabe se queda fuera sin
inflarse, que es lo que miente una bomba zip, y el total se cuenta sobre lo que de verdad salió.

### Y los dos fallos que la suite verde no veía

**Un monitor con el plan roto sumaba fallos en silencio.** El aviso lo decidía sólo el manejador del
fin de corrida, que es lo correcto para el aviso normal porque lo que se avisa es un resultado. Pero
una vuelta que muere antes de tener corrida no tiene final que escuchar: el entorno borrado, el flujo
que ya no existe, el contrato sin importar. La racha subía, la pantalla lo contaba, y nadie recibía
nada **justo cuando lo roto es la vigilancia y no el servicio vigilado**. Ahora el aviso también sale
de la vuelta que se cierra en el turno, con el mismo `shouldAlert`: una vez por racha, y una saltada
no avisa porque no es un fallo.

**Un ejemplo con la forma equivocada contestaba 500.** El DTO declara `request` y `response` como
`@IsObject()` y nada más: el tipo de TypeScript describe lo que _debería_ haber llegado, no lo que
llegó. Un `response.body` que era un objeto en vez de texto llegaba hasta `Buffer.byteLength` y salía
una traza de Node. Un 500 por una petición mal escrita es una respuesta equivocada: quien la escribió
no sabe qué arreglar. Ahora la forma se comprueba antes de medirla y la respuesta es 422 con el campo.

Los dos salieron de la pila, no de la suite, y los dos tienen prueba que se pone roja sin su arreglo
—comprobado revirtiendo uno cada vez: 2 fallos la de los ejemplos, 1 la del monitor—.

### Cómo se comprobó

Contra la pila desplegada, con la migración `MockCalls1700000027000` aplicada: se sirvió un mock con
un token en la cabecera, otro en la query y otro en el cuerpo, y `select count(*) from mock_calls
where mock_calls::text like '%TOKEN%'` dio **0**, con las tres maneras de contestar registradas
(acierto con su `exampleId`, `mock-wrong-method`, `mock-no-route`). Un monitor con el canal correo y
el plan roto disparó, y el correo llegó al log del contenedor con el motivo dentro: «La corrida no
llegó a ejecutarse: El proyecto no tiene contrato importado». La vuelta quedó con las dos notas, la
del fallo primero.

Sigue en pie lo de la clave: `SECRETS_KEY` de `docker/.env` decodifica a 48 bytes y tiene que ser de
32, así que en esa instalación nada cifrado funciona y un aviso no puede leer su URL de una variable
secreta. Y `ALLOW_PRIVATE_TARGETS=false` explica que una corrida contra `sample-api` salga roja: la
guarda la rechaza por red privada, no es un fallo del producto.

`api 959 pruebas (55 nuevas) · web 472 (14 nuevas) · runner-core 311 · import-detect 29 (4 nuevas) · lint 0 errores · typecheck limpio`

## Paridad con Postman, ola 9: los demás protocolos, empezando por el único que ya cabía

WebSocket primero, y no por popular: un `ws://` es un GET con `Upgrade`, así que las cuatro reglas de
la guarda de red valen tal cual. MQTT es TCP pelado con un `CONNECT` binario y gRPC necesita HTTP/2:
los dos piden escribir el transporte desde abajo antes de poder comprobar nada. Quedan para las
olas siguientes, y SSE no entra en ninguna: tiene método, ruta, estado y cabeceras — **es** una
respuesta HTTP, y su sitio es el endpoint.

### Al lado, no dentro

Un canal es un agregado hermano de `Endpoint`, con sus tres tablas, y no una columna `protocol`.
Todo lector de `endpoints` falla **abierto**: el mock serviría `GET /chat`, la documentación
publicada sacaría una caja GET para un socket, la corrida de seguridad lo atacaría por HTTP. Siete
filtros que recordar y ninguno se pone rojo si falta. La pantalla, en cambio, va en el mismo sitio
—tercera pestaña de Endpoints—, porque un canal en otro menú es un canal que nadie encuentra.

### Una conversación no es una respuesta

`conversation.ts`, en runner-core y puro: tramas dentro, conversación fuera. El veredicto vuelve
como el mismo `Evaluation` y pasa por el mismo `holds()`, así que «pasa» se sigue decidiendo en un
solo sitio. Cinco topes obligatorios; el que de verdad atrapa un socket colgado es el de
inactividad, y el de bytes por trama va además **dentro** de la biblioteca, porque
`permessage-deflate` cuenta después de inflar. Un canal que conecta y no recibe nada, sin pedir
nada, pasa **y lo dice**.

La redacción va dentro de `applyFrame`, que recibe la trama cruda y devuelve solo el mensaje tapado:
hay dos caminos de escritura —la fila y la trama en vivo— y una redacción «al guardar» falla en
verde. Y se tapa **antes** de recortar, cosa que escribí al revés al principio: recortando primero,
un token partido por el corte ya no coincide con su valor y se guarda media credencial en claro.

### Lo que salió probando, y no escribiendo

Seis fallos, todos cazados por una prueba antes de llegar a `main`, y la mayoría de los que una suite
guionizada no ve:

- **Una IPv4 disfrazada de IPv6 se colaba por la guarda de SSRF** —de antes de esta ola, y el más
  serio—. `new URL` normaliza `[::ffff:127.0.0.1]` a `::ffff:7f00:1`, y la guarda solo reconocía la
  forma con puntos. Con la guarda puesta se leía loopback y `169.254.169.254`; comprobado en la pila
  antes de arreglarlo. Lo destapó la prueba de la lista de esquemas de esta ola.
- **44 de 50 saludos se perdían.** Un servidor que saluda al conectar lo manda en el mismo paquete que
  el 101, y las escuchas se enganchaban al resolver la promesa. Ahora son parte de la firma.
- **Una sesión segada salía en verde**: la fila no trae mensajes, la apertura sí consta, y
  «Conexión: abierta» pasaba. Ahora sale en rojo con el motivo.
- **`start()` devolvía una sesión en `connecting`** cuando el servidor abría y cerraba en el mismo
  paquete, porque el cierre aún no la había guardado.
- **La redacción reformateaba cada mensaje JSON**: la transcripción enseñaba otro texto del que
  viajó. Lo vio la prueba con bytes de verdad; la guionizada no comparaba cuerpos exactos.
- **El stream en vivo tenía un hueco** entre la instantánea y lo vivo, y su 409 salía con 200.

### Las tres cosas que la suite no puede ver, y cómo quedan

1. **El socket vive en un proceso.** Una sesión abierta en otra instancia es un 409 que lo dice, y
   no un stream vacío que parece una sesión callada. Relevar un descriptor entre procesos no existe.
2. **Un proceso muerto deja sesiones abiertas.** Cada instancia late por las suyas y cualquiera cierra
   las que llevan tres latidos sin dueño — nunca una viva.
3. **La redacción en los dos caminos**, estructural y con prueba sobre la fila y sobre la trama.

Un entorno sin escrituras deja escuchar y no deja mandar: la misma protección que un `POST` contra
producción, adaptada a lo que un socket es.

### Cómo se comprobó

Contra la pila desplegada, con `Channels1700000028000` aplicada y `ALLOW_PRIVATE_TARGETS=false`:
un `wss://` público de verdad —TLS, SNI y DNS reales— con upgrade 101, el saludo del servidor
recibido con la apertura, y el token tapado en lo enviado y en el eco (`{"token":"••••••••"}`).
`select … where body like '%TOKEN…%'` sobre mensajes, sesiones y canales: **0** en las tres. Un
`ws://sample-api:9000` quedó en `config` con «red privada (172.19.0.3)». Una sesión abandonada por
un script que murió la cerró el reloj por inactividad sin que nadie mirara. La suite `test/db`
—que se salta sin base y llevaba roja varias olas sin que nadie lo supiera— corrida contra una base
temporal: 27 de 27, incluida la que deshace todas las migraciones y las rehace.

No comprobado: dos instancias de la API detrás de un balanceador. Esta pila corre una; el 409 y el
segador están probados en la suite con una fila ajena, no con dos procesos.

`api 1015 pruebas · web 483 · runner-core 336 · import-detect 29 · lint 0 errores · typecheck limpio`

## Paridad con Postman, ola 10: GraphQL en el editor, y dos fallos que no eran de esta ola

GraphQL solo existía como nodo de flujo. En Postman es un modo de cuerpo de cualquier petición, con
el esquema cargado al lado. Y al importar, `mode: "graphql"` caía en el «no es raw» del lector: una
colección de GraphQL entraba entera y **ninguna operación mandaba nada**, sin decirlo.

### Un sexto modo de cuerpo, sin migración

`graphql` guarda la operación en `text` —el campo que ya comparten JSON y raw— y las variables en
`body.variables`, texto JSON con `{{plantillas}}`. Solo se guarda cuando trae algo, así que ningún
cuerpo existente cambia de forma. Por `POST` viaja `{query, variables}`; por `GET`, en la query de
la URL, como dice GraphQL sobre HTTP (antes un cuerpo en un `GET` se tiraba sin decirlo). Las
variables se sustituyen y **después** se leen: un valor con una comilla que rompe el JSON es un 422
con su código, no un 400 del servidor sobre un cuerpo que nadie escribió.

El esquema se pide por introspección con el mismo «Enviar» —entorno, cabeceras, autenticación,
script previo— o se lee de un fichero (SDL o introspección guardada), porque muchos servidores de
producción la tienen apagada. Con él, la operación se valida mientras se escribe y el explorador
lista consultas, mutaciones y suscripciones; elegir una la escribe con sus argumentos obligatorios
como variables. **No se guarda**: pesa lo que la API y cambia con cada despliegue. `graphql-js` va
en un trozo aparte (146 kB) que solo carga quien abre el modo.

### Postman e Insomnia, de ida y de vuelta

El lector guarda la operación aparte y además escribe el JSON que viaja, para quien no sabe de
GraphQL. Como endpoint entra en el modo nuevo; como flujo, en un nodo `graphql` —el que lee `errors`
en un 200—, que gana `auth` como el `fetch`: una colección de GraphQL lleva su autenticación como
cualquier otra. Al exportar, endpoint y nodo salen como `mode: "graphql"`; antes el nodo se quedaba
fuera «porque Postman no tiene nada equivalente».

Un límite del modelo, dicho y no escondido: un endpoint es uno por método y ruta (índice único), y
todas las operaciones comparten `POST /graphql`. La segunda operación de una colección no se importa
como endpoint, y el motivo lo dice: entra como nodo del flujo. Por eso tampoco hay «un endpoint por
operación del SDL»; el SDL alimenta el explorador.

### Dos fallos anteriores, y los dos graves

- **HTTPS no funcionaba contra ningún servidor con certificado normal.** La guarda de SSRF fijaba la
  IP escribiéndola en la URL; TLS comparaba el certificado con `199.232.157.51` y fallaba como
  «fetch failed». Enviar, corridas, monitores e import por URL, contra cualquier API HTTPS pública.
  Todas las pruebas eran HTTP en loopback. Ahora la IP va en el `lookup` de un `Agent` de undici y
  el nombre se queda en la URL, como ya hacía el WebSocket. Hay prueba contra un servidor HTTPS con
  una CA de prueba, y falla con el código anterior.
- **Una contraseña escrita a mano se guardaba en claro.** El registro de la ola 1 dice que el
  servidor vacía los secretos literales al guardar; no lo hacía, solo el import de Postman.
  `{"password": "hunter2"}` llegaba tal cual a la columna del endpoint y al documento del flujo.
  Ahora se tapa en cada puerta que escribe una autenticación: endpoint, flujo (`fetch` y `graphql`),
  import de proyecto y copia entre proyectos. En la base de esta pila no había ninguna fila antigua
  con un literal, así que no hizo falta migración.

Y uno de la propia ola, visto en la pila: los nodos exportados se llamaban todos
`GQL {{baseUrl}}/graphql`. Ahora salen con su nombre.

### Cómo se comprobó

Contra la pila desplegada y una API GraphQL pública de verdad (`countries.trevorblades.com`, HTTPS):
`POST` y `GET` con la variable del entorno dentro, 200 con `Madrid`; una operación con un campo
inexistente, 200 con `errors`; introspección por «Enviar», 29 kB y 15 tipos. Una colección de
Postman con dos operaciones y `bearer {{token}}`: 1 endpoint en modo graphql, la segunda omitida con
su motivo, un flujo de 2 nodos `graphql` con su auth. Corrido: el bueno en verde, el roto en rojo
por `errors` aunque el estado fue 200, la cabecera tapada en el informe y el token en **0** filas de
`run_steps` y `run_cases`. Exportado de vuelta como `mode: "graphql"`. Un literal en la auth de un
endpoint y de un flujo: vacío al leer, y **0** coincidencias en la base. Datos de la prueba borrados.

No comprobado: la pantalla en el navegador (para entrar hace falta escribir una contraseña). El
editor, el explorador y el modo por GET están cubiertos por pruebas de componente.

`api 1035 pruebas · web 503 · runner-core 336 · import-detect 29 · lint 0 errores · typecheck limpio`

## Paridad con Postman, ola 11: el visualizador

`pm.visualizer.set(plantilla, datos, opciones)` en el script posterior, y una pestaña «Visualizar»
en la respuesta que lo dibuja. Antes, una colección de Postman que lo usaba se importaba bien y al
enviar fallaba con un `TypeError` sobre `undefined`.

### Dónde corre cada cosa

El script sigue en su proceso aislado y **no dibuja nada**: deja la plantilla y los datos como
texto, los datos serializados en el momento de la llamada. Vuelven leídos como el resto del
resultado, sin fiarse (JSON válido, tamaños: 200 kB de plantilla, 2 MB de datos), y con los secretos
tapados. Los datos se tapan recorriéndolos y no sobre su texto: un secreto numérico o usado como
clave rompería el JSON y el marco no recibiría nada.

La plantilla es código —Handlebars la compila a una función, y un `<script>` en ella corre tal
cual— y viene de un script que escribió cualquiera con permiso de edición o que trajo una colección
importada. Así que se dibuja en un `iframe` con `sandbox="allow-scripts"` y **sin**
`allow-same-origin`: origen opaco, sin cookies, sin almacenamiento, sin alcance a la página que
tiene la sesión. Handlebars va dentro del documento del marco, y nada de la plantilla toca esta
página. Es el modelo de Postman, y las plantillas escritas para él funcionan igual: `pm.getData`
responde de forma asíncrona, y una librería de gráficos desde un CDN carga. El componente va en un
trozo aparte (92 kB) que solo carga quien abre la pestaña.

En una corrida no hay panel de respuesta: un nodo de script que llama a `pm.visualizer` lo dice en
su informe en vez de parecer que no hizo nada.

### Cómo se comprobó

Pruebas del proceso real (se guarda en el momento de la llamada, `clear`, no existe en el previo,
datos circulares con su error), de la lectura sin fiarse, del tapado estructural y de la ruta HTTP
con un secreto del entorno dentro de los datos. El documento del marco se ejecutó en jsdom: dibuja,
escapa lo que viene de la respuesta, un `</script>` en los datos no cierra el script que los lleva,
`pm.getData` entrega, una plantilla rota explica por qué y las opciones llegan a Handlebars.

En Chromium de verdad, el mismo documento en un marco con el mismo `sandbox`: `origin=null`, el
padre, las cookies y `localStorage` bloqueados, `pm.getData` entrega, y Chart.js cargado desde
jsDelivr dibuja su gráfico. En la pila desplegada, «Enviar» contra una API GraphQL pública por HTTPS
con un script que visualiza la respuesta: 200 y 14 filas en `visualization.data`. Datos de la prueba
borrados.

No comprobado: la pestaña dentro de la aplicación, en el navegador (para entrar hace falta escribir
una contraseña); la cubre una prueba de componente. La prueba en la pila no pudo usar una variable
secreta: crear una devuelve 500 porque `SECRETS_KEY` de `docker/.env` no mide 32 bytes. Es el fallo
de configuración ya conocido, y no se tocó.

`api 1040 pruebas · web 509 · runner-core 336 · lint 0 errores · typecheck limpio`

## Paridad con Postman, ola 12: MQTT, gRPC, bifurcaciones, captura por proxy y lo pendiente

Siete agentes en paralelo, cada uno en su worktree, integrados uno a uno en `main` y probados juntos
en la pila. MQTT y gRPC tocaban el mismo módulo de canales: el segundo se integró con un merge hecho
por el propio agente de gRPC sobre `main`, que conocía su código.

### MQTT como canal

Una fila más de `channel_endpoints` (`protocol: "mqtt"`), con una columna `mqtt` (versión 3.1.1 o 5,
id de cliente, keepalive, sesión limpia, suscripciones) y tema, QoS y retain por mensaje
(`ChannelMqtt1700000029000`). Usuario y contraseña van en `auth` como `basic`: la misma puerta de
`redactAuth`. La guarda es la de siempre —`resolveTarget` con los esquemas del broker y el socket
abierto contra la IP comprobada, el nombre en SNI y certificado—, sin reconexión. `PacketSizeGuard`
lee la cabecera fija y corta antes de que un `PUBLISH` gigante entre en memoria: `mqtt-packet` no
tiene tope. Un `CONNACK` o `SUBACK` rechazado es un rojo con su código y su nombre. Las
comprobaciones aceptan `match.topic` con `+` y `#`.

### gRPC como canal

`.proto` subidos (tabla `channel_proto_files`, aparte para no cargarlos al listar) o reflexión v1 con
v1alpha de reserva; las cuatro formas de llamada, plazo, estado y trailers
(`ChannelGrpc1700000030000`). La conexión va a la IP comprobada con `default_authority` y
`ssl_target_name_override` en el nombre, así que TLS valida contra el nombre; sin proxy, sin
reintentos, tope de mensaje dentro de grpc-js. runner-core gana los trailers en la conversación, las
cabeceras tapadas dentro de `applyFrame` y la expectativa `status` («Estado OK (0)»); un canal gRPC
nace afirmándolo. En un entorno sin escrituras solo se llaman métodos `NO_SIDE_EFFECTS`.

Los dos agentes encontraron el mismo fallo de la ola 10 por su lado: **la autenticación de un canal
WebSocket guardaba el secreto escrito a mano en claro**, porque el arreglo de los secretos literales
no cubría los canales. Ahora pasa por `redactAuth` y `storableHeader` en los tres protocolos.

### Bifurcar, traer y fusionar

Bifurcar **sustituye** a «copiar de otro proyecto», que se borra: ruta, DTO, handler y pantalla. La
entrada nueva está en el menú «⋯» del proyecto. La tabla `project_forks` (`1700000031000`) guarda el
original, la foto común sin secretos y el linaje de ids. La comparación es a tres bandas y pura: el
endpoint por método y ruta; pruebas, flujos y entornos por par de ids o por nombre. Estados
`incoming`, `kept`, `same`, `conflict`; un conflicto sin decidir es 422, una vista previa vieja es
409, y el plan se escribe en una transacción. La foto común nueva es siempre la del origen, así que lo
que gana el destino no se pierde ni vuelve en silencio. Un entorno fusionado conserva los secretos
que el destino ya tenía.

### Captura de tráfico por proxy

Cuarta pestaña del diálogo de importar, no una puerta nueva: lo elegido se escribe como HAR y entra
por `ImportAnythingCommand`. El proxy está apagado sin `CAPTURE_PROXY_PORT` y cerrado sin sesiones;
token de 256 bits por sesión en `Proxy-Authorization` (se guarda su SHA-256), caducidad de 30 min,
tope de peticiones, y cada petición y cada túnel pasan por `resolveTarget` hacia la IP comprobada.
HTTPS va en túnel sin interceptar: se graba `host:puerto`. MITM no se hizo: no hay biblioteca X.509 y
la clave de la CA sería lo más valioso de la instalación (`CaptureSessions1700000032000`).

**Un fallo que salió en la pila, no en la suite.** La redacción tapaba por nombre de campo, y httpbin
devuelve la URL de la petición en un campo `"url"`: `?api_key=…` se guardaba en claro en la fila.
Ahora los valores de las credenciales que viajaron —`Authorization` sin esquema, cookies, cabeceras
de clave, query y campos de credencial de petición y respuesta— se tapan **por su valor** en toda la
fila, también codificados en URL o escapados en JSON. Del `Set-Cookie` solo cuenta el primer par: el
`Domain` no es un secreto.

### Lo pequeño

- **Export a Postman con formularios**: `form-data` y `urlencoded` salían sin cuerpo, y un nodo de
  flujo con formulario como texto. Un fichero sale sin `src` y avisado; un campo con nombre de
  credencial y valor literal, vacío y desactivado.
- **Autocompletado GraphQL** con `graphql-language-service`: campos, argumentos, tipos, variables,
  directivas y enums. Convive con la lista de `{{variables}}`. El trozo de GraphQL pasa a 204 kB; el
  principal no cambia.
- **Editar un monitor** con el mismo formulario de crear; el horario solo se manda si cambió.
- **Zip64** en `readZip`, con los mismos topes.
- **Canales WebSocket**: buscar en la conversación, guardar el borrador en la biblioteca, y los
  mensajes resuelven `{{variables}}` (antes viajaban con las llaves).
- **La invitación a una organización sale por correo**, deuda de P1.

### Cómo se comprobó

Suite entera sobre `main` integrado: `api 1139 · web 558 · runner-core 353 · import-detect 35 · lint
0 errores · typecheck limpio`. En la pila, con las cuatro migraciones aplicadas por el servicio
`migrate` contra Postgres (hubo que reconstruir su imagen, que es aparte de la de la API):

- **gRPC** contra `grpcb.in` por TLS: la reflexión lista seis servicios; `SayHello` con `{{tema}}`
  en el mensaje contesta `hello eq-probe-…`, estado 0.
- **MQTT** contra `broker.hivemq.com`, 3.1.1 y 5: suscribe `{{tema}}/#`, publica, recibe el eco y el
  veredicto sale verde. `test.mosquitto.org` cierra sin `CONNACK` a ratos también con la biblioteca
  sola, sin nuestro código: es el broker, no el canal.
- **Bifurcación**: dos endpoints, un token literal en uno, bifurcar, cambiar los dos lados. Traer da
  `GET /orders=incoming` y `GET /users=conflict` con el campo que choca; sin decidir, 422; con
  decisión, se aplica; fusionar lleva el cambio al original. El token literal en **0** filas de
  `endpoints` y de `project_forks`.
- **Captura**: sin token o con uno malo, 407; http público, 200 y grabado; túnel HTTPS, 200 y grabado
  sin contenido; `postgres:5432` y `169.254.169.254`, 403; tras parar, el token deja de valer. Import
  por el camino del HAR. Tras el arreglo, **0** filas con los cuatro secretos de la prueba.

Datos de la prueba borrados; la API vuelve a arrancar sin el puerto del proxy.

No comprobado: las pantallas nuevas en el navegador (entrar pide escribir una contraseña).
Pendiente: solicitudes de fusión con revisión, sincronizar suites y roles entre bifurcaciones,
añadir temas MQTT a mitad de sesión, will y propiedades de MQTT 5, metadata gRPC binaria, que corridas
y monitores invoquen canales, reconectar un WebSocket, y el reimport de un campo de fichero de
Postman. Y sigue `SECRETS_KEY`: 48 bytes en `docker/.env`, sin tocar; con ella, crear una variable
secreta es un 500.
