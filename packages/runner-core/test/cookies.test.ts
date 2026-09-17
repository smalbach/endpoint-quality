/**
 * El tarro de cookies, y sobre todo lo que **no** guarda ni devuelve.
 *
 * Casi todo lo que hay que acertar aquí es una regla de seguridad de la RFC 6265: a qué host se
 * devuelve una cookie, qué dominio puede ponerla, cuándo viaja sin cifrar. Un fallo en cualquiera
 * de ellas no rompe nada visible — la petición sigue saliendo — así que cada una es una prueba.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cookieHeaderFor,
  cookiesFrom,
  defaultPath,
  domainMatches,
  matchingCookies,
  parseSetCookie,
  pathMatches,
  withCookies,
  type Cookie,
} from "../src/cookies.ts";

const NOW = Date.parse("2026-01-15T12:00:00Z");

const parsed = (line: string, url = "https://api.ejemplo.com/v1/pedidos") => {
  const read = parseSetCookie(line, url, NOW);
  assert.ok("cookie" in read, `rechazada: ${"rejected" in read ? read.rejected : ""}`);
  return read.cookie;
};
const rejected = (line: string, url = "https://api.ejemplo.com/v1/pedidos") => {
  const read = parseSetCookie(line, url, NOW);
  assert.ok("rejected" in read, "se guardó y no debía");
  return read.rejected;
};

describe("leer un Set-Cookie", () => {
  it("nombre, valor y los valores por defecto", () => {
    const cookie = parsed("sesion=abc123");
    assert.equal(cookie.name, "sesion");
    assert.equal(cookie.value, "abc123");
    // Sin `Domain` la cookie es del host exacto, no de sus subdominios. Es lo contrario de lo que
    // parece y es la regla que impide que viaje a hosts que nunca la pusieron.
    assert.equal(cookie.domain, "api.ejemplo.com");
    assert.equal(cookie.hostOnly, true);
    // La ruta por defecto es el directorio de la petición, no `/`.
    assert.equal(cookie.path, "/v1");
    assert.equal(cookie.expiresAt, null);
    assert.equal(cookie.secure, false);
  });

  it("los atributos, en cualquier orden y con cualquier caja", () => {
    const cookie = parsed("a=1; Path=/admin; Domain=.Ejemplo.com; HttpOnly; secure; SameSite=Lax");
    assert.equal(cookie.path, "/admin");
    // El punto inicial se quita y el dominio se pasa a minúsculas: `.Ejemplo.com` y `ejemplo.com`
    // son el mismo dominio, y guardarlos distintos duplica la cookie.
    assert.equal(cookie.domain, "ejemplo.com");
    assert.equal(cookie.hostOnly, false);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.sameSite, "lax");
  });

  it("un valor entre comillas pierde las comillas, que no son parte del valor", () => {
    assert.equal(parsed('a="hola mundo"').value, "hola mundo");
  });

  it("Expires se lee, y Max-Age gana cuando están los dos", () => {
    const soloExpires = parsed("a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT");
    assert.equal(soloExpires.expiresAt, Date.parse("2027-06-09T10:18:14Z"));

    // `Max-Age` manda porque no depende del reloj del cliente, que es lo que dice la RFC.
    const ambos = parsed("a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Max-Age=60");
    assert.equal(ambos.expiresAt, NOW + 60_000);
  });

  it("Max-Age cero o negativo es «bórrala ya»", () => {
    assert.ok(parsed("a=1; Max-Age=0").expiresAt! <= NOW);
    assert.ok(parsed("a=1; Max-Age=-1").expiresAt! <= NOW);
  });

  it("una fecha que no se puede leer no caduca la cookie en 1970", () => {
    assert.equal(parsed("a=1; Expires=el martes que viene").expiresAt, null);
  });
});

describe("lo que no se guarda, y por qué", () => {
  it("un host no pone cookies para otro", () => {
    assert.match(rejected("a=1; Domain=otro.com"), /no es el dominio de api\.ejemplo\.com/);
  });

  it("ni para un dominio que termina igual pero no lo es", () => {
    // `ejemplo.co` termina dentro de `api.ejemplo.com`… si se compara sin el punto.
    assert.match(rejected("a=1; Domain=ejemplo.co"), /no es el dominio/);
  });

  it("ni para un sufijo que es de todos", () => {
    assert.match(rejected("a=1; Domain=com"), /dominio de todos/);
    assert.match(rejected("a=1; Domain=co.uk", "https://tienda.co.uk/x"), /dominio de todos/);
  });

  it("su propio dominio padre sí, que es para lo que existe el atributo", () => {
    assert.equal(parsed("a=1; Domain=ejemplo.com").domain, "ejemplo.com");
  });

  it("una línea sin nombre no es una cookie", () => {
    assert.match(rejected("=solovalor"), /no tiene nombre/);
    assert.match(rejected("sinigual"), /no tiene nombre/);
  });

  it("un valor enorme no entra", () => {
    assert.match(rejected(`a=${"x".repeat(5000)}`), /demasiado largo/);
  });

  it("varias cabeceras se leen como lista, no como una cadena con comas", () => {
    // Unidas en una sola cadena, el `Expires=Wed, 09 Jun…` se partiría por su propia coma y
    // guardaría media fecha como si fuera una cookie.
    const read = cookiesFrom(
      ["a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT", "b=2", "c=3; Domain=otro.com"],
      "https://api.ejemplo.com/x",
      NOW,
    );
    assert.deepEqual(
      read.cookies.map((cookie) => cookie.name),
      ["a", "b"],
    );
    assert.equal(read.rejected.length, 1);
    assert.match(read.rejected[0]!.why, /no es el dominio/);
  });
});

describe("a quién se le devuelven", () => {
  const jar = (...cookies: Partial<Cookie>[]): Cookie[] =>
    cookies.map((cookie, index) => ({
      name: `c${index}`,
      value: `v${index}`,
      domain: "api.ejemplo.com",
      path: "/",
      expiresAt: null,
      secure: false,
      httpOnly: false,
      sameSite: null,
      hostOnly: true,
      createdAt: NOW,
      ...cookie,
    }));

  it("una cookie de host exacto no viaja a un subdominio", () => {
    const store = jar({ name: "s", domain: "ejemplo.com", hostOnly: true });
    assert.equal(cookieHeaderFor("https://ejemplo.com/x", store, NOW), "s=v0");
    assert.equal(cookieHeaderFor("https://api.ejemplo.com/x", store, NOW), "");
  });

  it("una de dominio sí, y solo hacia abajo", () => {
    const store = jar({ name: "s", domain: "ejemplo.com", hostOnly: false });
    assert.equal(cookieHeaderFor("https://api.ejemplo.com/x", store, NOW), "s=v0");
    assert.equal(cookieHeaderFor("https://otro.com/x", store, NOW), "");
    assert.equal(cookieHeaderFor("https://malejemplo.com/x", store, NOW), "");
  });

  it("una cookie Secure no sale por http", () => {
    const store = jar({ name: "s", secure: true });
    assert.equal(cookieHeaderFor("https://api.ejemplo.com/x", store, NOW), "s=v0");
    assert.equal(cookieHeaderFor("http://api.ejemplo.com/x", store, NOW), "");
    // `localhost` cuenta como canal seguro: es donde se desarrolla, y el navegador hace lo mismo.
    assert.equal(
      cookieHeaderFor("http://localhost/x", jar({ name: "s", secure: true, domain: "localhost" }), NOW),
      "s=v0",
    );
  });

  it("la ruta acota, y el corte tiene que caer en una barra", () => {
    const store = jar({ name: "s", path: "/admin" });
    assert.equal(cookieHeaderFor("https://api.ejemplo.com/admin/usuarios", store, NOW), "s=v0");
    assert.equal(cookieHeaderFor("https://api.ejemplo.com/admin", store, NOW), "s=v0");
    assert.equal(cookieHeaderFor("https://api.ejemplo.com/administracion", store, NOW), "");
    assert.equal(cookieHeaderFor("https://api.ejemplo.com/", store, NOW), "");
  });

  it("una caducada no se devuelve aunque siga en el tarro", () => {
    const store = jar({ name: "vieja", expiresAt: NOW - 1 }, { name: "viva", expiresAt: NOW + 1000 });
    assert.equal(cookieHeaderFor("https://api.ejemplo.com/x", store, NOW), "viva=v1");
  });

  it("el orden es el del protocolo: ruta más larga primero, y la más antigua a igualdad", () => {
    const store = jar(
      { name: "raiz", path: "/" },
      { name: "honda", path: "/v1/pedidos" },
      { name: "media", path: "/v1" },
      { name: "raiz2", path: "/", createdAt: NOW - 5000 },
    );
    assert.equal(
      cookieHeaderFor("https://api.ejemplo.com/v1/pedidos/7", store, NOW),
      "honda=v1; media=v2; raiz2=v3; raiz=v0",
    );
  });

  it("matchingCookies devuelve las cookies, para poder enseñarlas", () => {
    const store = jar({ name: "s" }, { name: "otra", path: "/nada" });
    assert.deepEqual(
      matchingCookies("https://api.ejemplo.com/x", store, NOW).map((cookie) => cookie.name),
      ["s"],
    );
  });
});

describe("meter cookies en el tarro", () => {
  const one = (patch: Partial<Cookie> = {}): Cookie => ({
    name: "sesion",
    value: "v1",
    domain: "api.ejemplo.com",
    path: "/",
    expiresAt: null,
    secure: false,
    httpOnly: false,
    sameSite: null,
    hostOnly: true,
    createdAt: NOW,
    ...patch,
  });

  it("la misma cookie se reemplaza, no se duplica", () => {
    const jar = withCookies([one()], [one({ value: "v2", createdAt: NOW + 10 })], NOW);
    assert.equal(jar.length, 1);
    assert.equal(jar[0]!.value, "v2");
    // La fecha de creación es la de la primera vez, que es lo que mantiene su sitio en la cabecera.
    assert.equal(jar[0]!.createdAt, NOW);
  });

  it("mismo nombre en otra ruta u otro dominio son dos cookies", () => {
    const jar = withCookies([one()], [one({ path: "/admin" }), one({ domain: "otra.ejemplo.com" })], NOW);
    assert.equal(jar.length, 3);
  });

  it("una cookie ya caducada borra la que había: así cierra sesión un servidor", () => {
    const jar = withCookies([one()], [one({ expiresAt: NOW - 1 })], NOW);
    assert.deepEqual(jar, []);
  });

  it("y lo caducado se cae al escribir, sin esperar a que alguien lo pida", () => {
    const jar = withCookies([one({ name: "vieja", expiresAt: NOW - 1 })], [one({ name: "nueva" })], NOW);
    assert.deepEqual(
      jar.map((cookie) => cookie.name),
      ["nueva"],
    );
  });
});

describe("las reglas, sueltas", () => {
  it("domainMatches exige el punto", () => {
    assert.equal(domainMatches("api.ejemplo.com", "ejemplo.com"), true);
    assert.equal(domainMatches("ejemplo.com", "ejemplo.com"), true);
    assert.equal(domainMatches("malejemplo.com", "ejemplo.com"), false);
  });

  it("pathMatches exige la barra", () => {
    assert.equal(pathMatches("/a/b", "/a"), true);
    assert.equal(pathMatches("/ab", "/a"), false);
    assert.equal(pathMatches("/a", "/a"), true);
    assert.equal(pathMatches("/cualquiera", "/"), true);
  });

  it("defaultPath es el directorio, no la ruta", () => {
    assert.equal(defaultPath("/v1/pedidos"), "/v1");
    assert.equal(defaultPath("/pedidos"), "/");
    assert.equal(defaultPath("/"), "/");
    assert.equal(defaultPath("/a/b/c"), "/a/b");
  });
});
