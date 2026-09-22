"""
Las tres primitivas que tienen que coincidir **byte a byte** con las de la API de NestJS.

Aquí no hay margen de estilo. Un digest de contraseña escrito con otro formato es una cuenta que
no puede entrar por este backend; un hash de token de refresco en hexadecimal en vez de base64 es
una sesión que se rompe al cambiar de backend; un JWT firmado con otro algoritmo es una credencial
que el otro backend rechaza. Los originales están en `apps/api/src/shared/crypto/`.

Las comparaciones son en tiempo constante por lo mismo que allí: un `==` sobre un digest filtra,
por el tiempo que tarda, cuántos bytes iniciales acertó quien prueba.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import unicodedata
from datetime import datetime, timedelta, timezone

import jwt

# El suelo de OWASP para scrypt, igual que en `password-hasher.ts`. `maxmem` hay que subirlo
# explícitamente: 128 · N · r son ~134 MB y el tope por defecto de Python está muy por debajo.
SCRYPT_COST = 2**17
SCRYPT_BLOCK_SIZE = 8
SCRYPT_PARALLELISM = 1
SCRYPT_KEY_LENGTH = 32
SCRYPT_MAX_MEMORY = 256 * 1024 * 1024


def hash_password(plain: str) -> str:
    """`scrypt$N$r$p$salt_b64$hash_b64`, el mismo formato que guarda la API de Nest.

    La sal viaja dentro del digest, que es lo que permite que `verify_password` no necesite nada
    más que la cadena guardada."""
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(
        unicodedata.normalize("NFKC", plain).encode("utf-8"),
        salt=salt,
        n=SCRYPT_COST,
        r=SCRYPT_BLOCK_SIZE,
        p=SCRYPT_PARALLELISM,
        dklen=SCRYPT_KEY_LENGTH,
        maxmem=SCRYPT_MAX_MEMORY,
    )
    return "$".join(
        [
            "scrypt",
            str(SCRYPT_COST),
            str(SCRYPT_BLOCK_SIZE),
            str(SCRYPT_PARALLELISM),
            base64.b64encode(salt).decode(),
            base64.b64encode(derived).decode(),
        ]
    )


def verify_password(plain: str, digest: str) -> bool:
    """Verifica contra el digest guardado, **con los parámetros que el digest declara**.

    Leerlos de la cadena y no de las constantes de arriba es lo que permite que una cuenta creada
    por los tests de Nest —que usan un scrypt más barato a propósito— siga pudiendo entrar aquí."""
    parts = digest.split("$")
    if len(parts) != 6 or parts[0] != "scrypt":
        return False
    _, cost, block_size, parallelism, salt_b64, expected_b64 = parts
    if not salt_b64 or not expected_b64:
        return False
    try:
        expected = base64.b64decode(expected_b64)
        derived = hashlib.scrypt(
            unicodedata.normalize("NFKC", plain).encode("utf-8"),
            salt=base64.b64decode(salt_b64),
            n=int(cost),
            r=int(block_size),
            p=int(parallelism),
            dklen=len(expected),
            maxmem=SCRYPT_MAX_MEMORY,
        )
    except (ValueError, TypeError):
        # Un digest corrupto es un login que falla, no un 500: la fila puede venir de cualquier
        # sitio y una excepción aquí convertiría un dato malo en una caída.
        return False
    return hmac.compare_digest(derived, expected)


def generate_opaque_token(size: int = 32) -> str:
    """32 bytes de aleatoriedad en base64url, como `generateOpaqueToken`."""
    return base64.urlsafe_b64encode(secrets.token_bytes(size)).decode().rstrip("=")


def hash_opaque_token(token: str) -> str:
    """SHA-256 en **base64**, no en hexadecimal: es la forma en que está guardada la columna
    `tokenHash`, y la que decide si un refresco emitido por otro backend se encuentra aquí."""
    return base64.b64encode(hashlib.sha256(token.encode("utf-8")).digest()).decode()


def token_preview(token: str) -> str:
    return f"{token[:6]}…{token[-4:]}"


def sign_access_token(secret: str, user_id: str, email: str, ttl_seconds: int) -> str:
    """JWT HS256 con los claims que el guard de Nest lee: `sub` y `email`.

    `iat` y `exp` los pone `@nestjs/jwt` por su cuenta allí; aquí se ponen a mano para que el token
    que emite este backend caduque igual y lo acepte el otro."""
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub": user_id,
            "email": email,
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(seconds=ttl_seconds)).timestamp()),
        },
        secret,
        algorithm="HS256",
    )


class InvalidAccessToken(Exception):
    """La firma no verifica, caducó, o los claims no son los que este producto emite."""


def verify_access_token(secret: str, token: str) -> tuple[str, str]:
    """Devuelve `(sub, email)` o levanta. Verifica la firma —nunca decodifica sin comprobarla—
    y exige HS256: aceptar el algoritmo que declare el propio token es la vulnerabilidad `alg:
    none` de manual."""
    try:
        claims = jwt.decode(token, secret, algorithms=["HS256"])
    except jwt.PyJWTError as error:
        raise InvalidAccessToken(str(error)) from error
    subject = claims.get("sub")
    if not isinstance(subject, str):
        raise InvalidAccessToken("el token no identifica a nadie")
    email = claims.get("email")
    return subject, email if isinstance(email, str) else ""
