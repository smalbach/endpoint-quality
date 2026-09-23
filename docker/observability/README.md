# Observabilidad, como perfil aparte

Prometheus y Grafana no arrancan con el producto: son un perfil, igual que Redis. Una instalación
local no los necesita —el registro JSON a `stdout` y `jq` contestan lo mismo— y dos contenedores
más no deberían ser el precio de probar la aplicación.

## Encenderlo

La API **no expone `/metrics` mientras nadie ponga una credencial**. Genera una y escríbela en los
dos sitios que la usan: el entorno de la API y el fichero que lee Prometheus.

```bash
printf '%s' "$(openssl rand -base64 36 | tr -d '\n/+=' | head -c 48)" > docker/observability/metrics-token
```

`printf` y no `echo`: sin salto de línea al final. Después, con ese mismo valor en `.env` como
`METRICS_TOKEN`:

```bash
docker compose -f docker/compose.yml --profile observability up -d
```

Grafana queda en `http://localhost:3000` con el panel «Endpoint Quality · API» ya provisionado y
Prometheus en `http://localhost:9090`.

## Lo que hay que saber

- **El fichero del token no entra en el repositorio** (está en `.gitignore`). Si lo cambias,
  reinicia Prometheus: lo lee en cada raspado, pero la API solo lee su variable al arrancar.
- **Prometheus raspa por la red de compose** (`api:3001`), no por el puerto publicado. El token
  protege del resto: `/metrics` sale por el mismo puerto que la API y enseña rutas internas,
  memoria y carga del proceso.
- **Grafana entra sin contraseña como «Viewer»** para que el panel se abra de un clic. Eso vale en
  una máquina de desarrollo o en una red interna; si publicas el puerto 3000 hacia fuera, apaga
  `GF_AUTH_ANONYMOUS_ENABLED` y pon una contraseña de administrador de verdad.
- **Los paneles son ficheros de este directorio.** Uno construido a mano en la pantalla vive en el
  volumen de Grafana, se pierde con él y no se puede revisar en un diff.

## Qué mirar primero

| Pregunta                           | Dónde                                            |
| ---------------------------------- | ------------------------------------------------ |
| ¿Qué operación se ha vuelto lenta? | «p95 por operación» y «las diez más lentas»      |
| ¿Se está rompiendo algo?           | «Tasa de error (5xx)»                            |
| ¿Es la API o es la máquina?        | «El proceso: memoria y bucle de eventos»         |
| ¿Qué pasó en **esta** petición?    | El registro, por su `traceId` (ver `X-Trace-Id`) |
