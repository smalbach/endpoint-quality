/**
 * El turno cuando la base no contesta o la fila se pierde.
 *
 * `execution-turns.test.ts` mira el orden con una fila que siempre responde. Aquí la fila falla a
 * propósito —al apuntarse, al pedir turno, al salir, al latir— y lo que se comprueba es lo que el
 * portero promete: no empieza nada mientras no puede preguntar, lo dice una vez y no en cada intento,
 * dice cuándo vuelve, y avisa de la corrida que perdió su turno sin haberlo dejado.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Logger, type LoggerService } from "@nestjs/common";

import { InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import { InMemoryExecutionTurnStore, type TurnKind } from "@/shared/turns/execution-turns";
import { ExecutionTurnGate } from "@/shared/turns/execution-turn-gate";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Sin latidos a mitad de prueba: un latido que contesta diría «volvió» antes de tiempo. */
const TIMING = { pollMs: 5, heartbeatMs: 60_000, staleMs: 30_000 };
const BEATING = { ...TIMING, heartbeatMs: 10 };

/** La fila en memoria, con cada operación capaz de fallar las veces que se le pida. */
class FlakyStore extends InMemoryExecutionTurnStore {
  failures = { join: 0, tryStart: 0, leave: 0, heartbeat: 0 };
  /** Lo que se lanza: un Error, o cualquier otra cosa, como haría un driver mal educado. */
  thrown: unknown = new Error("la base no contesta");
  heartbeats = 0;
  /** Las filas que el latido dice haber renovado, si se quiere mentir sobre ellas. */
  beatenOverride: string[] | null = null;

  private maybeFail(operation: keyof FlakyStore["failures"]) {
    if (this.failures[operation] > 0) {
      this.failures[operation] -= 1;
      throw this.thrown;
    }
  }
  override async join(kind: TurnKind, runId: string, holder: string) {
    this.maybeFail("join");
    return super.join(kind, runId, holder);
  }
  override async tryStart(kind: TurnKind, runId: string, holder: string, staleMs: number) {
    this.maybeFail("tryStart");
    return super.tryStart(kind, runId, holder, staleMs);
  }
  override async leave(runId: string, holder: string) {
    this.maybeFail("leave");
    return super.leave(runId, holder);
  }
  override async heartbeat(holder: string) {
    this.heartbeats += 1;
    this.maybeFail("heartbeat");
    const beaten = await super.heartbeat(holder);
    return this.beatenOverride ?? beaten;
  }
}

let warnings: string[];
let logs: string[];

beforeEach(() => {
  warnings = [];
  logs = [];
  const sink: LoggerService = {
    log: (message: unknown) => void logs.push(String(message)),
    error: () => undefined,
    warn: (message: unknown) => void warnings.push(String(message)),
  };
  Logger.overrideLogger(sink);
});
afterEach(() => Logger.overrideLogger(false));

const DOWN = "No se pudo consultar el turno: la base no contesta. No se empieza nada hasta que conteste";
const BACK = "El turno vuelve a responder";

describe("el portero del turno con la base caída", () => {
  test("apuntarse falla sin romper: take se vuelve a apuntar y empieza, y dice que volvió", async () => {
    const store = new FlakyStore();
    const gate = new ExecutionTurnGate(store, new InMemoryInstanceBus(), "security", TIMING);
    store.failures.join = 1;
    await gate.join("r1");
    assert.equal(store.rows.size, 0, "la fila no debería existir: la base no contestó");
    assert.deepEqual(warnings, [DOWN]);

    assert.equal(await gate.take("r1"), true);
    assert.equal(store.rows.get("r1")?.startedAt !== null, true);
    assert.deepEqual(logs, [BACK]);
    await gate.leave("r1");
    gate.close();
  });

  test("mientras pedir turno falla no empieza, avisa una sola vez, y empieza cuando contesta", async () => {
    const store = new FlakyStore();
    const gate = new ExecutionTurnGate(store, new InMemoryInstanceBus(), "performance", TIMING);
    store.failures.tryStart = 3;
    store.thrown = "ECONNREFUSED";
    assert.equal(await gate.take("r1"), true);
    assert.equal(store.failures.tryStart, 0, "empezó sin volver a preguntar");
    assert.deepEqual(warnings, [
      "No se pudo consultar el turno: ECONNREFUSED. No se empieza nada hasta que conteste",
    ]);
    assert.deepEqual(logs, [BACK]);
    await gate.leave("r1");
    gate.close();
  });

  test("una espera normal tras un fallo también dice que la base volvió", async () => {
    const store = new FlakyStore();
    const bus = new InMemoryInstanceBus();
    const gate = new ExecutionTurnGate(store, bus, "security", TIMING);
    await store.join("security", "delante", "otra-instancia");
    await store.tryStart("security", "delante", "otra-instancia", TIMING.staleMs);
    store.failures.tryStart = 1;

    const taken = gate.take("r1");
    await pause(20);
    assert.deepEqual(warnings, [DOWN]);
    assert.deepEqual(logs, [BACK], "la segunda consulta contestó (sin turno) y no lo dijo");
    await store.leave("delante", "otra-instancia");
    assert.equal(await taken, true);
    await gate.leave("r1");
    gate.close();
  });

  test("salir con la base caída no borra la fila, pero avisa a quien espera", async () => {
    const store = new FlakyStore();
    const bus = new InMemoryInstanceBus();
    const freed: unknown[] = [];
    bus.subscribe("execution-turn.freed", (message) => void freed.push(message));
    const gate = new ExecutionTurnGate(store, bus, "security", TIMING);
    assert.equal(await gate.take("r1"), true);
    store.failures.leave = 1;
    await gate.leave("r1");
    assert.ok(store.rows.has("r1"), "la fila se borró aunque la base no contestaba");
    assert.deepEqual(warnings, [DOWN]);
    assert.deepEqual(freed, [{ kind: "security" }]);
    gate.close();
  });
});

describe("el latido", () => {
  // Aquí sí late, y deprisa: es lo que se mira.
  test("un latido que falla se registra, y el siguiente que contesta lo dice", async () => {
    const store = new FlakyStore();
    const gate = new ExecutionTurnGate(store, new InMemoryInstanceBus(), "security", BEATING);
    assert.equal(await gate.take("r1"), true);
    logs.length = 0;
    store.failures.heartbeat = 1;
    const before = store.heartbeats;
    while (store.heartbeats < before + 2) await pause(5);
    assert.deepEqual(warnings, [DOWN]);
    assert.deepEqual(logs, [BACK]);
    await gate.leave("r1");
    gate.close();
  });

  test("una corrida que sigue aquí pero ya no tiene fila se avisa una vez, no en cada latido", async () => {
    const store = new FlakyStore();
    const gate = new ExecutionTurnGate(store, new InMemoryInstanceBus(), "performance", BEATING);
    assert.equal(await gate.take("perdida"), true);
    // Otra instancia la dio por muerta: el latido ya no la renueva.
    store.beatenOverride = [];
    const before = store.heartbeats;
    while (store.heartbeats < before + 3) await pause(5);
    assert.deepEqual(warnings, [
      "La corrida perdida sigue aquí pero perdió su turno (sin latido a tiempo): otra puede haber empezado",
    ]);
    await gate.leave("perdida");
    gate.close();
  });
});
