/**
 * Los rechazos y valores raros del tarro que las pruebas principales no pisan.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { cookieHeaderFor, defaultPath, matchingCookies, parseSetCookie, type Cookie } from "../src/cookies.ts";

const NOW = Date.parse("2026-01-15T12:00:00Z");
const URL_API = "https://api.ejemplo.com/v1/pedidos";

describe("lo que parseSetCookie rechaza", () => {
  test("una URL de petición que no se puede leer no guarda nada", () => {
    assert.deepEqual(parseSetCookie("sesion=abc", "no es una url", NOW), {
      rejected: "la URL de la petición no se puede leer",
    });
  });

  test("un nombre en blanco o de más de 256 caracteres no vale", () => {
    assert.deepEqual(parseSetCookie("  =abc", URL_API, NOW), { rejected: "el nombre no vale" });
    assert.deepEqual(parseSetCookie(`${"n".repeat(257)}=abc`, URL_API, NOW), { rejected: "el nombre no vale" });
    assert.ok("cookie" in parseSetCookie(`${"n".repeat(256)}=abc`, URL_API, NOW));
  });
});

describe("SameSite", () => {
  const sameSite = (attribute: string) => {
    const read = parseSetCookie(`s=1; SameSite=${attribute}`, URL_API, NOW);
    assert.ok("cookie" in read);
    return read.cookie.sameSite;
  };

  test("Strict, Lax y None se guardan en minúsculas, sin importar cómo vinieran", () => {
    assert.equal(sameSite("Strict"), "strict");
    assert.equal(sameSite("LAX"), "lax");
    assert.equal(sameSite("none"), "none");
  });

  test("un valor que no es de los tres se ignora en vez de guardarse tal cual", () => {
    assert.equal(sameSite("Estricto"), null);
    assert.equal(sameSite(""), null);
  });
});

describe("lo que matchingCookies no devuelve", () => {
  const cookie: Cookie = {
    name: "s",
    value: "1",
    domain: "api.ejemplo.com",
    path: "/",
    expiresAt: null,
    secure: false,
    httpOnly: false,
    sameSite: null,
    hostOnly: true,
    createdAt: NOW,
  };

  test("a una URL que no se puede leer no le toca ninguna cookie", () => {
    assert.deepEqual(matchingCookies("/v1/pedidos", [cookie], NOW), []);
    assert.equal(cookieHeaderFor("::", [cookie], NOW), "");
  });
});

describe("la ruta por defecto", () => {
  test("una ruta que no empieza por / da la raíz", () => {
    assert.equal(defaultPath("v1/pedidos"), "/");
    assert.equal(defaultPath(""), "/");
  });
});
