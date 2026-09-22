"""
La validación del cuerpo, con los mensajes exactos del `ValidationPipe` de la API de NestJS.

Pydantic valida bien y lo dice a su manera («String should have at least 12 characters»), lo que
produce un 422 con el código correcto y **otro cuerpo**. El front pinta `errors[].detail` debajo
del campo que lo causó, así que ese texto es parte del contrato: dos backends que lo escriben
distinto son dos productos que hablan distinto según quién conteste, y el guion de conformidad lo
señala como divergencia.

Por eso los campos se declaran con el tipo laxo en el modelo y las reglas se comprueban aquí, en
el orden en que están declaradas en el DTO de Nest — que es el orden en que `class-validator`
devuelve sus mensajes.
"""

from __future__ import annotations

import re

from .problems import InvalidInputError

# La de `class-validator`, simplificada a lo que este producto necesita distinguir: una dirección
# con arroba, algo antes, algo después y un punto en el dominio.
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

ROLES = ("viewer", "editor", "admin", "owner")


class Rules:
    """Acumula los problemas en el orden en que se comprueban y los levanta todos juntos.

    Todos juntos y no el primero: un formulario que corrige un campo por petición es un formulario
    que se envía cinco veces."""

    def __init__(self) -> None:
        self.problems: list[dict[str, str]] = []

    def email(self, field: str, value: str) -> "Rules":
        if not _EMAIL.match(value or ""):
            self.problems.append({"field": field, "detail": f"{field} debe ser una dirección válida"})
        return self

    def min_length(self, field: str, value: str, length: int) -> "Rules":
        if len(value or "") < length:
            self.problems.append({"field": field, "detail": f"{field} debe tener al menos {length} caracteres"})
        return self

    def max_length(self, field: str, value: str | None, length: int) -> "Rules":
        if value is not None and len(value) > length:
            self.problems.append({"field": field, "detail": f"{field} no puede superar los {length} caracteres"})
        return self

    def one_of(self, field: str, value: str, options: tuple[str, ...]) -> "Rules":
        if value not in options:
            self.problems.append({"field": field, "detail": f"{field} debe ser uno de: {', '.join(options)}"})
        return self

    def check(self) -> None:
        if self.problems:
            # `type` termina en `422` y no en un código de dominio: es el fallo genérico de
            # validación, igual que el que produce el pipe allí.
            raise InvalidInputError("La solicitud no supera la validación", self.problems, "422")
