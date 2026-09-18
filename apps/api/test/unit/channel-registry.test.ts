/**
 * El registro de sesiones vivas, con un servidor guionizado y un repositorio en memoria.
 *
 * Aquí se fija lo que el registro añade a lo puro: que cada mensaje se guarda en orden y **tapado**
 * —en la fila y en la trama en vivo, las dos—, que el reloj corta un socket callado sin que nadie
 * mire, que el tope por proceso existe, y que el segador cierra en rojo lo que dejó un proceso
 * muerto sin tocar lo que sigue vivo.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS } from "@/modules/channels/domain/model";
import { startSession, type ChannelSession } from "@/modules/channels/domain/session";
import {
  ChannelProgressStream,
  type ChannelProgressEvent,
} from "@/modules/channels/infrastructure/channel-progress.stream";
import { BEAT_MS, ChannelSessionRegistry, type SessionPlan } from "@/modules/channels/infrastructure/session-registry";
import { FixedClock } from "@/shared/clock/clock.port";
import type { Env } from "@/shared/config/env";
import { ConflictError } from "@/shared/errors/domain-error";
import { InMemoryChannelSessionRepository } from "../support/in-memory-channels";
import { StubChannelTransport } from "../support/stub-channel-transport";

const URL_ECO = "wss://eco.example.test/socket";
const SECRET = "sk-live-no-debe-salir-9f8e";

function setup(maxOpen = 5) {
  const repository = new InMemoryChannelSessionRepository();
  const transport = new StubChannelTransport();
  const clock = new FixedClock(new Date("2026-03-01T10:00:00.000Z"));
  const stream = new ChannelProgressStream();
  const events: ChannelProgressEvent[] = [];
  stream["events"].subscribe((event: ChannelProgressEvent) => events.push(event));
  const env = { CHANNEL_MAX_OPEN: maxOpen, REQUEST_TIMEOUT_MS: 5_000 } as Env;
  const registry = new ChannelSessionRegistry(repository, transport, clock, env, stream);
  return { repository, transport, clock, stream, events, registry };
}

let counter = 0;
const newSession = (registry: ChannelSessionRegistry, clock: FixedClock): ChannelSession =>
  startSession({
    id: `00000000-0000-4000-8000-${String((counter += 1)).padStart(12, "0")}`,
    channelId: "canal",
    projectId: "proyecto",
    environmentId: null,
    ownerInstance: registry.instance,
    startedBy: "persona",
    now: clock.now(),
  });

const plan = (over: Partial<SessionPlan> = {}): SessionPlan => ({
  url: URL_ECO,
  headers: {},
  subprotocols: [],
  limits: DEFAULT_LIMITS,
  rules: { secrets: [SECRET] },
  expect: {},
  readOnly: false,
  environmentName: "",
  ...over,
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

let registries: ChannelSessionRegistry[] = [];
afterEach(async () => {
  for (const registry of registries) await registry.onModuleDestroy();
  registries = [];
});
const tracked = (context: ReturnType<typeof setup>) => {
  registries.push(context.registry);
  return context;
};

describe("una sesión viva", () => {
  test("el saludo que llega con la apertura se guarda, en orden y después de abrir", async () => {
    const { registry, transport, repository, clock } = tracked(setup());
    transport.script(URL_ECO, { greeting: ['{"type":"welcome"}'] });
    const session = await registry.start(newSession(registry, clock), plan());
    await settle();
    assert.equal(session.status, "open");
    const saved = await repository.listMessages(session.id);
    assert.deepEqual(
      saved.map((message) => [message.seq, message.direction, message.body]),
      [[0, "in", '{"type":"welcome"}']],
    );
  });

  test("un secreto sale tapado en la fila **y** en la trama en vivo, en las dos direcciones", async () => {
    // Las dos a la vez, porque la redacción que se aplica solo al guardar falla en verde: la fila
    // limpia, la prueba de la fila pasa, y el secreto en el navegador.
    const { registry, transport, repository, events, clock } = tracked(setup());
    transport.script(URL_ECO, {
      greeting: [`{"session":"${SECRET}"}`],
      reply: (text) => [`eco: ${text}`],
    });
    const session = await registry.start(newSession(registry, clock), plan());
    await registry.send(session.id, `{"type":"auth","token":"${SECRET}"}`);
    await settle();
    await settle();

    const saved = JSON.stringify(await repository.listMessages(session.id));
    const live = JSON.stringify(events);
    assert.ok(!saved.includes(SECRET), `en la fila: ${saved}`);
    assert.ok(!live.includes(SECRET), `en vivo: ${live}`);
    assert.match(saved, /••••••••/);
    // Y el socket sí recibió el valor de verdad: tapar lo que se manda sería no mandar la credencial.
    assert.equal(transport.sent[0].text, `{"type":"auth","token":"${SECRET}"}`);
  });

  test("el tope de sesiones por proceso existe, y dice cuál es", async () => {
    const { registry, transport, clock } = tracked(setup(1));
    transport.script(URL_ECO, {});
    await registry.start(newSession(registry, clock), plan());
    await assert.rejects(registry.start(newSession(registry, clock), plan()), (error: Error) => {
      assert.ok(error instanceof ConflictError);
      assert.match(error.message, /tope/);
      return true;
    });
  });

  test("un servidor que acepta y calla se corta por el reloj, sin que nadie mire", async () => {
    const { registry, transport, repository, clock } = tracked(setup());
    transport.script(URL_ECO, {});
    const session = await registry.start(
      newSession(registry, clock),
      plan({ limits: { ...DEFAULT_LIMITS, idleMs: 20 }, expect: { minMessages: 1 } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    await registry.tick();
    const closed = await repository.findById("proyecto", session.id);
    assert.equal(closed?.status, "closed");
    assert.equal(closed?.stopReason, "idle-cap");
    // El veredicto se guarda al cerrar: pedía un mensaje y no llegó ninguno.
    assert.equal(closed?.verdict?.ok, false);
    assert.deepEqual(transport.closed, [{ url: URL_ECO, code: 1000, reason: "idle-cap" }]);
  });

  test("un upgrade rechazado deja la sesión en error, con el número dentro", async () => {
    const { registry, transport, clock } = tracked(setup());
    transport.script(URL_ECO, { rejectWith: 401 });
    const session = await registry.start(newSession(registry, clock), plan());
    assert.equal(session.status, "error");
    assert.equal(session.verdict?.failure, "network");
    assert.match(session.verdict?.assertions[0].detail ?? "", /401/);
    assert.equal(registry.size, 0);
  });

  test("el otro lado cierra: se anota su código y no se le devuelve el cierre", async () => {
    const { registry, transport, clock } = tracked(setup());
    transport.script(URL_ECO, { greeting: ["adiós"], closeAfterGreeting: 1000 });
    const session = await registry.start(newSession(registry, clock), plan({ expect: { closeCode: 1000 } }));
    await settle();
    assert.equal(session.status, "closed");
    assert.equal(session.stopReason, "closed-by-peer");
    assert.equal(session.verdict?.ok, true);
    assert.deepEqual(transport.closed, []);
  });

  test("mandar a una sesión que no está en este proceso es un 409 que lo dice", async () => {
    const { registry } = tracked(setup());
    await assert.rejects(registry.send("otra-sesion", "hola"), (error: Error) => {
      assert.ok(error instanceof ConflictError);
      assert.match(error.message, /no está abierta en esta instancia/);
      return true;
    });
  });
});

describe("el segador", () => {
  test("cierra en rojo lo que dejó un proceso muerto, y nada más", async () => {
    const { registry, transport, repository, clock } = tracked(setup());
    transport.script(URL_ECO, {});
    const mine = await registry.start(newSession(registry, clock), plan());

    const orphan = { ...newSession(registry, clock), ownerInstance: "otra:1:muerta", status: "open" as const };
    orphan.conversation = { ...orphan.conversation, openedAtMs: 0 };
    const alive = { ...newSession(registry, clock), ownerInstance: "otra:2:viva", status: "open" as const };
    await repository.save(orphan);
    await repository.save(alive);

    // La muerta dejó de latir hace más de tres latidos; la viva y la mía laten ahora.
    clock.advance(3 * BEAT_MS + 1_000);
    await repository.beat("otra:2:viva", clock.now());
    await registry.beat();

    const reaped = await repository.findById("proyecto", orphan.id);
    assert.equal(reaped?.status, "error");
    assert.equal(reaped?.stopReason, "transport-error");
    // En rojo con el motivo: sin decirlo, una conversación abierta y sin mensajes pasaría en verde.
    assert.equal(reaped?.verdict?.ok, false);
    assert.match(reaped?.verdict?.assertions[0].detail ?? "", /dejó de latir/);

    assert.equal((await repository.findById("proyecto", alive.id))?.status, "open");
    assert.equal((await repository.findById("proyecto", mine.id))?.status, "open");
  });
});
