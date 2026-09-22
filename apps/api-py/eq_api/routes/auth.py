"""
La superficie HTTP de una sesión, con las mismas reglas que `auth.controller.ts`.

El token de refresco viaja como cookie `eq_refresh` **httpOnly, SameSite=Strict** y además en el
cuerpo. No es indecisión: un navegador no debe poder leerlo desde JavaScript, y una CLI o un
trabajo de CI no tiene tarro de cookies. El de acceso va en el cuerpo y nunca como cookie, que es
lo que hace estructuralmente imposible un CSRF contra las rutas autenticadas.

Todo lo que se emite aquí lo acepta el backend de Node y al revés: mismo secreto, misma tabla,
mismo formato de hash. Esa es la prueba de que la paridad no es una declaración.
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from ..crypto import (
    generate_opaque_token,
    hash_opaque_token,
    hash_password,
    sign_access_token,
    verify_password,
)
from ..db import iso
from ..domain import (
    LOCKOUT,
    MAX_FAILED_LOGINS,
    PASSWORD_RESET_TTL,
    normalize_email,
    password_problems,
    refresh_verdict,
    utc_now,
)
from ..identity import Principal, authenticate, require_user
from ..problems import ConflictError, InvalidInputError, UnauthenticatedError
from ..repositories import new_id
from ..rate_limit import throttle
from ..validation import Rules

REFRESH_COOKIE = "eq_refresh"

router = APIRouter(prefix="/auth", tags=["auth"])


class StrictModel(BaseModel):
    """Un cuerpo con campos que el DTO no declara se rechaza en vez de recortarse, como el
    `forbidNonWhitelisted` del `ValidationPipe`: tirar en silencio un `role: "owner"` que alguien
    intentó mandar esconde el intento."""

    model_config = ConfigDict(extra="forbid")


class RegisterBody(StrictModel):
    email: str
    # El tope no es una regla de fortaleza: es una guarda de denegación de servicio. El KDF es duro
    # en memoria a propósito, y una contraseña sin límite es trabajo sin límite por intento.
    password: str
    name: str
    organizationName: str | None = None


class LoginBody(StrictModel):
    email: str
    password: str


class RefreshBody(StrictModel):
    refreshToken: str | None = Field(default=None, max_length=200)


class LogoutBody(StrictModel):
    refreshToken: str | None = Field(default=None, max_length=200)
    everywhere: bool | None = None


class ChangePasswordBody(StrictModel):
    currentPassword: str
    newPassword: str


class ForgotPasswordBody(StrictModel):
    email: str


class ResetPasswordBody(StrictModel):
    token: str
    newPassword: str


def assert_strong_password(password: str, field: str) -> None:
    problems = password_problems(password)
    if problems:
        raise InvalidInputError(
            "La contraseña no cumple los requisitos",
            [{"field": field, "detail": detail} for detail in problems],
            "weak-password",
        )


def assert_email(email: str) -> None:
    if "@" not in email:
        raise InvalidInputError(
            "El correo no es válido", [{"field": "email", "detail": "Debe ser una dirección de correo"}]
        )


async def issue_session(request: Request, user_id: str, email: str, session_id: str) -> dict:
    """Emite un par acceso/refresco y anota el lado del refresco.

    Compartida por el login y por la rotación para que las dos no puedan divergir: un refresco que
    guardara su token con otra caducidad o bajo otra sesión es un fallo que solo aparece el segundo
    día de una sesión."""
    state = request.app.state.eq
    now = utc_now()
    refresh_token = generate_opaque_token()
    refresh_expires_at = now + timedelta(days=state.settings.refresh_token_ttl_days)

    await state.repositories.refresh_tokens.insert(
        {
            "id": new_id(),
            "userId": user_id,
            "sessionId": session_id,
            "tokenHash": hash_opaque_token(refresh_token),
            "expiresAt": refresh_expires_at,
            "createdAt": now,
        }
    )
    return {
        "userId": user_id,
        "accessToken": sign_access_token(
            state.settings.jwt_access_secret, user_id, email, state.settings.access_token_ttl_seconds
        ),
        "refreshToken": refresh_token,
        "expiresIn": state.settings.access_token_ttl_seconds,
        "refreshExpiresAt": refresh_expires_at,
    }


def _cookie_kwargs(request: Request) -> dict:
    settings = request.app.state.eq.settings
    return {
        "httponly": True,
        # Strict y no Lax: esta cookie solo la manda nuestro propio front, nunca una navegación.
        "samesite": "strict",
        "secure": settings.production,
        # `/` y no `/auth`: la API se sirve normalmente bajo un prefijo (`/api-py` por el proxy),
        # así que el navegador ve `/api-py/auth/refresh`, que `path=/auth` no casa. Con la ruta
        # estrecha la cookie no se mandaba nunca y la sesión moría en cada recarga.
        "path": "/",
        **({"domain": settings.cookie_domain} if settings.cookie_domain else {}),
    }


def respond_with_session(request: Request, response: Response, session: dict) -> dict:
    response.set_cookie(
        REFRESH_COOKIE,
        session["refreshToken"],
        expires=session["refreshExpiresAt"],
        **_cookie_kwargs(request),
    )
    # El refresco va *también* en el cuerpo, para quien no tiene tarro de cookies. El cliente del
    # navegador lo ignora y deja que trabaje la cookie.
    return {
        "userId": session["userId"],
        "accessToken": session["accessToken"],
        "expiresIn": session["expiresIn"],
        "refreshToken": session["refreshToken"],
    }


def clear_session_cookie(request: Request, response: Response) -> None:
    # Se borra con los mismos atributos con los que se puso, o el navegador se queda con la vieja y
    # el siguiente refresco presenta un token que el servidor ya revocó.
    response.delete_cookie(REFRESH_COOKIE, **{key: value for key, value in _cookie_kwargs(request).items()})


@router.post("/register", status_code=201)
async def register(request: Request, body: RegisterBody) -> dict:
    # Con el mismo límite que el login: escribe una fila y corre el KDF, así que es a la vez un
    # vector de spam y una forma de hacer trabajar al servidor gratis.
    throttle(request, "register", limit=5, window_seconds=60)
    state = request.app.state.eq
    # Las reglas del DTO primero, como el pipe: una contraseña de cinco letras no llega a la
    # política de dominio, y por eso su mensaje es «al menos 12 caracteres» y no la lista entera.
    (
        Rules()
        .email("email", body.email)
        .max_length("email", body.email, 320)
        .min_length("password", body.password, 12)
        .max_length("password", body.password, 200)
        .max_length("name", body.name, 200)
        .max_length("organizationName", body.organizationName, 200)
        .check()
    )
    email = normalize_email(body.email)
    assert_email(email)
    assert_strong_password(body.password, "password")

    if await state.repositories.users.find_by_email(email):
        # Esto sí filtra que la dirección está registrada, y es el intercambio correcto aquí: la
        # alternativa es no crear la cuenta y decir que sí se creó. Donde la enumeración importa
        # —el login— no se filtra nada.
        raise ConflictError("Ese correo ya tiene una cuenta", "email-taken")

    now = utc_now()
    user_id = new_id()
    name = body.name.strip() or email.split("@")[0]
    await state.repositories.users.insert(
        {
            "id": user_id,
            "email": email,
            "name": name,
            "passwordDigest": hash_password(body.password),
            "status": "active",
            "createdAt": now,
            "failedLoginAttempts": 0,
            "lockedUntil": None,
        }
    )
    from .iam import create_organization  # import local: el registro funda la organización

    organization_id = await create_organization(request, (body.organizationName or "").strip() or name, user_id)
    return {"userId": user_id, "organizationId": organization_id}


@router.post("/login", status_code=200)
async def login(request: Request, response: Response, body: LoginBody) -> dict:
    """Cada fallo contesta lo mismo y tarda lo mismo.

    Un correo desconocido verifica la contraseña contra un digest señuelo antes de fallar, así que
    el tiempo de respuesta no dice si la cuenta existe; una cuenta deshabilitada o bloqueada falla
    con el mismo mensaje. Decir «esa cuenta está deshabilitada» es más amable y es también una
    lista gratis de direcciones válidas para quien traiga un diccionario."""
    throttle(request, "login", limit=10, window_seconds=60)
    Rules().email("email", body.email).max_length("email", body.email, 320).max_length(
        "password", body.password, 200
    ).check()
    state = request.app.state.eq
    now = utc_now()
    user = await state.repositories.users.find_by_email(normalize_email(body.email))
    digest = user["passwordDigest"] if user else state.decoy_digest
    matches = verify_password(body.password, digest)

    if not user:
        raise UnauthenticatedError()
    if user["lockedUntil"] is not None and user["lockedUntil"] > now:
        raise UnauthenticatedError()

    if not matches:
        attempts = int(user["failedLoginAttempts"]) + 1
        locks = attempts >= MAX_FAILED_LOGINS
        await state.repositories.users.set_login_failures(
            str(user["id"]), 0 if locks else attempts, now + LOCKOUT if locks else None
        )
        raise UnauthenticatedError()
    if user["status"] != "active":
        raise UnauthenticatedError()
    if int(user["failedLoginAttempts"]) > 0 or user["lockedUntil"] is not None:
        await state.repositories.users.set_login_failures(str(user["id"]), 0, None)

    session = await issue_session(request, str(user["id"]), user["email"], new_id())
    return respond_with_session(request, response, session)


@router.post("/refresh", status_code=200)
async def refresh(request: Request, response: Response, body: RefreshBody) -> dict:
    throttle(request, "refresh", limit=30, window_seconds=60)
    state = request.app.state.eq
    token = body.refreshToken or request.cookies.get(REFRESH_COOKIE)
    if not token:
        raise UnauthenticatedError("Falta el refresh token")

    now = utc_now()
    stored = await state.repositories.refresh_tokens.find_by_hash(hash_opaque_token(token))
    if not stored:
        raise UnauthenticatedError("La sesión no es válida")

    verdict = refresh_verdict(stored, now)
    if verdict != "usable":
        if verdict == "reused":
            # Un token ya gastado que vuelve a presentarse significa que dos partes tienen la
            # cadena: se revoca la sesión entera, no ese token.
            await state.repositories.refresh_tokens.revoke_session(str(stored["sessionId"]), now)
        raise UnauthenticatedError("La sesión no es válida")

    user = await state.repositories.users.find_by_id(str(stored["userId"]))
    # Una cuenta deshabilitada conserva un refresco válido hasta que caduca. Comprobarlo aquí es lo
    # que hace que deshabilitar surta efecto en la siguiente rotación y no hasta treinta días después.
    if not user or user["status"] != "active":
        await state.repositories.refresh_tokens.revoke_session(str(stored["sessionId"]), now)
        raise UnauthenticatedError("La sesión no es válida")

    issued = await issue_session(request, str(user["id"]), user["email"], str(stored["sessionId"]))
    await state.repositories.refresh_tokens.mark_used(
        str(stored["id"]), now, hash_opaque_token(issued["refreshToken"])
    )
    return respond_with_session(request, response, issued)


@router.post("/logout", status_code=204, response_class=Response)
async def logout(
    request: Request,
    response: Response,
    body: LogoutBody,
    principal: Principal = Depends(authenticate),
) -> None:
    state = request.app.state.eq
    if principal.kind != "user":
        raise UnauthenticatedError("Un token de servicio no tiene sesión que cerrar")
    user_id = require_user(principal)
    now = utc_now()

    if body.everywhere:
        await state.repositories.refresh_tokens.revoke_all_for_user(user_id, now)
    else:
        token = body.refreshToken or request.cookies.get(REFRESH_COOKIE)
        if token:
            stored = await state.repositories.refresh_tokens.find_by_hash(hash_opaque_token(token))
            if stored and str(stored["userId"]) == user_id:
                await state.repositories.refresh_tokens.revoke_session(str(stored["sessionId"]), now)

    clear_session_cookie(request, response)


@router.post("/forgot-password", status_code=204, response_class=Response)
async def forgot_password(request: Request, body: ForgotPasswordBody) -> None:
    """Manda el enlace y contesta 204 exista o no la cuenta.

    Con más freno que el login: cada llamada puede poner un correo en la bandeja de alguien, lo que
    la convierte tanto en una forma de acosar una dirección como de averiguar si existe."""
    throttle(request, "forgot-password", limit=5, window_seconds=15 * 60)
    Rules().email("email", body.email).max_length("email", body.email, 320).check()
    state = request.app.state.eq
    user = await state.repositories.users.find_by_email(normalize_email(body.email))
    if user and user["status"] == "active":
        now = utc_now()
        token = generate_opaque_token()
        await state.repositories.password_resets.insert(
            {
                "id": new_id(),
                "userId": str(user["id"]),
                "tokenHash": hash_opaque_token(token),
                "createdAt": now,
                "expiresAt": now + PASSWORD_RESET_TTL,
            }
        )
        # El correo lo manda el backend de Node, que es donde vive el `MailerPort`. Aquí el enlace
        # se registra igual que allí cuando no hay transporte configurado: nombrando el destino y
        # nunca el token, que es la credencial.
        state.log.info("Restablecimiento solicitado para el usuario %s", user["id"])


@router.post("/reset-password", status_code=204, response_class=Response)
async def reset_password(request: Request, response: Response, body: ResetPasswordBody) -> None:
    throttle(request, "reset-password", limit=10, window_seconds=60)
    Rules().max_length("token", body.token, 200).min_length("newPassword", body.newPassword, 12).max_length(
        "newPassword", body.newPassword, 200
    ).check()
    state = request.app.state.eq
    now = utc_now()
    stored = await state.repositories.password_resets.find_by_hash(hash_opaque_token(body.token))
    usable = stored is not None and stored["usedAt"] is None and stored["expiresAt"] > now
    user = await state.repositories.users.find_by_id(str(stored["userId"])) if usable and stored else None
    if not stored or not user:
        raise InvalidInputError(
            "El enlace no es válido o ha caducado",
            [{"field": "token", "detail": "Pide un enlace nuevo desde «¿Olvidaste tu contraseña?»"}],
            "reset-token-invalid",
        )
    # Después del token: así una contraseña débil no quema un enlace bueno, y un enlace malo no
    # llega a contar cuáles son las reglas de la contraseña.
    assert_strong_password(body.newPassword, "newPassword")

    await state.repositories.users.set_password(str(user["id"]), hash_password(body.newPassword))
    await state.repositories.password_resets.spend_all_for_user(str(user["id"]), now)
    await state.repositories.refresh_tokens.revoke_all_for_user(str(user["id"]), now)
    clear_session_cookie(request, response)


@router.post("/change-password", status_code=204, response_class=Response)
async def change_password(
    request: Request,
    response: Response,
    body: ChangePasswordBody,
    principal: Principal = Depends(authenticate),
) -> None:
    Rules().max_length("currentPassword", body.currentPassword, 200).min_length(
        "newPassword", body.newPassword, 12
    ).max_length("newPassword", body.newPassword, 200).check()
    state = request.app.state.eq
    if principal.kind != "user":
        raise UnauthenticatedError("Un token de servicio no tiene contraseña")
    user = await state.repositories.users.find_by_id(require_user(principal))
    if not user:
        raise UnauthenticatedError()
    if not verify_password(body.currentPassword, user["passwordDigest"]):
        raise UnauthenticatedError("La contraseña actual no es correcta")
    assert_strong_password(body.newPassword, "newPassword")

    await state.repositories.users.set_password(str(user["id"]), hash_password(body.newPassword))
    # Cambiar la contraseña cierra todas las sesiones, esta incluida: dejar la cookie sería dejar
    # al navegador con una credencial que el servidor acaba de revocar.
    await state.repositories.refresh_tokens.revoke_all_for_user(str(user["id"]), utc_now())
    clear_session_cookie(request, response)


async def _organizations_of(request: Request, user_id: str) -> list[dict]:
    state = request.app.state.eq
    memberships = await state.repositories.memberships.list_for_user(user_id)
    organizations = []
    for membership in memberships:
        organization = await state.repositories.organizations.find_by_id(str(membership["organizationId"]))
        if organization:
            organizations.append(
                {
                    "id": str(organization["id"]),
                    "name": organization["name"],
                    "slug": organization["slug"],
                    "role": membership["role"],
                }
            )
    return organizations


@router.get("/me")
async def me(request: Request, principal: Principal = Depends(authenticate)) -> dict:
    state = request.app.state.eq
    if principal.kind != "user":
        raise UnauthenticatedError("Un token de servicio no representa a una persona")
    user = await state.repositories.users.find_by_id(require_user(principal))
    if not user:
        from ..problems import NotFoundError

        raise NotFoundError("El usuario no existe", "user-not-found")
    return {
        "id": str(user["id"]),
        "email": user["email"],
        "name": user["name"],
        "organizations": await _organizations_of(request, str(user["id"])),
    }


@router.get("/context")
async def context(request: Request, principal: Principal = Depends(authenticate)) -> dict:
    """La misma pregunta que `/auth/me`, hecha de forma que un token de servicio pueda contestarla.

    Un token pertenece a exactamente una organización, así que aquí no hay nada que elegir ni que
    equivocarse al elegir; y un token que no puede averiguar su propia organización es una
    credencial que funciona y no se puede usar."""
    from ..problems import NotFoundError

    state = request.app.state.eq
    if principal.kind == "api-token":
        organization = await state.repositories.organizations.find_by_id(principal.organization_id or "")
        if not organization:
            raise NotFoundError("La organización del token no existe", "organization-not-found")
        return {
            "principal": "api-token",
            "user": None,
            # `editor` porque es lo que el guard concede a un token de servicio: dicho en vez de
            # supuesto, para que un cliente sepa antes de intentarlo que con esto no invita a nadie.
            "organizations": [
                {
                    "id": str(organization["id"]),
                    "name": organization["name"],
                    "slug": organization["slug"],
                    "role": "editor",
                }
            ],
        }

    user = await state.repositories.users.find_by_id(require_user(principal))
    if not user:
        raise NotFoundError("El usuario no existe", "user-not-found")
    return {
        "principal": "user",
        "user": {"id": str(user["id"]), "email": user["email"], "name": user["name"]},
        "organizations": await _organizations_of(request, str(user["id"])),
    }


__all__ = ["router", "REFRESH_COOKIE", "iso"]
