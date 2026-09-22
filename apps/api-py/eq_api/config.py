"""
Las variables de entorno, leídas una vez y validadas al arrancar.

Los nombres son **los mismos** que los de la API de NestJS a propósito: los tres backends se
levantan con el mismo `.env`, y la única diferencia es el puerto. Un segundo juego de nombres
(`EQ_PY_JWT_SECRET`) sería una forma garantizada de firmar con claves distintas y descubrirlo
cuando una sesión abierta en un backend no valga en el otro.

Se niega a arrancar sin los dos secretos de JWT, igual que la de Nest: un valor por defecto en el
código firma las sesiones de todo el mundo con la misma clave.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw else default


def parse_duration(value: str) -> int:
    """`15m`, `2h`, `900`. Un valor que no se entiende son 900 segundos, como en `parseDuration`
    de Nest — no un token sin caducidad, que es lo que saldría de tratarlo como `0`."""
    match = re.fullmatch(r"(\d+)([smhd])?", value.strip())
    if not match:
        return 900
    amount = int(match.group(1))
    unit = match.group(2) or "s"
    return amount * {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]


@dataclass(frozen=True)
class Settings:
    port: int
    database_url: str
    jwt_access_secret: str
    jwt_refresh_secret: str
    access_token_ttl_seconds: int
    refresh_token_ttl_days: int
    cors_origins: list[str]
    cookie_domain: str | None
    node_env: str
    app_url: str

    @property
    def production(self) -> bool:
        return self.node_env == "production"


def load_settings() -> Settings:
    access_secret = os.environ.get("JWT_ACCESS_SECRET", "")
    refresh_secret = os.environ.get("JWT_REFRESH_SECRET", "")
    if not access_secret or not refresh_secret:
        raise RuntimeError("JWT_ACCESS_SECRET y JWT_REFRESH_SECRET son obligatorias: la API no arranca sin ellas")

    return Settings(
        # Puerto propio: los tres backends corren a la vez contra la misma base, y es lo que hace
        # que el selector del front pueda cambiar de uno a otro sin apagar nada.
        port=_int("PORT_PY", 3002),
        database_url=os.environ.get("DATABASE_URL", "postgres://eq:eq@localhost:5432/endpoint_quality"),
        jwt_access_secret=access_secret,
        jwt_refresh_secret=refresh_secret,
        access_token_ttl_seconds=parse_duration(os.environ.get("ACCESS_TOKEN_TTL", "15m")),
        refresh_token_ttl_days=_int("REFRESH_TOKEN_TTL_DAYS", 30),
        cors_origins=[
            origin.strip()
            for origin in os.environ.get("CORS_ORIGINS", "http://localhost:8080,http://localhost:5173").split(",")
            if origin.strip()
        ],
        cookie_domain=os.environ.get("COOKIE_DOMAIN") or None,
        node_env=os.environ.get("NODE_ENV", "development"),
        app_url=os.environ.get("APP_URL", "http://localhost:5173"),
    )
