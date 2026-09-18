/**
 * El contrato del bus entre instancias, el mismo para los dos adaptadores.
 *
 * El de memoria corre siempre. El de Redis, solo con `EQ_TEST_REDIS_URL`, y se salta diciéndolo en
 * vez de pasar callado —como `test/db` con Postgres—:
 *
 *     docker compose -f docker/compose.yml --profile redis up -d redis
 *     EQ_TEST_REDIS_URL=redis://localhost:6379 pnpm --filter @eq/api test:unit
 *
 * Las dos instancias de cada prueba comparten un hub (memoria) o un prefijo de canales (Redis), y
 * nada más: es lo que tienen dos procesos detrás de un balanceador.
 */
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";

import { InstanceUnreachableError, type InstanceBusPort } from "@/shared/bus/instance-bus";
import { InMemoryBusHub, InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import { RedisInstanceBus } from "@/shared/bus/redis-instance-bus";
import { ConflictError, DomainError, InvalidInputError } from "@/shared/errors/domain-error";

const REDIS_URL = process.env.EQ_TEST_REDIS_URL;
const REASON = "sin EQ_TEST_REDIS_URL: levanta Redis (perfil redis del compose) y reexporta la variable";

type Pair = { a: InstanceBusPort; b: InstanceBusPort; ready(): Promise<void> };

async function eventually(check: () => boolean, what: string, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) assert.fail(`no llegó a tiempo: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function contract(name: string, pair: () => Pair, options: { skip: string | false }) {
  describe(`bus entre instancias: ${name}`, { skip: options.skip }, () => {
    test("publicar llega a esta instancia en el acto y a la otra una sola vez", async () => {
      const { a, b, ready } = pair();
      await ready();
      const onA: unknown[] = [];
      const onB: unknown[] = [];
      a.subscribe("t", (message) => onA.push(message));
      b.subscribe("t", (message) => onB.push(message));

      a.publish("t", { n: 1 });
      assert.deepEqual(onA, [{ n: 1 }], "lo local no espera a la red");
      await eventually(() => onB.length === 1, "el evento en la otra instancia");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(onA, [{ n: 1 }], "lo propio no vuelve de rebote");
      assert.deepEqual(onB, [{ n: 1 }]);
    });

    test("conserva el orden, separa los temas y deja de entregar al desuscribirse", async () => {
      const { a, b, ready } = pair();
      await ready();
      const seen: number[] = [];
      const other: unknown[] = [];
      const stop = b.subscribe<{ n: number }>("orden", (message) => seen.push(message.n));
      b.subscribe("otro", (message) => other.push(message));
      for (let n = 0; n < 20; n++) a.publish("orden", { n });
      await eventually(() => seen.length === 20, "los veinte eventos");
      assert.deepEqual(
        seen,
        Array.from({ length: 20 }, (_, n) => n),
      );
      assert.deepEqual(other, []);

      stop();
      a.publish("orden", { n: 99 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(seen.length, 20);
    });

    test("lo que cruza, cruza en JSON: una fecha llega como texto", async () => {
      const { a, b, ready } = pair();
      await ready();
      const got: { at: unknown }[] = [];
      b.subscribe<{ at: unknown }>("fechas", (message) => got.push(message));
      a.publish("fechas", { at: new Date("2026-01-01T00:00:00.000Z") });
      await eventually(() => got.length === 1, "la fecha");
      assert.equal(got[0].at, "2026-01-01T00:00:00.000Z");
    });

    test("un oyente que falla no deja sin evento a los demás", async () => {
      const { a, ready } = pair();
      await ready();
      const seen: unknown[] = [];
      a.subscribe("frágil", () => {
        throw new Error("roto");
      });
      a.subscribe("frágil", (message) => seen.push(message));
      a.publish("frágil", 1);
      assert.deepEqual(seen, [1]);
    });

    test("pedir a otra instancia devuelve su respuesta", async () => {
      const { a, b, ready } = pair();
      await ready();
      b.handle<{ x: number }, { doble: number; quien: string }>("doblar", ({ x }) => ({
        doble: x * 2,
        quien: b.instanceId,
      }));
      const answer = await a.request<{ doble: number; quien: string }>(b.instanceId, "doblar", { x: 21 });
      assert.deepEqual(answer, { doble: 42, quien: b.instanceId });
    });

    test("un error de dominio vuelve con su tipo, su código y sus campos", async () => {
      const { a, b, ready } = pair();
      await ready();
      b.handle("mal", () => {
        throw new InvalidInputError("El mensaje no es válido", [{ field: "text", detail: "vacío" }], "bad-text");
      });
      b.handle("choca", async () => {
        throw new ConflictError("Ya terminó", "channel-session-finished");
      });
      b.handle("roto", () => {
        throw new Error("algo interno");
      });

      await assert.rejects(a.request(b.instanceId, "mal", {}), (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.kind, "invalid");
        assert.equal(error.code, "bad-text");
        assert.deepEqual(error.fields, [{ field: "text", detail: "vacío" }]);
        return true;
      });
      await assert.rejects(a.request(b.instanceId, "choca", {}), (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.kind, "conflict");
        assert.equal(error.code, "channel-session-finished");
        return true;
      });
      await assert.rejects(a.request(b.instanceId, "roto", {}), (error: unknown) => {
        assert.ok(!(error instanceof DomainError), "un fallo interno no se disfraza de error de dominio");
        assert.match((error as Error).message, /algo interno/);
        return true;
      });
    });

    test("pedirse a sí misma funciona igual", async () => {
      const { a, ready } = pair();
      await ready();
      a.handle<{ x: number }, number>("eco", ({ x }) => x);
      assert.equal(await a.request<number>(a.instanceId, "eco", { x: 7 }), 7);
    });

    test("pedir a una instancia que no está es un InstanceUnreachableError, y sin esperar el plazo", async () => {
      const { a, ready } = pair();
      await ready();
      const started = Date.now();
      await assert.rejects(a.request("nadie:0:00000000", "eco", {}, 5_000), InstanceUnreachableError);
      assert.ok(Date.now() - started < 2_000, "nadie escuchando se sabe ya, no al vencer el plazo");
    });
  });
}

contract(
  "en memoria",
  () => {
    const hub = new InMemoryBusHub();
    return { a: new InMemoryInstanceBus(hub), b: new InMemoryInstanceBus(hub), ready: async () => undefined };
  },
  { skip: false },
);

const opened: RedisInstanceBus[] = [];
after(async () => {
  await Promise.all(opened.map((bus) => bus.close()));
});

contract(
  "Redis",
  () => {
    // Un prefijo por prueba: dos pruebas —o dos ficheros— no se oyen entre sí.
    const prefix = `eq:test:${randomUUID()}`;
    const a = new RedisInstanceBus(REDIS_URL!, `a-${randomUUID()}`, prefix);
    const b = new RedisInstanceBus(REDIS_URL!, `b-${randomUUID()}`, prefix);
    opened.push(a, b);
    // Hasta que las dos están suscritas: lo publicado antes, en pub/sub, no lo oye nadie.
    const ready = async () => {
      const probe = `listo-${randomUUID()}`;
      let heard = false;
      b.subscribe(probe, () => (heard = true));
      await eventually(() => {
        a.publish(probe, 1);
        return heard;
      }, "la suscripción de Redis");
    };
    return { a, b, ready };
  },
  { skip: REDIS_URL ? false : REASON },
);
