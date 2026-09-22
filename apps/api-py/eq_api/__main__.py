"""Arranque: `python -m eq_api`.

El puerto sale de `PORT_PY` y no de `PORT` a propósito: los tres backends se levantan con el mismo
`.env`, y compartir `PORT` haría que el segundo muriera por EADDRINUSE —en silencio, si nadie mira
los registros— en vez de convivir con el primero, que es justo lo que el selector del front
necesita.
"""

import uvicorn

from .app import create_app
from .config import load_settings


def main() -> None:
    settings = load_settings()
    uvicorn.run(create_app(settings), host="0.0.0.0", port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
