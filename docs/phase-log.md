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
   comparado dos juegos de UUID recién generados y reportado *todas* las operaciones como
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

| Fallo del destino | Qué lo detecta |
|---|---|
| 200 con envelope roto | Pasa el status, falla el schema. **La tesis del producto en un test.** |
| POST 201 que no persiste los campos | El paso `act` está bien; falla la relectura |
| DELETE 204 que no borra | `delete-read` pasa, `deleted-read` falla |
| Destino lento | Falla el presupuesto y **solo** el presupuesto |
| 405 sobre operación declarada | Diagnóstico propio; silencia el resto y detiene el flujo |
| Errores sin Problem Details | `{ "error": "..." }` se rechaza |

Más las guardas: sin `writesAllowed` **no sale nada a la red** (comprobado contando las
peticiones que llegan al destino), una URL base inalcanzable falla como *conexión* y no como
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
  conectado a la instancia B no ve nada de una corrida que ejecuta la instancia A. El *fallback*
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
backend de Digital Catalog— como *placeholder* del formulario de entornos.

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
rechaza el cliente cae a *polling*, el *polling* gasta el mismo presupuesto, y el stream ya no
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

Las fases anteriores compararon *listas de casos*. Esto compara *resultados*, que es lo único que
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
limpia detrás de sí *para poder repetirse*, y "para poder" no es "demostradamente lo hace": una
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

El producto manda solo la credencial `primary`. Para demostrar que los diez son *un* defecto y no
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
por bueno. Es deliberadamente un fallo corriente y deliberadamente *aislado* —el flag se respeta en
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
   su servicio, su código de salida y un *advisory lock* de Postgres para el caso de dos
   contenedores de init a la vez. **No `migrationsRun` al arrancar**: eso ata «el esquema cambió» a
   «un proceso arrancó», cada réplica lo intenta, la API atiende con el DDL a medias, y una
   migración fallida parece un *crash loop*.
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
  opcional es lo que *es* un `PATCH`: su payload mínimo válido es `{}`, que es no mandar nada, y a
  eso varias APIs responden 422 con razón.
- **`readOnly` no viaja.** Lo dice OpenAPI, y una API que valida estricto responde 422 — seríamos
  nosotros provocando el fallo que luego reportamos.
- **`minLength`, `maxLength`, `minimum`, `multipleOf`, `minItems`** se respetan. Un valor que
  incumple la restricción que el propio contrato publicó sería esta herramienta escribiendo el 422.
- **Determinista.** Un cuerpo que cambia entre corridas hace dos corridas incomparables y un fallo
  irreproducible.
- **Nunca un objeto vacío.** Un objeto vacío *es* el caso `invalid-body`; devolverlo aquí haría que
  el caso de creación y el de cuerpo inválido mandaran el mismo payload y esperaran lo contrario.
- **El 409 no se deriva.** Necesita un payload que choque con una fila que ya está ahí, que es
  conocimiento sobre los datos y no sobre el schema. `conflictBody` sigue siendo configuración, y
  sin él sencillamente no hay caso de conflicto.

Y **la configuración sigue mandando**: un schema dice qué es estructuralmente válido; un proyecto
sabe qué es *aceptable* — qué tienda existe, qué EAN es real, qué nombre está cogido.

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
que un update parcial *es*. El 422 sale ahora del pipe, donde se decide por la forma de la
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
adivinar más allá del documento» no aplica, porque el patrón *es* el documento, y mandar otra cosa
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
