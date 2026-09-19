/**
 * El límite de peticiones con dos instancias detrás de un balanceador.
 *
 * Las dos aplicaciones comparten los contadores (`sibling`: el mismo almacén, como el mismo Redis) y
 * montan el throttler igual que `AppModule`. Antes cada réplica contaba lo suyo, y el tope de diez
 * intentos de login por minuto eran diez **por réplica**: veinte con dos, alternando.
 *
 * En un fichero aparte porque aquí el throttler está encendido, y en el resto de la batería no:
 * cuántas peticiones hizo una prueba anterior no puede decidir si la siguiente pasa.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { InMemoryBusHub, InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import { createTestApp, type TestContext } from "../support/test-app";

let a: TestContext;
let b: TestContext;
const on = (context: TestContext) => request(context.app.getHttpServer());

before(async () => {
  const hub = new InMemoryBusHub();
  a = await createTestApp({ throttle: true, bus: new InMemoryInstanceBus(hub, "limite-a") });
  b = await createTestApp({ throttle: true, sibling: a, bus: new InMemoryInstanceBus(hub, "limite-b") });
});

after(async () => {
  await b?.close();
  await a?.close();
});

describe("el límite de peticiones, entre instancias", () => {
  test("diez logins por minuto son diez en total, no diez por instancia", async () => {
    const attempt = (context: TestContext) =>
      on(context).post("/auth/login").send({ email: "nadie@example.test", password: "Una-contraseña-mala-1" });
    // Alternando, como un balanceador que reparte: cinco a cada una.
    for (let index = 0; index < 10; index += 1) {
      const response = await attempt(index % 2 ? b : a);
      assert.equal(response.status, 401, `intento ${index + 1}: ${response.status} ${JSON.stringify(response.body)}`);
    }
    // El undécimo, por una instancia que solo ha visto cinco: con contadores por proceso pasaba.
    const limited = await attempt(b);
    assert.equal(limited.status, 429, JSON.stringify(limited.body));
    const retryAfter = Number(limited.headers["retry-after"]);
    assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After: ${limited.headers["retry-after"]}`);
    assert.match(String(limited.headers["content-type"]), /problem\+json/);
    // Y la otra también lo ve.
    assert.equal((await attempt(a)).status, 429);
  });

  test("cada ruta cuenta aparte: lo gastado en el login no cierra el registro", async () => {
    // Otra ruta con su propio tope: lo gastado en el login no cuenta aquí.
    const registered = await on(b).post("/auth/register").send({ email: "", password: "x", name: "" });
    assert.notEqual(registered.status, 429, JSON.stringify(registered.body));
  });
});
