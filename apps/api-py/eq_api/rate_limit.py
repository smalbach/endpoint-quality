"""
El freno de las rutas que no piden credencial.

En memoria del proceso, como el `QUEUE_DRIVER=memory` del original: con una sola instancia es
exacto, y con varias cada una cuenta la suya. La API de Nest puede compartir los contadores por
Redis; aquí no hace falta todavía porque este backend se despliega en un proceso, y anotarlo es
mejor que fingir que cuenta lo mismo que aquél detrás de un balanceador.

Se cuenta por IP y por nombre de la operación, no por ruta completa: `POST /auth/login` con dos
cuerpos distintos es el mismo intento de adivinar una contraseña.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import Request

from .problems import RateLimitedError

_hits: dict[tuple[str, str], deque[float]] = defaultdict(deque)


def _client(request: Request) -> str:
    # Detrás del proxy del front, la IP del socket es la del proxy: `X-Forwarded-For` es lo que
    # distingue a dos personas. Solo se lee el primer salto, que es el que el proxy propio escribe.
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "desconocido"


def throttle(request: Request, operation: str, *, limit: int, window_seconds: int) -> None:
    key = (operation, _client(request))
    window = _hits[key]
    now = time.monotonic()
    threshold = now - window_seconds
    while window and window[0] < threshold:
        window.popleft()
    if len(window) >= limit:
        raise RateLimitedError()
    window.append(now)


def reset() -> None:
    """Para los tests: un contador que sobrevive entre casos convierte el orden en el que corren
    en parte del resultado."""
    _hits.clear()
