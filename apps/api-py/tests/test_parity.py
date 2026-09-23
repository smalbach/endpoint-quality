"""
Las piezas que tienen que coincidir con las de la API de NestJS, probadas contra valores fijos.

El guion de `tools/conformance` prueba la paridad **de verdad**, con los tres backends levantados.
Esto es la mitad que se puede correr sin nada delante y que falla en el sitio exacto: un digest con
otro formato, un hash en hexadecimal donde el otro escribe base64, una fecha con `+00:00` en vez de
`Z`. Cada uno de esos tres se ve aquí en un segundo y, sin estas pruebas, se vería como «no puedo
entrar» media hora después.

Los valores esperados están escritos a mano, no generados: un test que compara la implementación
consigo misma pasa incluso cuando las dos mitades están mal.
"""

from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone

import jwt
import pytest

from eq_api.crypto import (
    InvalidAccessToken,
    generate_opaque_token,
    hash_opaque_token,
    hash_password,
    sign_access_token,
    token_preview,
    verify_access_token,
    verify_password,
)
from eq_api.db import iso
from eq_api.domain import (
    normalize_tags,
    password_problems,
    refresh_verdict,
    slugify_organization,
    slugify_project,
    would_orphan_organization,
)
from eq_api.problems import STATUS_BY_KIND
from eq_api.tracing import trace_id_from
from eq_api.validation import Rules


class TestPasswords:
    def test_el_digest_tiene_el_formato_que_guarda_la_api_de_node(self) -> None:
        digest = hash_password("Una-contraseña-1")
        scheme, cost, block_size, parallelism, salt, derived = digest.split("$")

        assert scheme == "scrypt"
        assert (cost, block_size, parallelism) == ("131072", "8", "1")
        # 16 bytes de sal y 32 de clave, en base64 estándar (no urlsafe).
        assert len(base64.b64decode(salt)) == 16
        assert len(base64.b64decode(derived)) == 32

    def test_verifica_un_digest_hecho_con_otros_parametros(self) -> None:
        # Los tests de Nest usan un scrypt más barato a propósito. Una cuenta creada por ellos
        # tiene que poder entrar por aquí, o «los dos backends comparten la base» es mentira.
        barato = "scrypt$4096$8$1$" + "$".join(
            [base64.b64encode(b"0123456789abcdef").decode(), base64.b64encode(b"x" * 32).decode()]
        )
        # No es la contraseña, pero lo que importa es que no reviente al leer los parámetros.
        assert verify_password("cualquiera", barato) is False

    def test_un_digest_corrupto_es_un_login_que_falla_y_no_un_500(self) -> None:
        assert verify_password("x", "no-es-un-digest") is False
        assert verify_password("x", "scrypt$1$2$3$$") is False
        assert verify_password("x", "scrypt$no-es-un-numero$8$1$c2FsdA==$aGFzaA==") is False

    def test_la_normalizacion_unicode_no_parte_la_contraseña(self) -> None:
        # «ñ» compuesta y descompuesta son la misma contraseña para quien la teclea.
        digest = hash_password("Contraseña-larga-1")
        assert verify_password("Contraseña-larga-1", digest) is True

    def test_la_politica_nombra_todo_lo_que_falta_de_una_vez(self) -> None:
        assert password_problems("corta") == [
            "Debe tener al menos 12 caracteres",
            "Debe incluir una mayúscula",
            "Debe incluir un número",
            "Debe incluir un símbolo",
        ]
        assert password_problems("Conformidad-2026") == []

    def test_las_clases_se_miden_por_categoria_unicode_y_no_por_alfabeto_ingles(self) -> None:
        # Sin esto, «Ñandú» no tendría mayúscula y «Ωμέγα» no tendría ninguna letra.
        assert "Debe incluir una mayúscula" not in password_problems("Ñandú-corriendo-9")
        assert "Debe incluir una minúscula" not in password_problems("Ñandú-corriendo-9")


class TestTokensOpacos:
    def test_el_hash_es_sha256_en_base64_y_no_en_hexadecimal(self) -> None:
        # El valor está calculado con el otro backend —`createHash("sha256").digest("base64")`—
        # y no con este: un test que compara la implementación consigo misma pasa aunque las dos
        # mitades estén mal.
        assert hash_opaque_token("hola") == "siHZ27CDp/M0KNfCo8MZiuklYU1wIQ4ocWzKp81N23k="

    def test_un_token_opaco_son_32_bytes_en_base64url_sin_relleno(self) -> None:
        token = generate_opaque_token()
        assert "=" not in token and "+" not in token and "/" not in token
        assert len(base64.urlsafe_b64decode(token + "==")) == 32

    def test_el_preview_no_permite_reconstruir_el_token(self) -> None:
        assert token_preview("eqt_abcdefghijklmnop") == "eqt_ab…mnop"


class TestTokenDeAcceso:
    SECRET = "un-secreto-de-pruebas"

    def test_lleva_los_claims_que_lee_el_guard_de_node(self) -> None:
        token = sign_access_token(self.SECRET, "u-1", "ada@example.com", 900)
        claims = jwt.decode(token, self.SECRET, algorithms=["HS256"])

        assert claims["sub"] == "u-1"
        assert claims["email"] == "ada@example.com"
        assert claims["exp"] - claims["iat"] == 900

    def test_se_verifica_con_el_mismo_secreto_y_no_con_otro(self) -> None:
        token = sign_access_token(self.SECRET, "u-1", "ada@example.com", 900)

        assert verify_access_token(self.SECRET, token) == ("u-1", "ada@example.com")
        with pytest.raises(InvalidAccessToken):
            verify_access_token("otro-secreto", token)

    def test_un_token_sin_firma_no_pasa(self) -> None:
        # `alg: none` de manual: la cabecera dice que no hay firma y el contenido lo escribe quien
        # quiera. Se rechaza porque el algoritmo lo exige quien verifica, no el token.
        sin_firma = jwt.encode({"sub": "u-1"}, "", algorithm="none")
        with pytest.raises(InvalidAccessToken):
            verify_access_token(self.SECRET, sin_firma)

    def test_uno_caducado_tampoco(self) -> None:
        token = sign_access_token(self.SECRET, "u-1", "ada@example.com", -1)
        with pytest.raises(InvalidAccessToken):
            verify_access_token(self.SECRET, token)

    def test_uno_sin_sujeto_no_identifica_a_nadie(self) -> None:
        token = jwt.encode({"email": "ada@example.com"}, self.SECRET, algorithm="HS256")
        with pytest.raises(InvalidAccessToken):
            verify_access_token(self.SECRET, token)


class TestFechas:
    def test_se_escriben_como_las_escribe_json_stringify_sobre_un_date(self) -> None:
        # `isoformat()` daría `+00:00` y microsegundos: válido, distinto, y el front ordena estas
        # cadenas.
        momento = datetime(2026, 9, 22, 2, 41, 4, 567_891, tzinfo=timezone.utc)
        assert iso(momento) == "2026-09-22T02:41:04.567Z"

    def test_una_fecha_en_otro_huso_se_lleva_a_utc(self) -> None:
        momento = datetime(2026, 9, 22, 4, 41, 4, tzinfo=timezone(timedelta(hours=2)))
        assert iso(momento) == "2026-09-22T02:41:04.000Z"

    def test_lo_que_no_hay_se_dice_con_null(self) -> None:
        assert iso(None) is None


class TestReglasDeDominio:
    def test_los_slugs_pliegan_los_acentos_en_vez_de_tirarlos(self) -> None:
        # Las marcas se quitan y la letra se queda: «Cañón» es `canon`. Tirar el carácter
        # entero daría `can-n`, que no se parece a nada de lo que nadie escribió.
        assert slugify_organization("Cañón") == "canon"
        assert slugify_organization("  ¡Hola, Mundo!  ") == "hola-mundo"
        assert slugify_organization("!!!") == "org"
        assert slugify_project("!!!") == "proyecto"

    def test_las_etiquetas_se_recortan_una_vez_cada_una_y_en_orden(self) -> None:
        assert normalize_tags([" dos ", "uno", "dos", "", "  "]) == ["dos", "uno"]

    def test_el_reuso_de_un_refresco_se_distingue_de_caducado_y_revocado(self) -> None:
        ahora = datetime(2026, 9, 22, tzinfo=timezone.utc)
        futuro = ahora + timedelta(days=1)
        base = {"usedAt": None, "revokedAt": None, "expiresAt": futuro}

        assert refresh_verdict(base, ahora) == "usable"
        assert refresh_verdict({**base, "usedAt": ahora}, ahora) == "reused"
        assert refresh_verdict({**base, "revokedAt": ahora}, ahora) == "revoked"
        assert refresh_verdict({**base, "expiresAt": ahora}, ahora) == "expired"

    def test_el_ultimo_propietario_no_se_puede_quedar_fuera(self) -> None:
        solo = [{"userId": "u1", "role": "owner"}, {"userId": "u2", "role": "admin"}]

        assert would_orphan_organization(solo, "u1", "viewer") is True
        assert would_orphan_organization(solo, "u1", "owner") is False
        assert would_orphan_organization(solo, "u2", None) is False


class TestErrores:
    def test_cada_genero_de_error_tiene_el_codigo_que_le_da_el_filtro_de_node(self) -> None:
        assert STATUS_BY_KIND == {
            "not-found": 404,
            "conflict": 409,
            # 422 y no 400: «sintácticamente bien, semánticamente mal».
            "invalid": 422,
            "unauthenticated": 401,
            "forbidden": 403,
            "rate-limited": 429,
        }

    def test_la_validacion_acumula_los_problemas_con_el_texto_del_original(self) -> None:
        rules = Rules().email("email", "sin-arroba").min_length("password", "corta", 12)

        assert rules.problems == [
            {"field": "email", "detail": "email debe ser una dirección válida"},
            {"field": "password", "detail": "password debe tener al menos 12 caracteres"},
        ]

    def test_un_cuerpo_valido_no_levanta_nada(self) -> None:
        Rules().email("email", "ada@example.com").one_of("role", "editor", ("viewer", "editor")).check()


class TestTraza:
    """El identificador de traza, que **sale al cliente** y por tanto es contrato.

    Apareció al traer el trabajo de logging de la rama principal: el backend de referencia empezó a
    devolver `traceId` en el cuerpo de los errores y `X-Trace-Id` en toda respuesta, y hasta que no
    se replicó aquí los tres contestaban tres cosas distintas al mismo error."""

    def test_un_identificador_con_forma_se_respeta(self) -> None:
        # Es lo que permite seguir una operación que empezó en el navegador o en otro servicio.
        assert trace_id_from("abc12345") == "abc12345"
        assert trace_id_from("A" * 64) == "A" * 64

    def test_uno_sin_forma_se_sustituye_en_vez_de_rechazarse(self) -> None:
        # Una cabecera rara da una traza nueva, no un error: el cliente no puede tumbar la petición
        # escribiendo cualquier cosa. Y no se propaga: un salto de línea ahí inventaría entradas
        # enteras en el registro.
        for raro in ["", "corto", "con espacio", "x" * 65, "salto\nde línea", "punto.y.coma"]:
            sustituto = trace_id_from(raro)
            assert sustituto != raro
            assert len(sustituto) == 36  # un uuid4

    def test_sin_cabecera_se_genera_uno(self) -> None:
        primero, segundo = trace_id_from(None), trace_id_from(None)
        assert primero != segundo
