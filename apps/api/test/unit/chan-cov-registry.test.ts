/**
 * El registro de sesiones con un canal escrito a mano (`plan.open`): cada «no» antes de mandar, los
 * eventos de Socket.IO, lo binario, las suscripciones a mitad de sesión, las órdenes que viajan a
 * otra instancia por el bus y lo que pasa cuando guardar o latir falla.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_LIMITS } from "@/modules/channels/domain/model";
import type { MqttSessionPlan } from "@/modules/channels/domain/mqtt";
import { startSession, type ChannelSession } from "@/modules/channels/domain/session";
import {
  ChannelProgressStream,
  type ChannelProgressEvent,
} from "@/modules/channels/infrastructure/channel-progress.stream";
import {
  BEAT_MS,
  ChannelSessionRegistry,
  decodeBinary,
  type SessionPlan,
} from "@/modules/channels/infrastructure/session-registry";
import type { ChannelListeners, OpenChannel } from "@/modules/channels/infrastructure/ws-transport";
import { InMemoryBusHub, InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import { FixedClock } from "@/shared/clock/clock.port";
import type { Env } from "@/shared/config/env";
import { ConflictError, DomainError, InvalidInputError } from "@/shared/errors/domain-error";
import { MqttRejectedError } from "@/shared/http/safe-mqtt";
import { InMemoryChannelSessionRepository } from "../support/in-memory-channels";
import { StubChannelTransport } from "../support/stub-channel-transport";

type Calls = { sent: [string, unknown][]; binary: Buffer[]; emitted: [string, unknown[], boolean][]; closed: number[] };

function setup(options: { hub?: InMemoryBusHub; repository?: InMemoryChannelSessionRepository } = {}) {
  const repository = options.repository ?? new InMemoryChannelSessionRepository();
  const clock = new FixedClock(new Date("2026-03-01T10:00:00.000Z"));
  const stream = new ChannelProgressStream();
  const events: ChannelProgressEvent[] = [];
  stream["events"].subscribe((event: ChannelProgressEvent) => events.push(event));
  const env = { CHANNEL_MAX_OPEN: 10, REQUEST_TIMEOUT_MS: 5_000 } as Env;
  const bus = options.hub ? new InMemoryInstanceBus(options.hub) : null;
  const registry = new ChannelSessionRegistry(repository, new StubChannelTransport(), clock, env, stream, null, bus);
  registries.push(registry);
  return { repository, clock, events, registry, bus };
}

let registries: ChannelSessionRegistry[] = [];
afterEach(async () => {
  for (const registry of registries) await registry.onModuleDestroy();
  registries = [];
});

let counter = 0;
const newSession = (registry: ChannelSessionRegistry, clock: FixedClock, owner = registry.instance): ChannelSession =>
  startSession({
    id: `00000000-0000-4000-9000-${String((counter += 1)).padStart(12, "0")}`,
    channelId: "canal",
    projectId: "proyecto",
    environmentId: null,
    ownerInstance: owner,
    startedBy: "persona",
    now: clock.now(),
  });

/** Un canal a medida: abre en el acto y anota lo que se le pide. */
function fake(extra: Partial<OpenChannel> = {}) {
  const calls: Calls = { sent: [], binary: [], emitted: [], closed: [] };
  let listeners: ChannelListeners | null = null;
  const open = async (given: ChannelListeners): Promise<OpenChannel> => {
    listeners = given;
    given.onOpen?.({ status: 101, headers: {} });
    return {
      send: (text, publish) => calls.sent.push([text, publish]),
      close: (code) => calls.closed.push(code),
      ...extra,
    };
  };
  return { open, calls, listeners: () => listeners! };
}

const plan = (over: Partial<SessionPlan> = {}): SessionPlan => ({
  url: "wss://eco.example.test",
  headers: {},
  subprotocols: [],
  limits: DEFAULT_LIMITS,
  rules: { secrets: [] },
  expect: {},
  readOnly: false,
  environmentName: "",
  ...over,
});

const MQTT_PLAN: MqttSessionPlan = { version: 4, clientId: "c", keepaliveSec: 60, cleanSession: true, subscriptions: [] };

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function rejects(promise: Promise<unknown> | (() => unknown), check: (error: DomainError) => void) {
  try {
    if (typeof promise === "function") await promise();
    else await promise;
  } catch (error) {
    assert.ok(error instanceof DomainError, `no es de dominio: ${error}`);
    check(error);
    return;
  }
  assert.fail("no falló");
}

const env = (values: Record<string, string>) => (text: string) =>
  text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => values[name] ?? whole);

describe("decodeBinary", () => {
  test("hexadecimal y base64 estrictos, con el motivo de cada uno", () => {
    assert.deepEqual([...decodeBinary("0a 0B", "hex")], [10, 11]);
    assert.deepEqual([...decodeBinary("AQI=", "base64")], [1, 2]);
    assert.deepEqual([...decodeBinary("_-8", "base64")], [255, 239]);
    assert.throws(
      () => decodeBinary("abc", "hex"),
      (error: unknown) =>
        error instanceof InvalidInputError && /^Hexadecimal/.test(error.fields[0].detail) && error.fields[0].field === "text",
    );
    assert.throws(
      () => decodeBinary("abcde", "base64"),
      (error: unknown) => error instanceof InvalidInputError && /^Base64/.test(error.fields[0].detail),
    );
    assert.throws(() => decodeBinary("ab$c", "base64"), InvalidInputError);
  });
});

describe("mandar: lo que se rechaza antes de anotar", () => {
  test("un evento donde no toca, o sin evento en Socket.IO", async () => {
    const { registry, clock } = setup();
    const ws = await registry.start(newSession(registry, clock), plan({ open: fake().open }));
    await rejects(registry.send(ws.id, "x", undefined, undefined, { event: "e", ack: false }), (error) =>
      assert.deepEqual(error.fields, [{ field: "event", detail: "Solo un canal Socket.IO emite eventos" }]),
    );
    const io = await registry.start(newSession(registry, clock), plan({ open: fake({ emit: () => {} }).open }));
    await rejects(registry.send(io.id, "x"), (error) =>
      assert.deepEqual(error.fields, [{ field: "event", detail: "En Socket.IO se emite un evento: falta su nombre" }]),
    );
  });

  test("binario en un canal que no lo manda, y tema donde no toca", async () => {
    const { registry, clock } = setup();
    const ws = await registry.start(newSession(registry, clock), plan({ open: fake().open }));
    await rejects(registry.send(ws.id, "AQI=", undefined, "base64"), (error) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.code, "channel-no-binary");
    });
    await rejects(registry.send(ws.id, "x", { topic: "a", qos: 0, retain: false }), (error) =>
      assert.deepEqual(error.fields, [{ field: "topic", detail: "Un WebSocket no tiene temas" }]),
    );
    const mqtt = await registry.start(
      newSession(registry, clock),
      plan({ open: fake().open, mqtt: MQTT_PLAN }),
    );
    await rejects(registry.send(mqtt.id, "x"), (error) =>
      assert.deepEqual(error.fields, [{ field: "topic", detail: "En MQTT se publica en un tema" }]),
    );
    await rejects(
      registry.send(mqtt.id, "x", { topic: "a", qos: 0, retain: false, userProperties: [{ name: "a", value: "b" }] }),
      (error) => assert.equal(error.fields[0].field, "userProperties"),
    );
  });

  test("un entorno sin escrituras deja escuchar pero no mandar", async () => {
    const { registry, clock } = setup();
    const session = await registry.start(
      newSession(registry, clock),
      plan({ open: fake().open, readOnly: true, environmentName: "Producción" }),
    );
    await rejects(registry.send(session.id, "x"), (error) => {
      assert.equal(error.code, "writes-not-allowed");
      assert.match(error.message, /«Producción» no permite escrituras/);
    });
  });

  test("una variable sin valor se dice con su nombre, en el tema y en el cuerpo", async () => {
    const { registry, clock } = setup();
    const withEnv = await registry.start(
      newSession(registry, clock),
      plan({
        open: fake().open,
        interpolate: env({}),
        environmentName: "Staging",
        mqtt: { ...MQTT_PLAN, version: 5 },
      }),
    );
    await rejects(
      registry.send(withEnv.id, "{{cuerpo}}", {
        topic: "{{planta}}/x",
        qos: 0,
        retain: false,
        userProperties: [{ name: "p", value: "{{prop}}" }],
      }),
      (error) => {
        assert.equal(error.code, "unresolved-variables");
        assert.equal(error.message, "Variables sin valor: planta, cuerpo, prop");
        assert.deepEqual(error.fields, [
          { field: "topic", detail: "{{planta}} no tiene valor en «Staging»" },
          { field: "text", detail: "{{cuerpo}} no tiene valor en «Staging»" },
          { field: "text", detail: "{{prop}} no tiene valor en «Staging»" },
        ]);
      },
    );
    const noEnv = await registry.start(newSession(registry, clock), plan({ open: fake().open, interpolate: env({}) }));
    await rejects(registry.send(noEnv.id, "{{x}}"), (error) =>
      assert.equal(error.fields[0].detail, "{{x}} no tiene valor: la sesión se abrió sin entorno"),
    );
  });

  test("un tema que con la variable resuelta pasa a ser un comodín", async () => {
    const { registry, clock } = setup();
    const session = await registry.start(
      newSession(registry, clock),
      plan({
        open: fake().open,
        interpolate: env({ zona: "a/+" }),
        mqtt: MQTT_PLAN,
      }),
    );
    await rejects(registry.send(session.id, "x", { topic: "{{zona}}", qos: 0, retain: false }), (error) =>
      assert.deepEqual(error.fields, [
        { field: "topic", detail: "Un tema para publicar no lleva comodines (+ ni #), una vez resueltas las variables" },
      ]),
    );
  });

  test("lo que el protocolo no puede mandar no se anota", async () => {
    const { registry, clock } = setup();
    const channel = fake({
      check: (text) => {
        if (text !== "{}") throw new InvalidInputError("No encaja", [{ field: "text", detail: "mal" }]);
      },
    });
    const session = await registry.start(newSession(registry, clock), plan({ open: channel.open }));
    await rejects(registry.send(session.id, "roto"), (error) => assert.equal(error.message, "No encaja"));
    assert.deepEqual(channel.calls.sent, []);
    assert.equal(registry.current(session.id)?.conversation.messages.length, 0);
  });
});

describe("mandar: lo que sale", () => {
  test("una publicación MQTT 5 con el tema y las propiedades resueltos, y los bytes del cable", async () => {
    const { registry, clock, repository } = setup();
    const channel = fake({ wireBytes: (text) => text.length + 100 });
    const session = await registry.start(
      newSession(registry, clock),
      plan({
        open: channel.open,
        interpolate: env({ planta: "p1", v: "42" }),
        mqtt: { ...MQTT_PLAN, version: 5 },
      }),
    );
    await registry.send(session.id, "valor {{v}}", {
      topic: "{{planta}}/temp",
      qos: 1,
      retain: true,
      userProperties: [{ name: "origen", value: "{{planta}}" }],
    });
    assert.deepEqual(channel.calls.sent, [
      ["valor 42", { topic: "p1/temp", qos: 1, retain: true, userProperties: [{ name: "origen", value: "p1" }] }],
    ]);
    const [message] = await repository.listMessages(session.id);
    assert.equal(message.direction, "out");
    assert.equal(message.body, "valor 42");
    assert.equal(message.bytes, 108);
    assert.equal(message.topic, "p1/temp");
    assert.deepEqual(message.properties, { userProperties: [["origen", "p1"]] });
  });

  test("binario: se decodifica después de interpolar y se anota como hexadecimal", async () => {
    const { registry, clock, repository } = setup();
    const channel = fake({ sendBinary: (data) => channel.calls.binary.push(data) });
    const session = await registry.start(
      newSession(registry, clock),
      plan({ open: channel.open, interpolate: env({ cola: "ff" }) }),
    );
    await registry.send(session.id, "0a{{cola}}", undefined, "hex");
    assert.deepEqual(channel.calls.binary.map((data) => [...data]), [[10, 255]]);
    const [message] = await repository.listMessages(session.id);
    assert.deepEqual([message.kind, message.body, message.bytes], ["binary", "0aff", 2]);
  });

  test("un evento de Socket.IO: argumentos resueltos, acuse anotado, y sin argumentos si no hay texto", async () => {
    const { registry, clock, repository } = setup();
    const channel = fake({ emit: (event, args, ack) => channel.calls.emitted.push([event, args, ack]) });
    const session = await registry.start(
      newSession(registry, clock),
      plan({ open: channel.open, interpolate: env({ sala: "cocina" }) }),
    );
    await registry.send(session.id, "", undefined, undefined, { event: "unirse", ack: true, args: ['{"sala":"{{sala}}"}', "hola"] });
    await registry.send(session.id, "", undefined, undefined, { event: "ping", ack: false });
    await registry.send(session.id, "{{sala}}", undefined, undefined, { event: "solo", ack: false });
    assert.deepEqual(channel.calls.emitted, [
      ["unirse", [{ sala: "cocina" }, "hola"], true],
      ["ping", [], false],
      ["solo", ["cocina"], false],
    ]);
    const messages = await repository.listMessages(session.id);
    assert.deepEqual(
      messages.map((message) => [message.event, message.body, message.ack]),
      [
        ["unirse", '[{"sala":"cocina"},"hola"]', true],
        ["ping", "", undefined],
        ["solo", "cocina", undefined],
      ],
    );
    await rejects(
      registry.send(session.id, "", undefined, undefined, { event: "{{evento}}", ack: false, args: ["{{falta}}"] }),
      (error) => {
        assert.equal(error.code, "unresolved-variables");
        assert.deepEqual(
          error.fields.map((field) => field.field),
          ["args", "args"],
        );
      },
    );
  });

  test("las escuchas: enviado con bytes, evento, error, trama suelta y lo recibido crudo", async () => {
    const { registry, clock, repository } = setup();
    const channel = fake();
    const received: string[] = [];
    const session = await registry.start(
      newSession(registry, clock),
      plan({ open: channel.open, onReceived: (frame) => received.push(frame.body ?? "") }),
    );
    const listeners = channel.listeners();
    listeners.onSent?.("salió", 9);
    listeners.onSent?.("sin tamaño");
    listeners.onEvent?.("suscrito");
    listeners.onMessage(Buffer.from([1, 2, 3]), true);
    listeners.onMessage(Buffer.from("hola"), false, 50);
    listeners.onFrame?.({ direction: "in", body: "suelta" });
    await settle();
    await settle();
    const messages = await repository.listMessages(session.id);
    assert.deepEqual(
      messages.map((message) => [message.direction, message.kind, message.body, message.bytes]),
      [
        ["out", "text", "salió", 9],
        ["out", "text", "sin tamaño", 11],
        ["event", "text", "suscrito", 8],
        ["in", "binary", "010203", 3],
        ["in", "text", "hola", 50],
        ["in", "text", "suelta", 6],
      ],
    );
    assert.deepEqual(received, ["010203", "hola", "suelta"]);
    // Un error del transporte cierra la sesión con su mensaje dentro.
    listeners.onError?.(new Error("se cayó la red"));
    await settle();
    await settle();
    const row = await repository.findById("proyecto", session.id);
    assert.equal(row?.status, "closed");
    assert.equal(row?.stopReason, "transport-error");
  });
});

describe("suscripciones a mitad de sesión", () => {
  const mqttPlan = (open: SessionPlan["open"], over: Partial<SessionPlan> = {}) =>
    plan({ open, mqtt: MQTT_PLAN, ...over });

  test("solo una sesión MQTT, con un transporte que sepa suscribirse, tiene temas", async () => {
    const { registry, clock } = setup();
    const ws = await registry.start(newSession(registry, clock), plan({ open: fake().open }));
    await rejects(registry.subscribe(ws.id, "a", 0), (error) => assert.equal(error.code, "channel-no-topics"));
    const mute = await registry.start(newSession(registry, clock), mqttPlan(fake().open));
    await rejects(registry.subscribe(mute.id, "a", 0), (error) => assert.equal(error.code, "channel-no-topics"));
    await rejects(registry.unsubscribe(mute.id, "a"), (error) => assert.equal(error.code, "channel-no-topics"));
    await rejects(registry.subscribe("no-existe", "a", 0), (error) => assert.equal(error.code, "channel-session-not-here"));
  });

  test("el filtro se resuelve y se valida antes de pedirlo", async () => {
    const { registry, clock } = setup();
    const session = await registry.start(
      newSession(registry, clock),
      mqttPlan(fake({ subscribe: async () => 0, unsubscribe: async () => {} }).open, { interpolate: env({}) }),
    );
    await rejects(registry.subscribe(session.id, "{{zona}}/#", 0), (error) => {
      assert.equal(error.code, "unresolved-variables");
      assert.deepEqual(error.fields, [{ field: "topic", detail: "{{zona}} no tiene valor" }]);
    });
    await rejects(registry.unsubscribe(session.id, "a/#/b"), (error) => {
      assert.equal(error.message, "El filtro no es válido");
      assert.equal(error.fields[0].field, "topic");
    });
  });

  test("lo concedido, lo rechazado y lo que falló quedan como eventos", async () => {
    const { registry, clock, repository } = setup();
    const answers: (() => Promise<number>)[] = [
      async () => 0,
      async () => {
        throw new MqttRejectedError(135, "broker", "no autorizado");
      },
      async () => {
        throw "se cortó";
      },
    ];
    const leaves: (() => Promise<void>)[] = [
      async () => {},
      async () => {
        throw new Error("sin respuesta");
      },
    ];
    const session = await registry.start(
      newSession(registry, clock),
      mqttPlan(fake({ subscribe: () => answers.shift()!(), unsubscribe: () => leaves.shift()!() }).open),
    );
    assert.deepEqual(await registry.subscribe(session.id, "a/+", 1), {
      topic: "a/+",
      granted: 0,
      detail: "suscrito a a/+ (QoS 0, pedida 1)",
    });
    assert.deepEqual(await registry.subscribe(session.id, "b", 2), {
      topic: "b",
      granted: null,
      detail: "el broker rechazó la suscripción a b: no autorizado",
    });
    assert.equal((await registry.subscribe(session.id, "c", 0)).detail, "no se pudo completar la suscripción a c: se cortó");
    assert.deepEqual(await registry.unsubscribe(session.id, "a/+"), { topic: "a/+", granted: null, detail: "ya no se oye a/+" });
    assert.equal(
      (await registry.unsubscribe(session.id, "b")).detail,
      "no se pudo completar la baja de b: sin respuesta",
    );
    const events = (await repository.listMessages(session.id)).filter((message) => message.direction === "event");
    assert.equal(events.length, 5);
    assert.deepEqual([events[0].topic, events[0].qos], ["a/+", 1]);
  });
});

describe("terminar y cerrar", () => {
  test("el medio cierre solo en un canal que lo tiene", async () => {
    const { registry, clock } = setup();
    let ended = 0;
    const withEnd = await registry.start(newSession(registry, clock), plan({ open: fake({ end: () => (ended += 1) }).open }));
    registry.end(withEnd.id);
    assert.equal(ended, 1);
    const without = await registry.start(newSession(registry, clock), plan({ open: fake().open }));
    await rejects(() => registry.end(without.id), (error) => assert.equal(error.code, "channel-no-half-close"));
    await rejects(() => registry.end("no-existe"), (error) => assert.equal(error.code, "channel-session-not-here"));
  });

  test("dos cierres a la vez terminan una sola vez, y un socket que ya estaba cerrado no molesta", async () => {
    const { registry, clock, events } = setup();
    const session = await registry.start(
      newSession(registry, clock),
      plan({
        open: fake({
          close: () => {
            throw new Error("ya cerrado");
          },
        }).open,
      }),
    );
    const [first, second] = await Promise.all([registry.close(session.id), registry.close(session.id)]);
    assert.equal(first.status, "closed");
    assert.deepEqual(second, first);
    assert.equal(events.filter((event) => event.type === "finished").length, 1);
    await rejects(registry.close(session.id), (error) => assert.equal(error.code, "channel-session-not-here"));
  });
});

describe("abrir", () => {
  test("un error de dominio a mitad de la apertura es de configuración; cualquier otro, de la red", async () => {
    const { registry, clock } = setup();
    const config = await registry.start(
      newSession(registry, clock),
      plan({
        open: async () => {
          throw new ConflictError("El entorno no permite escrituras");
        },
      }),
    );
    assert.equal(config.status, "error");
    assert.equal(config.verdict?.failure, "config");
    assert.match(config.verdict?.assertions[0].detail ?? "", /^El entorno no permite escrituras/);
    const network = await registry.start(
      newSession(registry, clock),
      plan({
        open: async () => {
          throw "ECONNRESET";
        },
      }),
    );
    assert.equal(network.verdict?.failure, "network");
    assert.match(network.verdict?.assertions[0].detail ?? "", /no se pudo conectar: ECONNRESET/);
  });

  test("una sesión MQTT sin transporte MQTT en la instancia no abre, y lo dice", async () => {
    const { registry, clock } = setup();
    const session = await registry.start(
      newSession(registry, clock),
      plan({ mqtt: MQTT_PLAN }),
    );
    assert.equal(session.status, "error");
    assert.match(session.verdict?.assertions[0].detail ?? "", /Esta instancia no tiene transporte MQTT/);
  });

  test("un servidor que cierra antes de que la apertura vuelva: se devuelve la fila guardada", async () => {
    const { registry, clock } = setup();
    const session = await registry.start(newSession(registry, clock), {
      ...plan(),
      open: async (listeners) => {
        listeners.onOpen?.({ status: 101, headers: {} });
        listeners.onClose(4000, "adiós");
        // La apertura tarda en volver: el cierre ya terminó y ya no está en marcha.
        for (let index = 0; index < 5; index++) await settle();
        return { send: () => {}, close: () => {} };
      },
    });
    assert.equal(session.status, "closed");
    assert.equal(session.conversation.messages.length, 0);
    assert.equal(registry.owns(session.id), false);
  });
});

describe("guardar y latir cuando algo falla", () => {
  test("un mensaje que no se puede guardar se registra y la sesión sigue", async () => {
    const repository = new InMemoryChannelSessionRepository();
    repository.appendMessages = async () => {
      throw new Error("disco lleno");
    };
    const { registry, clock } = setup({ repository });
    const channel = fake();
    const session = await registry.start(newSession(registry, clock), plan({ open: channel.open }));
    await registry.send(session.id, "hola");
    assert.equal(registry.owns(session.id), true);
    assert.deepEqual(channel.calls.sent, [["hola", undefined]]);
  });

  test("un latido que falla no lanza; y el segador no toca una sesión que vive aquí", async () => {
    const repository = new InMemoryChannelSessionRepository();
    const { registry, clock } = setup({ repository });
    // Una sesión viva aquí pero apuntada a otra dueña: el latido no la refresca y el segador la ve.
    const session = await registry.start(newSession(registry, clock, "otra"), plan({ open: fake().open }));
    clock.advance(4 * BEAT_MS);
    await registry.beat();
    assert.equal((await repository.findById("proyecto", session.id))?.status, "open");
    assert.equal(registry.owns(session.id), true);

    repository.findStale = async () => {
      throw new Error("sin base de datos");
    };
    await registry.beat();
    assert.equal(registry.owns(session.id), true);
  });

  test("las ordenes: un reloj real se arma y se desarma", async () => {
    const { registry } = setup();
    registry.onModuleInit();
    await registry.onModuleDestroy();
    assert.equal(registry.size, 0);
  });
});

describe("órdenes a una sesión cuyo socket tiene otra instancia", () => {
  test("mandar, preguntar y cerrar viajan por el bus; los errores de dominio llegan intactos", async () => {
    const hub = new InMemoryBusHub();
    const repository = new InMemoryChannelSessionRepository();
    const owner = setup({ hub, repository });
    const other = setup({ hub, repository });
    const channel = fake();
    const session = await owner.registry.start(newSession(owner.registry, owner.clock), plan({ open: channel.open }));
    const row = (await repository.findById("proyecto", session.id))!;

    assert.equal(other.registry.usable(row), true);
    assert.equal(await other.registry.answers(row), true);
    assert.equal(await owner.registry.answers(row), true);
    assert.equal(await other.registry.route(row, { op: "ping", sessionId: row.id }), true);

    await other.registry.route(row, { op: "send", sessionId: row.id, text: "desde lejos" });
    assert.deepEqual(channel.calls.sent, [["desde lejos", undefined]]);

    await rejects(
      other.registry.route(row, { op: "send", sessionId: row.id, text: "x", publish: { topic: "t", qos: 0, retain: false } }),
      (error) => {
        // Del otro lado llega como error de dominio, con su clase de error y sus campos.
        assert.equal(error.kind, "invalid");
        assert.deepEqual(error.fields, [{ field: "topic", detail: "Un WebSocket no tiene temas" }]);
      },
    );
    await rejects(other.registry.route(row, { op: "subscribe", sessionId: row.id, topic: "a", qos: 0 }), (error) =>
      assert.equal(error.code, "channel-no-topics"),
    );
    await rejects(other.registry.route(row, { op: "unsubscribe", sessionId: row.id, topic: "a" }), (error) =>
      assert.equal(error.code, "channel-no-topics"),
    );
    await rejects(other.registry.route(row, { op: "end", sessionId: row.id }), (error) =>
      assert.equal(error.code, "channel-no-half-close"),
    );

    const closed = await other.registry.route(row, { op: "close", sessionId: row.id });
    assert.equal(closed.status, "closed");
    assert.ok(closed.closedAt instanceof Date);
    assert.equal(owner.registry.owns(row.id), false);
  });

  test("una dueña que no está en el bus es un 409; una que dejó de latir no se pregunta", async () => {
    const hub = new InMemoryBusHub();
    const { registry, clock } = setup({ hub });
    const ghost = { ...newSession(registry, clock, "fantasma"), status: "open" as const };
    assert.equal(registry.usable(ghost), true);
    assert.equal(await registry.answers(ghost), false);
    await rejects(registry.route(ghost, { op: "send", sessionId: ghost.id, text: "x" }), (error) => {
      assert.equal(error.code, "channel-session-not-here");
      assert.match(error.message, /\(fantasma\) no contestó/);
    });
    clock.advance(4 * BEAT_MS);
    assert.equal(registry.usable(ghost), false);
    assert.equal(await registry.answers(ghost), false);
    // Sin dueña viva se contesta aquí: no la tengo.
    assert.equal(await registry.route(ghost, { op: "ping", sessionId: ghost.id }), false);
  });
});
