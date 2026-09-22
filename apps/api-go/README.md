# `api-go` — la misma API, en Go

Una de las tres implementaciones del contrato de Endpoint Quality. La de referencia es
`apps/api` (NestJS); el plan, el contrato que hay que cumplir y la hoja de ruta están en
[`docs/backends-poliglotas.md`](../../docs/backends-poliglotas.md).

**No aplica migraciones.** El esquema es de `apps/api` y solo de él: aquí se lee y se escribe en
tablas que ya existen, con los identificadores entrecomillados porque TypeORM los creó en
`camelCase` y Postgres pliega a minúsculas lo que no lleva comillas.

Sin framework: `net/http` con los patrones de método y ruta de Go 1.22, y dos dependencias
(`pgx` para Postgres y `x/crypto` para scrypt). El JWT va escrito a mano — son cuarenta líneas, y
la única parte delicada, no fiarse del `alg` que venga dentro del token, se ve mejor escrita que
escondida detrás de una opción de configuración.

## Levantarlo

```bash
# Las mismas variables que la API de Node, con su propio puerto. Que los secretos sean los mismos
# es lo que hace que una sesión abierta contra una siga viva contra la otra.
DATABASE_URL=postgres://eq:eq@localhost:5432/endpoint_quality \
JWT_ACCESS_SECRET=… JWT_REFRESH_SECRET=… PORT_GO=3003 \
  go run .
```

`../../dev.sh` lo levanta junto con los otros dos y el front.

## Probarlo

```bash
go test ./...                          # las piezas que tienen que coincidir byte a byte
node ../../tools/conformance/run.mjs   # la paridad de verdad, con los tres levantados
```

## Por dónde está

    main.go               arranque y apagado ordenado
    internal/
      api/                el enrutado y las rutas: auth, iam, projects
        server.go         identidad, rol, freno de peticiones, /health y /backend
        validation.go     los mensajes exactos del ValidationPipe de Nest
      config/             el entorno, con los nombres de la API de Node
      crypto/             scrypt, SHA-256 en base64 y HS256 — las tres que no admiten estilo
      domain/             las reglas portadas desde `modules/*/domain/`
      problems/           RFC 9457, con los mismos `type`, títulos y códigos
      store/              SQL directo contra el esquema de `apps/api`
