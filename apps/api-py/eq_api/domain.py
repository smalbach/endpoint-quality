"""
Las reglas que no son ni HTTP ni SQL, portadas una a una desde `apps/api/src/modules/*/domain/`.

Cada función de aquí tiene un original con nombre en el otro backend, y la comparación es lo que
hace que la paridad se pueda revisar leyendo en vez de probando: si `slugify` pliega los acentos
allí y los tira aquí, dos organizaciones con el mismo nombre acaban con URLs distintas según quién
las creó.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timedelta, timezone

# --- contraseñas ----------------------------------------------------------------------------

PASSWORD_MIN_LENGTH = 12

# Cinco intentos fallidos bloquean quince minutos: los números del analizador.
MAX_FAILED_LOGINS = 5
LOCKOUT = timedelta(minutes=15)

PASSWORD_RESET_TTL = timedelta(hours=1)
INVITATION_TTL = timedelta(days=7)


def password_problems(password: str) -> list[str]:
    """La longitud es lo que compra la entropía; la composición viene del analizador, y por eso el
    mínimo no bajó a cambio de tenerla.

    Las clases se miden por categoría Unicode y no con `[a-z]`, que es lo que significan `\\p{Ll}`,
    `\\p{Lu}`, `\\p{Nd}` y `[^\\p{L}\\p{Nd}]` en el original. Un `[a-z]` rechazaría «Contraseña»
    como si no tuviera minúsculas en el momento en que alguien use un alfabeto que no es el inglés,
    y la contraseña que aquí se rechaza es la que allí se aceptó."""
    problems: list[str] = []
    if len(password) < PASSWORD_MIN_LENGTH:
        problems.append(f"Debe tener al menos {PASSWORD_MIN_LENGTH} caracteres")
    categories = [unicodedata.category(character) for character in password]
    if "Ll" not in categories:
        problems.append("Debe incluir una minúscula")
    if "Lu" not in categories:
        problems.append("Debe incluir una mayúscula")
    if "Nd" not in categories:
        problems.append("Debe incluir un número")
    # Símbolo es «ni letra ni dígito», que es lo que dice `[^\p{L}\p{Nd}]`: el espacio cuenta.
    if not any(not (category.startswith("L") or category == "Nd") for category in categories):
        problems.append("Debe incluir un símbolo")
    return problems


def normalize_email(email: str) -> str:
    """Se comparan sin distinguir mayúsculas y se guardan recortados: dos cuentas que solo
    difieren en la capitalización son una sola cuenta para cualquiera que teclee una de ellas."""
    return email.strip().lower()


# --- slugs ----------------------------------------------------------------------------------


def _slugify(name: str, fallback: str) -> str:
    folded = "".join(
        character
        for character in unicodedata.normalize("NFD", name)
        if unicodedata.category(character) != "Mn"
    ).lower()
    slug = re.sub(r"[^a-z0-9]+", "-", folded).strip("-")[:60]
    return slug or fallback


def slugify_organization(name: str) -> str:
    return _slugify(name, "org")


def slugify_project(name: str) -> str:
    return _slugify(name, "proyecto")


# --- proyectos ------------------------------------------------------------------------------


def normalize_tags(tags: list[str]) -> list[str]:
    """Recortadas, una vez cada una, en el orden en que llegaron."""
    seen: dict[str, None] = {}
    for tag in tags:
        trimmed = tag.strip()
        if trimmed:
            seen.setdefault(trimmed, None)
    return list(seen)


def base_url_problems(base_url: str | None) -> list[dict[str, str]]:
    if base_url is None:
        return []
    trimmed = base_url.strip()
    if not trimmed:
        return []
    match = re.match(r"^([a-zA-Z][a-zA-Z0-9+.-]*):", trimmed)
    if not match:
        return [{"field": "baseUrl", "detail": "No es una URL válida"}]
    if match.group(1).lower() not in ("http", "https"):
        return [{"field": "baseUrl", "detail": "Solo http o https"}]
    return []


MASK = "••••••••"


def view_project_auth(auth_type: str, settings: dict) -> dict[str, str]:
    """La mitad no secreta de la autenticación de un proyecto, con una máscara donde hay un
    secreto guardado. El texto cifrado no sale de la base de datos por ninguna ruta."""
    secret_fields = settings.get("secretFields") or []
    has = lambda field: field in secret_fields  # noqa: E731
    return {
        "type": auth_type,
        "loginUrl": settings.get("loginUrl") or "",
        "loginMethod": settings.get("loginMethod") or "",
        "tokenPath": settings.get("tokenPath") or "",
        "username": settings.get("username") or "",
        "headerName": settings.get("headerName") or "",
        "token": MASK if has("token") else "",
        "loginBody": MASK if has("loginBody") else "",
        "password": MASK if has("password") else "",
        "apiKey": MASK if has("apiKey") else "",
    }


# --- sesiones -------------------------------------------------------------------------------


def refresh_verdict(token: dict, at: datetime) -> str:
    """`usable`, `reused`, `revoked` o `expired`.

    `reused` está separado de los otros dos a propósito: es una señal de robo y revoca la sesión
    entera, mientras que los otros son finales de vida normales que no deben revocar nada."""
    if token["usedAt"] is not None:
        return "reused"
    if token["revokedAt"] is not None:
        return "revoked"
    if token["expiresAt"] <= at:
        return "expired"
    return "usable"


def would_orphan_organization(memberships: list[dict], user_id: str, next_role: str | None) -> bool:
    """El último propietario no se puede degradar ni expulsar: una organización sin propietario no
    tiene a nadie que pueda añadir uno, y todo lo que hay dentro se queda sin dueño."""
    owners = [member for member in memberships if member["role"] == "owner"]
    only_owner = len(owners) == 1 and str(owners[0]["userId"]) == user_id
    return only_owner and next_role != "owner"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
