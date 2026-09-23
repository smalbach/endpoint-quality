"""
El identificador que une todo lo que pasa por una misma petición.

Portado de `apps/api/src/shared/logging/trace-context.ts` y su middleware. No es una comodidad de
registro: **sale al cliente**, en la cabecera `X-Trace-Id` de toda respuesta y dentro del cuerpo
RFC 9457 de un error. Quien informa de un fallo trae el número, y buscarlo devuelve la petición
entera en vez de «hacia las cuatro».

Por eso está aquí: dos backends que contestan el mismo error, uno con `traceId` y otro sin él, son
dos contratos distintos — y el guion de conformidad lo señala como divergencia, que es exactamente
como se descubrió que faltaba.

Un identificador que llega en la cabecera se acepta **pero se valida**, con la misma forma cerrada
que allí: permite seguir una operación que empezó en otro sitio, y una cabecera que el cliente
escribe sin filtrar acabaría en una línea del registro — un salto de línea ahí inventa entradas
enteras.
"""

from __future__ import annotations

import re
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

TRACE_HEADER = "x-trace-id"
TRACE_HEADER_OUT = "X-Trace-Id"

_SAFE_TRACE_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def trace_id_from(header: str | None) -> str:
    """El que trae el cliente si tiene forma de identificador, y uno nuevo si no. Nunca falla: una
    cabecera rara da una traza nueva, no un error."""
    return header if header and _SAFE_TRACE_ID.match(header) else str(uuid.uuid4())


def current_trace_id(request: Request) -> str | None:
    """Lo que lleva esta petición. En `request.state` y no en un `contextvars`: aquí quien lo
    necesita —los manejadores de error— ya recibe la petición, y un almacén paralelo sería una
    segunda fuente de verdad para el mismo dato."""
    return getattr(request.state, "trace_id", None)


class TraceMiddleware(BaseHTTPMiddleware):
    """Lo primero que toca una petición: darle su identificador y devolverlo.

    La cabecera va en **toda** respuesta, no solo en los errores, igual que allí: es lo que permite
    citar una petición que salió bien pero tardó, o que devolvió algo raro."""

    async def dispatch(self, request: Request, call_next) -> Response:
        trace_id = trace_id_from(request.headers.get(TRACE_HEADER))
        request.state.trace_id = trace_id
        response = await call_next(request)
        response.headers[TRACE_HEADER_OUT] = trace_id
        return response
