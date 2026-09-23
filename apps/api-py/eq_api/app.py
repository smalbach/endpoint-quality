"""
La aplicación: lo mismo que arma `main.ts` en el otro backend, con las piezas de este.

El orden importa en dos sitios y por los mismos motivos que allí: el CORS con credenciales antes
que nada, y los manejadores de errores instalados de forma que **ningún** fallo salga con una
forma que no sea Problem Details.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from .config import Settings, load_settings
from .crypto import hash_password
from .db import Database
from .descriptor import DESCRIPTOR
from .problems import install_problem_handlers
from .repositories import Repositories
from .tracing import TraceMiddleware
from .routes import auth as auth_routes
from .routes import iam as iam_routes
from .routes import projects as project_routes


@dataclass
class AppState:
    settings: Settings
    db: Database
    repositories: Repositories
    log: logging.Logger
    #: Un digest de una contraseña que no tiene nadie, calculado una vez, para que el camino del
    #: correo desconocido gaste el mismo trabajo que el del conocido. Sin él, el login contesta
    #: antes cuando la cuenta no existe, que es un oráculo de enumeración gratis.
    decoy_digest: str


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved = settings or load_settings()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    log = logging.getLogger("eq.api-py")

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        database = Database(resolved.database_url)
        await database.connect()
        app.state.eq = AppState(
            settings=resolved,
            db=database,
            repositories=Repositories(database),
            log=log,
            decoy_digest=hash_password("una contraseña que no tiene nadie"),
        )
        log.info("API (FastAPI) escuchando en el puerto %s · descriptor en /backend", resolved.port)
        try:
            yield
        finally:
            await database.close()

    app = FastAPI(
        title="Endpoint Quality API (FastAPI)",
        description=(
            "Implementación en Python de la misma API. Todos los errores son RFC 9457 "
            "(application/problem+json)."
        ),
        version=DESCRIPTOR["version"],
        lifespan=lifespan,
        # El documento propio se sirve donde el original lo sirve, para que el guion de paridad
        # pueda compararlos sin saber con quién está hablando.
        docs_url="/docs",
        openapi_url="/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # **Después** del CORS, porque `add_middleware` apila: el último declarado es el más externo, y
    # la traza tiene que envolverlo todo. En el original el middleware de traza va el primero de
    # `main.ts`, antes incluso de helmet, y por el mismo motivo — un preflight que contesta la capa
    # de CORS sin llegar al manejador también lleva su número.
    app.add_middleware(TraceMiddleware)

    install_problem_handlers(app)

    @app.get("/health", tags=["health"])
    async def health(request: Request) -> dict:
        """La sonda, con la forma de las que este producto afirma.

        **Consulta de verdad la base de datos** en vez de informar de que el proceso está vivo: una
        sonda que solo sabe decir «ok» es el `pass: true` a mano que este producto existe para cazar.

        El código es 200 también cuando la base no contesta, y el veredicto va en `status`. No es
        lo que uno elegiría de cero —503 es lo que un balanceador entiende— sino lo que hace el
        backend de referencia (`health.controller.ts` devuelve el objeto sin tocar el código), y
        aquí manda la paridad: dos sondas que contestan códigos distintos son dos backends que un
        orquestador saca de rotación en momentos distintos."""
        from time import perf_counter

        started = perf_counter()
        up, error = await request.app.state.eq.db.healthy()
        database = (
            {"status": "up", "latencyMs": int((perf_counter() - started) * 1000)}
            if up
            else {"status": "down", "error": error or "sin detalle"}
        )
        return {"status": "ok" if up else "down", "checks": {"database": database}}

    @app.get("/backend", tags=["backend"])
    async def backend() -> dict:
        """Quién contesta. Pública y sin base de datos: el front la pide mientras decide a qué
        backend conectarse, y una ruta que pidiera credencial para decir su nombre haría imposible
        elegir."""
        return DESCRIPTOR

    app.include_router(auth_routes.router)
    app.include_router(iam_routes.router)
    app.include_router(project_routes.router)
    return app
