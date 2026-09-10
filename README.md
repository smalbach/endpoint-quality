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

    Interfaz    http://localhost:8080   demo@example.com / una-contraseña-de-demo
    API         http://localhost:3001   su propio contrato en /openapi.json
    Muestra     http://localhost:9100

`scripts/demo.sh down` lo para y borra el volumen. Si algún puerto está ocupado:
`EQ_WEB_PORT=8081 scripts/demo.sh` — también `EQ_API_PORT`, `EQ_POSTGRES_PORT` y
`EQ_SAMPLE_PORT`.

## Desplegarlo

```bash
cp docker/.env.example docker/.env    # y genera los tres secretos: ver más abajo
docker compose -f docker/compose.yml up -d
```

Cuatro servicios: `postgres`, `migrate`, `api`, `web`. `migrate` es un paso propio con su propio
código de salida, y `api` no arranca hasta que termina bien. No es `migrationsRun` al arrancar a
propósito: eso ata «el esquema cambió» a «un proceso arrancó», cada réplica de un despliegue lo
intentaría a la vez, la API atendería peticiones con el DDL a medias, y una migración que falla
parecería un *crash loop* en vez de una migración fallida.

La interfaz queda en `http://localhost:8080` y la API detrás de `/api`, **mismo origen**. Eso no es
cosmético: la cookie de refresh es `httpOnly` y `SameSite=Strict`, y para que lo segundo signifique
algo no puede haber un segundo sitio. Si sirves la interfaz desde otro dominio, tendrás que
reconstruirla con `VITE_API_URL` y aflojar la cookie, que es exactamente lo que esta forma evita.

### Las variables que importan

| Variable | Por defecto | Qué pasa si te equivocas |
|---|---|---|
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | *ninguno* | La API **se niega a arrancar** sin ellos. Un valor por defecto en un fichero versionado firma las sesiones de todo el mundo con la misma clave. Cambiarlos cierra todas las sesiones. |
| `SECRETS_KEY` | *ninguno* | Cifra las credenciales de los destinos con AES-256-GCM. **Perderla es perderlas**: no hay forma de descifrarlas sin ella, que es la única propiedad que hace que guardarlas valga la pena. Guárdala donde guardes las contraseñas de producción. |
| `ALLOW_PRIVATE_TARGETS` | `false` | El motor pide URLs que escribe quien usa el producto. En `true`, cualquiera con una cuenta puede apuntarlo a `169.254.169.254` o a tu base de datos y leer la respuesta. Déjalo en `false` salvo que el producto y los destinos vivan en la misma máquina de alguien. |
| `QUEUE_DRIVER` | `memory` | `memory` ejecuta la cola en el propio proceso: sin infraestructura, y una corrida muere si la API se reinicia. `redis` es lo que quiere una instancia compartida. |
| `CORS_ORIGINS` | `http://localhost:8080` | Solo hace falta si sirves la interfaz desde otro origen. |
| `EQ_*_PORT` | 8080 / 3001 / 5432 | Los puertos publicados hacia fuera. Nada más. |

Genera los tres secretos así, una vez, y guárdalos:

```bash
openssl rand -base64 48 | tr -d '\n='
```

### Redis, cuando haga falta

```bash
QUEUE_DRIVER=redis docker compose -f docker/compose.yml --profile redis up -d
```

Con `memory`, una corrida vive en el proceso que la lanzó. Con `redis` sobrevive a un reinicio y
varias avanzan a la vez. **El stream SSE de progreso sigue siendo por proceso**: con varias
instancias detrás de un balanceador, un cliente conectado a la instancia B no ve el progreso de una
corrida que ejecuta la A, y cae al sondeo. Hace falta un relé por pub/sub para arreglarlo; está
anotado como deuda en `docs/phase-log.md`.

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
faltan argumentos, el token no vale, la API no responde. Los casos *saltados* —una escritura contra
un entorno de solo lectura— no rompen la build salvo que se lo pidas con `--fail-on-skip`: no son
un hallazgo sobre la API, y reportarlos como tal enseña a la gente a ignorar el rojo.

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

## Estructura

    apps/api          NestJS 11 + @nestjs/cqrs — comandos, consultas, saga de ejecución
    apps/web          Vite + React 19 + Tailwind — SPA, sin SSR
    packages/
      runner-core     Dominio puro: generación de escenarios, plan de ejecución,
                      presupuestos, validación JSON Schema. Sin framework.
      spec-import     OpenAPI 3.0/3.1 → Operation[]
    docker            Dockerfiles y compose; compose.demo.yml añade la muestra
    examples/
      sample-api      El destino de la demostración, con su fallo a propósito
    tools             eq-run (CI), seed-demo, migración del proyecto original
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
