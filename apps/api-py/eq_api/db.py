"""
La conexión a Postgres, y las dos conversiones que hacen que lo que sale de aquí se parezca a lo
que sale de la API de NestJS.

**Este backend no emite DDL.** Las migraciones son de `apps/api` y solo de él: tres procesos
aplicando migraciones sobre la misma base es una carrera con final impredecible, y TypeORM ya
lleva el historial. Aquí solo se lee y se escribe en tablas que ya existen.

Las columnas van entrecomilladas en todas las consultas porque TypeORM las creó en `camelCase`, y
en Postgres un identificador sin comillas se pliega a minúsculas: `"organizationId"` existe,
`organizationid` no.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import asyncpg


def iso(value: datetime | None) -> str | None:
    """Una fecha como la escribe `JSON.stringify` sobre un `Date`: UTC, milisegundos, y `Z`.

    `datetime.isoformat()` daría `+00:00` y microsegundos, que es válido y **distinto**. El front
    compara y ordena estas cadenas, y dos backends que las escriban diferente producen listas que
    se ordenan diferente según quién conteste."""
    if value is None:
        return None
    utc = value.astimezone(timezone.utc)
    return f"{utc.strftime('%Y-%m-%dT%H:%M:%S')}.{utc.microsecond // 1000:03d}Z"


def now() -> datetime:
    return datetime.now(timezone.utc)


async def _init_connection(connection: asyncpg.Connection) -> None:
    # Sin esto, asyncpg entrega el `jsonb` como texto y `tags` llegaría al front como la cadena
    # "[]" en vez de como una lista.
    for kind in ("json", "jsonb"):
        await connection.set_type_codec(kind, encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


class Database:
    """El pool, con el ciclo de vida atado al de la aplicación."""

    def __init__(self, url: str) -> None:
        # asyncpg no entiende el esquema `postgres://` con parámetros de TypeORM, pero sí la forma
        # básica; `postgresql://` es el nombre que espera.
        self._url = url.replace("postgres://", "postgresql://", 1)
        self._pool: asyncpg.Pool | None = None

    async def connect(self) -> None:
        self._pool = await asyncpg.create_pool(self._url, min_size=1, max_size=10, init=_init_connection)

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    @property
    def pool(self) -> asyncpg.Pool:
        if self._pool is None:
            raise RuntimeError("La base de datos no está conectada")
        return self._pool

    async def fetch(self, query: str, *args: Any) -> list[asyncpg.Record]:
        return await self.pool.fetch(query, *args)

    async def fetchrow(self, query: str, *args: Any) -> asyncpg.Record | None:
        return await self.pool.fetchrow(query, *args)

    async def execute(self, query: str, *args: Any) -> str:
        return await self.pool.execute(query, *args)

    async def healthy(self) -> tuple[bool, str | None]:
        try:
            await self.pool.fetchval("SELECT 1")
        except Exception as error:  # noqa: BLE001 — la sonda informa de cualquier fallo, no elige
            return False, str(error) or "sin detalle"
        return True, None
