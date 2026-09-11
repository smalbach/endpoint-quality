/**
 * The harness the rest of the HTTP suite stands on, checked instead of assumed.
 *
 * Everything else in `test/http` asks whether a route behaves; this file asks whether the
 * question reached the right process at all. It exists because for a long time it did not: the
 * app was only initialised, supertest therefore bound an ephemeral port per request on the IPv6
 * wildcard and then dialled the same number on `127.0.0.1`, and once in a while that number
 * belonged to somebody else — a sibling test file's stub target, or an unrelated server on the
 * machine. The request came back as a 401, a 404 or a 400 from a stranger, and the suite blamed
 * whatever assertion happened to be holding it.
 *
 * The invariant that closes that hole is small enough to assert directly, and worth asserting
 * because nothing else in the suite would notice it being undone: a passing suite is exactly
 * what the bug looked like four times out of five.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;

before(async () => {
  context = await createTestApp();
});
after(async () => {
  await context?.close();
});

/**
 * Se prueba una decisión del banco de pruebas, no del producto: que la aplicación escuche ya, en
 * la dirección exacta a la que supertest marca, y que siga siendo el mismo puerto de una petición
 * a la siguiente. Si alguien vuelve a `init()`, estas dos afirmaciones se ponen rojas enseguida y
 * en el sitio correcto, en vez de repartir cuatrocientos por ahí una vez de cada tres.
 */
describe("el banco de pruebas HTTP", () => {
  test("la aplicación escucha en 127.0.0.1, que es la dirección a la que apuntan las peticiones", () => {
    const address = context.app.getHttpServer().address() as AddressInfo | null;
    assert.ok(address, "la aplicación de pruebas no está escuchando: supertest abriría un puerto por petición");
    assert.equal(address.address, "127.0.0.1", "escuchar en el comodín deja que otro proceso tenga ese puerto en IPv4");
  });

  test("dos peticiones seguidas hablan con el mismo puerto", async () => {
    const api = () => request(context.app.getHttpServer());
    const portOf = () => (context.app.getHttpServer().address() as AddressInfo).port;

    const before = portOf();
    await api().get("/auth/me");
    const between = portOf();
    await api().get("/auth/me");

    // Un puerto que cambia entre peticiones es la señal de que supertest está abriendo y cerrando
    // el suyo, que es justo el ciclo que hacía que a veces contestara un servidor ajeno.
    assert.equal(between, before);
    assert.equal(portOf(), before);
  });
});
