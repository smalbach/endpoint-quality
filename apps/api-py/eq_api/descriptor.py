"""
Qué es este backend y hasta dónde llega hoy.

`modules` es un resumen de lo que ya pasa `tools/conformance`, no una intención. Un módulo sube a
`full` **después** de que el guion de paridad lo dé por bueno contra los tres backends: el front
apaga lo que dice `none` y confía en lo que dice `full`, así que un descriptor optimista es peor
que ninguno.
"""

from __future__ import annotations

API_MODULES = (
    "auth",
    "iam",
    "projects",
    "specs",
    "environments",
    "config",
    "endpoints",
    "collections",
    "workflows",
    "runs",
    "security-runs",
    "performance",
    "mocks",
    "docs",
    "monitors",
    "channels",
    "captures",
    "roles",
    "code-scan",
    "dashboard",
)

IMPLEMENTED: dict[str, str] = {
    "auth": "full",
    "iam": "full",
    # `partial` y no `full`: están las seis rutas del CRUD —listar, crear, ver, editar, archivar y
    # borrar— y no están las de contrato, bifurcación, solicitudes de fusión, importación ni
    # exportación, que cuelgan del mismo controlador en el original.
    "projects": "partial",
}

DESCRIPTOR = {
    "id": "python",
    "name": "FastAPI",
    "runtime": "python 3.11 · fastapi · asyncpg",
    "version": "0.1.0",
    "reference": False,
    "modules": {module: IMPLEMENTED.get(module, "none") for module in API_MODULES},
}
