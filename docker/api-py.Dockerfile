# syntax=docker/dockerfile:1
#
# La API en Python (FastAPI), una de las tres implementaciones del mismo contrato.
#
# **No aplica migraciones.** El esquema es de `apps/api` y solo de él: esta imagen se levanta
# después del servicio `migrate`, igual que la de Node, y nunca emite DDL. Ver
# `docs/backends-poliglotas.md` §2.
FROM python:3.12-slim AS build
WORKDIR /app

# El manifiesto primero, para que la capa de dependencias sobreviva a cualquier cambio de código.
COPY apps/api-py/pyproject.toml ./
# En un entorno virtual y no en el intérprete del sistema: lo que se copia a la imagen final es un
# directorio, no un conjunto de paquetes esparcidos por `/usr/lib`.
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv/bin/pip install --no-cache-dir fastapi "uvicorn[standard]" asyncpg pyjwt

FROM python:3.12-slim AS runtime
WORKDIR /app
ENV PATH="/opt/venv/bin:$PATH" PYTHONUNBUFFERED=1
# Sin root: un proceso que atiende peticiones no debería además ser root dentro de su contenedor.
RUN useradd --system --create-home --uid 10001 eq

COPY --from=build /opt/venv /opt/venv
COPY --chown=eq:eq apps/api-py/eq_api ./eq_api
COPY --chown=eq:eq apps/api-py/pyproject.toml ./

USER eq
EXPOSE 3002
CMD ["python", "-m", "eq_api"]
