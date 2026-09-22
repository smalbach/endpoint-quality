# `@eq/api-py` — la misma API, en FastAPI

Una de las tres implementaciones del contrato de Endpoint Quality. La de referencia es
`apps/api` (NestJS); el plan, el contrato que hay que cumplir y la hoja de ruta están en
[`docs/backends-poliglotas.md`](../../docs/backends-poliglotas.md).

**No aplica migraciones.** El esquema es de `apps/api` y solo de él: aquí se lee y se escribe en
tablas que ya existen, con las columnas entrecomilladas porque TypeORM las creó en `camelCase`.

## Levantarlo

```bash
uv venv .venv
uv pip install --python .venv/bin/python -e ".[dev]"

# Las mismas variables que la API de Node, con su propio puerto. Que los secretos sean los mismos
# es lo que hace que una sesión abierta contra una siga viva contra la otra.
DATABASE_URL=postgres://eq:eq@localhost:5432/endpoint_quality \
JWT_ACCESS_SECRET=… JWT_REFRESH_SECRET=… PORT_PY=3002 \
  .venv/bin/python -m eq_api
```

`../../dev.sh` lo levanta junto con los otros dos y el front.

## Probarlo

```bash
.venv/bin/python -m pytest          # las piezas que tienen que coincidir byte a byte
node ../../tools/conformance/run.mjs  # la paridad de verdad, con los tres levantados
```

## Por dónde está

    eq_api/
      app.py          la aplicación: CORS, manejadores de error, /health y /backend
      config.py       el entorno, con los nombres de la API de Node
      crypto.py       scrypt, SHA-256 en base64 y HS256 — las tres que no admiten estilo
      db.py           el pool y la fecha con el formato de `JSON.stringify`
      domain.py       las reglas portadas desde `modules/*/domain/`
      identity.py     quién llama (JWT o `eqt_`) y si puede (rol contra la base)
      problems.py     RFC 9457, con los mismos `type`, títulos y códigos
      rate_limit.py   el freno de las rutas sin credencial
      repositories.py SQL directo contra el esquema de `apps/api`
      validation.py   los mensajes exactos del ValidationPipe de Nest
      routes/         auth, iam y projects
