"""
Quién llama, y si puede.

Dos preguntas distintas y dos dependencias distintas, en el mismo orden que los dos guards de
Nest (`auth.guard.ts`), porque confundirlas es como se pierde el aislamiento entre inquilinos:

- la identidad sale de un JWT firmado o de un token de servicio `eqt_`, y no dice nada de permisos;
- la autorización se resuelve **contra la base en cada petición**, sobre la organización que la
  ruta nombra.

Los roles no viajan en el JWT, igual que allí. Meterlos ahorra una consulta y cuesta corrección:
una membresía revocada hace treinta segundos seguiría funcionando hasta que caduque el token, y
una revocación que tarda un cuarto de hora en aplicarse no es una revocación.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Request

from .crypto import InvalidAccessToken, hash_opaque_token, verify_access_token
from .db import now
from .problems import ForbiddenError, UnauthenticatedError
from .repositories import at_least


@dataclass(frozen=True)
class Principal:
    kind: str  # "user" | "api-token"
    user_id: str | None = None
    email: str | None = None
    organization_id: str | None = None
    token_id: str | None = None


def require_user(principal: Principal) -> str:
    """Las operaciones que solo hace una persona. Un token de CI que pudiera invitar a un
    propietario convertiría un secreto de build filtrado en una toma de la cuenta."""
    if principal.kind != "user" or not principal.user_id:
        raise UnauthenticatedError("Esta operación requiere una sesión de usuario", "user-session-required")
    return principal.user_id


async def authenticate(request: Request) -> Principal:
    """La dependencia que cuelga de cada ruta protegida.

    Es opt-**out**: aquí el router declara qué rutas son públicas (`/health`, `/backend`, el
    bloque de sesión) y todo lo demás la lleva. Una ruta nueva a la que se olvide ponérsela
    responde 401, que es un fallo que se ve, en vez de quedar abierta."""
    state = request.app.state.eq
    header = request.headers.get("authorization")
    if not header or not header.startswith("Bearer "):
        raise UnauthenticatedError("Falta la credencial")
    credential = header[len("Bearer ") :].strip()

    if credential.startswith("eqt_"):
        stored = await state.repositories.api_tokens.find_by_hash(hash_opaque_token(credential))
        if not stored or stored["revokedAt"] is not None:
            raise UnauthenticatedError("La credencial no es válida")
        # Anotado para que un operador vea qué tokens de CI siguen en uso antes de revocar uno.
        await state.repositories.api_tokens.touch(str(stored["id"]), now())
        return Principal(
            kind="api-token",
            organization_id=str(stored["organizationId"]),
            token_id=str(stored["id"]),
        )

    try:
        user_id, _email = verify_access_token(state.settings.jwt_access_secret, credential)
    except InvalidAccessToken as error:
        raise UnauthenticatedError("La credencial no es válida") from error

    user = await state.repositories.users.find_by_id(user_id)
    # Una firma que verifica no es lo mismo que una cuenta que sigue existiendo y activa.
    if not user or user["status"] != "active":
        raise UnauthenticatedError("La credencial no es válida")
    return Principal(kind="user", user_id=str(user["id"]), email=user["email"])


async def role_in_organization(request: Request, principal: Principal, organization_id: str, required: str) -> str:
    """El rol del que llama en **esa** organización, o un 403.

    La organización sale de la ruta, así que cualquiera puede *preguntar* por cualquiera y recibe
    un 403 salvo que sea miembro. Ese es todo el límite entre inquilinos, y es una consulta."""
    state = request.app.state.eq

    if principal.kind == "api-token":
        if principal.organization_id != organization_id:
            raise ForbiddenError("Este token no pertenece a la organización")
        # Un token de servicio llega hasta `editor` y no más: lanza corridas y lee, y no gestiona
        # miembros ni credenciales.
        if not at_least("editor", required):
            raise ForbiddenError("Un token de servicio no alcanza para esta operación", "api-token-role")
        return "editor"

    membership = await state.repositories.memberships.find(organization_id, require_user(principal))
    if not membership:
        raise ForbiddenError("No perteneces a esta organización")
    if not at_least(membership["role"], required):
        raise ForbiddenError(f"Esta operación requiere el rol {required}", "insufficient-role")
    return str(membership["role"])
