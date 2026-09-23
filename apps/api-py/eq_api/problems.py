"""
Todos los errores salen como RFC 9457, con la misma forma que los de la API de NestJS.

Esto no es cosmética compartida: el front ramifica sobre `problem.type` —`project-not-found`,
`email-taken`, `weak-password`— y enseña `errors[].field` junto al campo que lo causó. Un backend
que conteste el `{"detail": [...]}` de Pydantic con el mismo 422 rompe formularios enteros sin que
ningún código de estado lo delate.

El original es `apps/api/src/shared/errors/problem-details.filter.ts`.
"""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .tracing import TRACE_HEADER_OUT, current_trace_id

ErrorKind = Literal["not-found", "conflict", "invalid", "unauthenticated", "forbidden", "rate-limited"]

STATUS_BY_KIND: dict[str, int] = {
    "not-found": 404,
    "conflict": 409,
    "invalid": 422,
    "unauthenticated": 401,
    "forbidden": 403,
    "rate-limited": 429,
}

TITLE_BY_STATUS: dict[int, str] = {
    400: "Solicitud inválida",
    401: "No autenticado",
    403: "Sin permiso",
    404: "Recurso no encontrado",
    409: "Conflicto",
    413: "Cuerpo demasiado grande",
    415: "Tipo de contenido no soportado",
    422: "Entidad no procesable",
    429: "Demasiadas solicitudes",
    500: "Error interno",
}

PROBLEM_BASE = "https://endpoint-quality.dev/problems"

_logger = logging.getLogger("eq.problems")


class DomainError(Exception):
    """Un error del dominio, sin HTTP dentro.

    El `code` es lo que el cliente lee para ramificar sin interpretar prosa, y se convierte en el
    último segmento del `type`. Sin él, el `type` lleva el género del error, igual que allí."""

    def __init__(
        self,
        kind: ErrorKind,
        message: str,
        fields: list[dict[str, str]] | None = None,
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.fields = fields or []
        self.code = code


class NotFoundError(DomainError):
    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__("not-found", message, [], code)


class ConflictError(DomainError):
    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__("conflict", message, [], code)


class InvalidInputError(DomainError):
    def __init__(self, message: str, fields: list[dict[str, str]] | None = None, code: str | None = None) -> None:
        super().__init__("invalid", message, fields, code)


class UnauthenticatedError(DomainError):
    def __init__(self, message: str = "Credenciales inválidas", code: str | None = None) -> None:
        super().__init__("unauthenticated", message, [], code)


class ForbiddenError(DomainError):
    def __init__(self, message: str = "No tienes permiso sobre este recurso", code: str | None = None) -> None:
        super().__init__("forbidden", message, [], code)


class RateLimitedError(DomainError):
    """El freno, con el texto exacto que contesta la referencia.

    «ThrottlerException: Too Many Requests» es el mensaje que `@nestjs/throttler` pone en su
    excepción y que el filtro de allí deja pasar tal cual, en inglés y con el nombre de la clase
    dentro. Copiarlo no es admirarlo: es que el cuerpo de un 429 es tan parte del contrato como el
    de un 422, y un cliente que ramifique sobre `type` tiene que encontrar lo mismo en los tres.
    Está anotado como verruga de la referencia en `docs/backends-poliglotas.md`."""

    def __init__(self, message: str = "ThrottlerException: Too Many Requests") -> None:
        super().__init__("rate-limited", message, [], "429")


def problem_response(
    status: int,
    detail: str,
    instance: str,
    *,
    type_slug: str | None = None,
    errors: list[dict[str, str]] | None = None,
    trace_id: str | None = None,
) -> JSONResponse:
    body: dict[str, object] = {
        "type": f"{PROBLEM_BASE}/{type_slug or status}",
        "title": TITLE_BY_STATUS.get(status, "Error"),
        "status": status,
        "detail": detail,
        "instance": instance,
    }
    if errors:
        body["errors"] = errors
    # El último, como en el original: el orden de las claves es parte de la forma que compara el
    # guion de conformidad, y un cliente que lea el JSON entero lo ve igual en los tres.
    if trace_id:
        body["traceId"] = trace_id
    # `application/problem+json` y no `application/json`: es lo que el propio producto exige a las
    # APIs que analiza, y lo que el front usa para reconocer un error con forma.
    #
    # La cabecera se pone **también aquí** y no solo en el middleware: el manejador de lo
    # inesperado lo instala Starlette en su `ServerErrorMiddleware`, que envuelve a todos los
    # demás, así que un 500 se escribe por fuera de la traza y salía sin cabecera — con el número
    # dentro del cuerpo y no en la respuesta, que es la mitad inútil. Lo cazó el guion de
    # conformidad al empezar a exigir la cabecera en todas.
    headers = {TRACE_HEADER_OUT: trace_id} if trace_id else {}
    return JSONResponse(
        status_code=status, content=body, media_type="application/problem+json", headers=headers
    )


def _instance(request: Request) -> str:
    query = request.url.query
    return request.url.path + (f"?{query}" if query else "")


def _field_of(location: tuple[object, ...]) -> str:
    """El nombre del campo que Pydantic señala, sin el `body` de delante.

    Nest deduce el campo del prefijo del mensaje de `class-validator`; aquí se lee de `loc`, que
    es mejor información para el mismo sitio: el formulario que pinta el mensaje bajo el input."""
    parts = [str(part) for part in location if part not in ("body", "query", "path")]
    return ".".join(parts) if parts else "body"


def install_problem_handlers(app: FastAPI) -> None:
    @app.exception_handler(DomainError)
    async def _domain(request: Request, error: DomainError) -> JSONResponse:
        status = STATUS_BY_KIND[error.kind]
        return problem_response(
            status,
            error.message,
            _instance(request),
            type_slug=error.code or error.kind,
            errors=error.fields,
            trace_id=current_trace_id(request),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, error: RequestValidationError) -> JSONResponse:
        # 422 y no 400, como el `ValidationPipe` de Nest: «sintácticamente bien, semánticamente
        # mal» es exactamente lo que este producto afirma de las APIs que mira.
        return problem_response(
            422,
            "La solicitud no supera la validación",
            _instance(request),
            type_slug="422",
            errors=[
                {"field": _field_of(item.get("loc", ())), "detail": str(item.get("msg", "valor inválido"))}
                for item in error.errors()
            ],
            trace_id=current_trace_id(request),
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, error: Exception) -> JSONResponse:
        # Lo que se registra y lo que se contesta son distintos a propósito: el operador necesita
        # la causa, y quien llama no puede recibir nada que describa el interior del proceso.
        _logger.error("%s %s → 500", request.method, _instance(request), exc_info=error)
        return problem_response(
            500,
            "La solicitud no pudo completarse",
            _instance(request),
            type_slug="internal",
            trace_id=current_trace_id(request),
        )
