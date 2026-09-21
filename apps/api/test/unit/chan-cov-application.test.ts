/**
 * Abrir un canal sin la API delante: `resolveChannelTarget`, el que abre (`ChannelSessionOpener`) y
 * la sesión sin pantalla de un flujo (`HeadlessChannelRunner`), con repositorios en memoria y
 * transportes escritos a mano. Lo que se fija: cada rechazo antes de abrir dice su motivo, la
 * autenticación se firma donde toca o se rechaza con el suyo, y un guion hace lo que dice —o dice
 * en qué acción se paró—.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MQTT } from "@/modules/channels/domain/mqtt";
import { DEFAULT_SOCKETIO } from "@/modules/channels/domain/socketio";
import { DEFAULT_GRPC_SETTINGS } from "@/modules/channels/domain/grpc";
import { blankChannel, type Channel, type ChannelProtocol } from "@/modules/channels/domain/model";
import {
  ChannelSessionOpener,
  redactMessage,
  resolveChannelTarget,
  withBase64,
} from "@/modules/channels/application/commands/manage-sessions";
import { HeadlessChannelRunner, defaultScript } from "@/modules/channels/application/headless-session";
import { ChannelProgressStream } from "@/modules/channels/infrastructure/channel-progress.stream";
import { ChannelSessionRegistry } from "@/modules/channels/infrastructure/session-registry";
import type { MqttOpenOptions, MqttTransportPort, TimelessFrame } from "@/modules/channels/infrastructure/mqtt-transport";
import type { SocketIoOpenOptions, SocketIoTransportPort } from "@/modules/channels/infrastructure/socketio-transport";
import type { ChannelListeners, OpenChannel } from "@/modules/channels/infrastructure/ws-transport";
import type { GrpcSessionPlanner } from "@/modules/channels/application/grpc";
import type { Environment } from "@/modules/environments/domain/model";
import { FixedClock } from "@/shared/clock/clock.port";
import { loadEnv } from "@/shared/config/env";
import { ConflictError, DomainError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { InMemoryChannelRepository, InMemoryChannelSessionRepository } from "../support/in-memory-channels";
import { InMemoryEnvironmentRepository } from "../support/in-memory-repositories";
import { StubChannelTransport } from "../support/stub-channel-transport";
import { TEST_ENV } from "../support/test-app";

const PROJECT = "proyecto";
const plain = { encrypt: (text: string) => text, decrypt: (text: string) => text };
const env = loadEnv({ ...TEST_ENV });

function environment(over: Partial<Environment> = {}): Environment {
  return {
    id: `env-${Math.random().toString(36).slice(2, 8)}`,
    projectId: PROJECT,
    name: "Staging",
    baseUrl: "https://api.example.test",
    specUrl: null,
    variables: {
      host: { initial: "wss://eco.example.test", current: "", sensitive: false },
      token: { initial: "tk-secreto-1", current: "", sensitive: true },
      vacio: { initial: "", current: "", sensitive: true },
    },
    disabledVariables: {},
    writesAllowed: true,
    authEnforced: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
    archivedAt: null,
    deletedAt: null,
  };
}

function channel(protocol: ChannelProtocol, over: Partial<Channel> = {}): Channel {
  return {
    ...blankChannel({
      id: `canal-${Math.random().toString(36).slice(2, 8)}`,
      projectId: PROJECT,
      name: "canal",
      url: "wss://eco.example.test/socket",
      now: new Date("2026-01-01T00:00:00Z"),
      by: "persona",
      protocol,
    }),
    ...over,
  };
}

async function rejection(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DomainError, String(error));
    return error;
  }
  assert.fail("no falló");
}

describe("resolveChannelTarget", () => {
  const environments = new InMemoryEnvironmentRepository();
  const deps = { environments, cipher: plain };

  test("un entorno que no existe, o que es de otro proyecto, es un 404", async () => {
    const other = environment({ projectId: "otro" });
    environments.rows.set(other.id, other);
    for (const id of ["no-existe", other.id]) {
      const error = await rejection(resolveChannelTarget(deps, PROJECT, channel("ws"), id));
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.code, "environment-not-found");
    }
  });

  test("con entorno: las cabeceras activas resueltas, los secretos del entorno y de la corrida", async () => {
    const staging = environment();
    environments.rows.set(staging.id, staging);
    const target = await resolveChannelTarget(
      deps,
      PROJECT,
      channel("ws", {
        url: "{{host}}/socket",
        headers: [
          { name: " x-sala ", value: "{{sala}}", enabled: true },
          { name: "x-apagada", value: "x", enabled: false },
          { name: " ", value: "sin nombre", enabled: true },
        ],
      }),
      staging.id,
      { variables: { sala: "cocina" }, secrets: ["de-la-corrida", ""] },
    );
    assert.equal(target.url, "wss://eco.example.test/socket");
    assert.deepEqual(target.headers, { "x-sala": "cocina" });
    assert.deepEqual(target.secrets, ["tk-secreto-1", "de-la-corrida"]);
    assert.equal(target.environment?.name, "Staging");
    assert.equal(target.interpolate("{{token}}"), "tk-secreto-1");
  });

  test("una variable sin valor se dice con el entorno, o pidiendo uno", async () => {
    const staging = environment();
    environments.rows.set(staging.id, staging);
    const withEnv = await rejection(
      resolveChannelTarget(deps, PROJECT, channel("ws", { url: "{{falta}}/x" }), staging.id),
    );
    assert.equal(withEnv.code, "unresolved-variables");
    assert.deepEqual(withEnv.fields, [{ field: "environmentId", detail: "{{falta}} no tiene valor en «Staging»" }]);
    const noEnv = await rejection(resolveChannelTarget(deps, PROJECT, channel("ws", { url: "{{falta}}/x" }), null));
    assert.deepEqual(noEnv.fields, [{ field: "environmentId", detail: "{{falta}} no tiene valor: elige un entorno" }]);
  });

  test("MQTT: un filtro que con la variable deja de serlo, y la contraseña en los secretos", async () => {
    const broken = await rejection(
      resolveChannelTarget(
        deps,
        PROJECT,
        channel("mqtt", {
          url: "mqtt://broker.example.test",
          mqtt: { ...DEFAULT_MQTT, subscriptions: [{ topic: "{{zona}}/+", qos: 0 }] },
        }),
        null,
        { variables: { zona: "a/#" }, secrets: [] },
      ),
    );
    assert.equal(broken.message, "Las suscripciones no son válidas con este entorno");
    assert.deepEqual(broken.fields.map((field) => field.field), ["mqtt.subscriptions.0.topic"]);

    const ok = await resolveChannelTarget(
      deps,
      PROJECT,
      channel("mqtt", {
        url: "mqtt://broker.example.test",
        auth: { type: "basic", params: { username: "yo", password: "{{pw}}" } },
        mqtt: { ...DEFAULT_MQTT, clientId: "fijo" },
      }),
      null,
      { variables: { pw: "clave-mqtt" }, secrets: [] },
    );
    // MQTT no firma una cabecera: la contraseña va en el CONNECT, y entra en los secretos.
    assert.deepEqual(ok.headers, {});
    assert.equal(ok.mqtt?.password, "clave-mqtt");
    assert.deepEqual(ok.secrets, ["clave-mqtt"]);
  });

  test("Socket.IO: una carga que resuelta no es JSON es un 422 con su campo", async () => {
    const error = await rejection(
      resolveChannelTarget(
        deps,
        PROJECT,
        channel("socketio", { url: "https://io.example.test", socketio: { ...DEFAULT_SOCKETIO, auth: '{"n": {{n}}}' } }),
        null,
        { variables: { n: "no-es-numero" }, secrets: [] },
      ),
    );
    assert.equal(error.message, "La carga de auth no es válida con este entorno");
    assert.deepEqual(error.fields.map((field) => field.field), ["socketio.auth"]);
  });

  test("la autenticación: en cabecera, en la query, y la que no se puede firmar al abrir", async () => {
    const bearer = await resolveChannelTarget(
      deps,
      PROJECT,
      channel("ws", { auth: { type: "bearer", params: { token: "{{t}}" } } }),
      null,
      { variables: { t: "tk-1" }, secrets: [] },
    );
    assert.equal(bearer.headers.Authorization, "Bearer tk-1");
    assert.ok(bearer.secrets.includes("tk-1"));
    assert.ok(bearer.secrets.includes("Bearer tk-1"));

    const query = await resolveChannelTarget(
      deps,
      PROJECT,
      channel("ws", { auth: { type: "apikey", params: { key: "access_token", value: "k-1", in: "query" } } }),
      null,
    );
    assert.equal(query.url, "wss://eco.example.test/socket?access_token=k-1");
    assert.ok(query.secrets.includes("k-1"));

    const grpcQuery = await rejection(
      resolveChannelTarget(
        deps,
        PROJECT,
        channel("grpc", {
          url: "grpc://svc.example.test:50051",
          auth: { type: "apikey", params: { key: "k", value: "v", in: "query" } },
        }),
        null,
      ),
    );
    assert.equal(grpcQuery.code, "channel-auth-unsupported");
    assert.equal(grpcQuery.message, "En gRPC la clave va en la metadata");

    const ntlm = await rejection(
      resolveChannelTarget(deps, PROJECT, channel("ws", { auth: { type: "ntlm", params: {} } }), null),
    );
    assert.equal(ntlm.code, "channel-auth-unsupported");
    assert.match(ntlm.fields[0].detail, /NTLM/);

    const digest = await rejection(
      resolveChannelTarget(
        deps,
        PROJECT,
        channel("ws", { auth: { type: "digest", params: { username: "u", password: "p" } } }),
        null,
      ),
    );
    assert.equal(digest.code, "channel-auth-unsupported");
    assert.match(digest.fields[0].detail, /reto al servidor/);

    // `inherit` no firma nada: el canal no hereda de ninguna carpeta.
    const inherit = await resolveChannelTarget(deps, PROJECT, channel("ws", { auth: { type: "inherit", params: {} } }), null);
    assert.deepEqual(inherit.headers, {});
  });
});

describe("tapar y codificar secretos", () => {
  test("un mensaje con sangría se tapa con sangría, y uno compacto sale compacto", () => {
    assert.equal(redactMessage('{"password":"x"}'), '{"password":"••••••••"}');
    assert.equal(redactMessage('{\n  "password": "x"\n}'), '{\n  "password": "••••••••"\n}');
    assert.equal(redactMessage("texto libre"), "texto libre");
  });

  test("cada secreto también en base64, sin repetir", () => {
    assert.deepEqual(withBase64(["ab?"]), ["ab?", "YWI/", "YWI_"]);
    assert.deepEqual(withBase64(["a"]), ["a", "YQ==", "YQ"]);
  });
});

// ---------------------------------------------------------------------------------------------

function mqttTransport(onPublish: (frame: TimelessFrame) => void = () => {}): MqttTransportPort & { plans: MqttOpenOptions[] } {
  const plans: MqttOpenOptions[] = [];
  return {
    plans,
    async open(_url, options, emit): Promise<OpenChannel> {
      plans.push(options);
      emit({ direction: "open" });
      return {
        send: (text, publish) => {
          const frame: TimelessFrame = { direction: "in", body: `eco ${text}`, topic: publish?.topic };
          onPublish(frame);
          emit(frame);
        },
        close: () => {},
      };
    },
  };
}

function socketIoTransport(): SocketIoTransportPort & { emitted: [string, unknown[], boolean][]; options: SocketIoOpenOptions[] } {
  const emitted: [string, unknown[], boolean][] = [];
  const options: SocketIoOpenOptions[] = [];
  return {
    emitted,
    options,
    async open(_url, given, emit): Promise<OpenChannel> {
      options.push(given);
      emit({ direction: "open" });
      return {
        send: () => {
          throw new Error("no");
        },
        emit: (event, args, ack) => {
          emitted.push([event, args, ack]);
          emit({ direction: "in", event, body: `recibido ${event}` });
        },
        close: () => {},
      };
    },
  };
}

let registries: ChannelSessionRegistry[] = [];
afterEach(async () => {
  for (const registry of registries) await registry.onModuleDestroy();
  registries = [];
});

function world(
  options: { mqtt?: MqttTransportPort; socketio?: SocketIoTransportPort | null; grpc?: GrpcSessionPlanner } = {},
) {
  const channels = new InMemoryChannelRepository();
  const sessions = new InMemoryChannelSessionRepository();
  const environments = new InMemoryEnvironmentRepository();
  const transport = new StubChannelTransport();
  const clock = new FixedClock(new Date("2026-03-01T10:00:00.000Z"));
  const registry = new ChannelSessionRegistry(sessions, transport, clock, env, new ChannelProgressStream(), options.mqtt ?? null);
  registries.push(registry);
  const grpc =
    options.grpc ??
    ({
      prepare: async () => {
        throw new InvalidInputError("gRPC no se prueba aquí");
      },
    } as unknown as GrpcSessionPlanner);
  const opener = new ChannelSessionOpener(environments, plain, clock, env, registry, grpc, options.socketio ?? null);
  const runner = new HeadlessChannelRunner(channels, sessions, opener, registry);
  const add = async (value: Channel) => {
    await channels.save(value);
    return value;
  };
  return { channels, sessions, environments, transport, registry, opener, runner, add };
}

const input = (channelId: string, node: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  projectId: PROJECT,
  channelId,
  environmentId: null,
  actorId: "persona",
  node: { channelId, ...node },
  variables: {},
  secrets: [],
  ...over,
});

describe("el que abre", () => {
  test("Socket.IO sin transporte en la instancia no abre, y lo dice como un fallo de red", async () => {
    const { opener, add } = world();
    const io = await add(channel("socketio", { url: "https://io.example.test" }));
    const session = await opener.open({ projectId: PROJECT, channel: io, environmentId: null, actorId: "persona" });
    assert.equal(session.status, "error");
    assert.equal(session.verdict?.failure, "network");
    assert.match(session.verdict?.assertions[0].detail ?? "", /Esta instancia no tiene transporte Socket\.IO/);
  });

  test("un entorno sin escrituras abre en solo lectura, y la inactividad de una corrida solo baja", async () => {
    const { opener, environments, transport, registry, add } = world();
    const staging = environment({ writesAllowed: false });
    environments.rows.set(staging.id, staging);
    transport.script("wss://eco.example.test/socket", {});
    const ws = await add(channel("ws"));
    const session = await opener.open({
      projectId: PROJECT,
      channel: ws,
      environmentId: staging.id,
      actorId: "persona",
      idleMs: 50,
    });
    assert.equal(session.status, "open");
    assert.equal(session.environmentId, staging.id);
    const error = await rejection(registry.send(session.id, "hola"));
    assert.equal(error.code, "writes-not-allowed");
  });
});

describe("una sesión sin pantalla", () => {
  test("un canal que ya no existe se rechaza sin abrir", async () => {
    const { runner } = world();
    assert.deepEqual(await runner.run(input("no-existe")), {
      kind: "refused",
      detail: "El canal ya no existe en este proyecto",
      channel: null,
    });
  });

  test("un guion que no encaja con el protocolo se rechaza con el número de la acción", async () => {
    const { runner, add } = world();
    const ws = await add(channel("ws"));
    const mqtt = await add(channel("mqtt", { url: "mqtt://b.example.test" }));
    const io = await add(channel("socketio", { url: "https://io.example.test" }));
    const cases: [Channel, unknown[], string][] = [
      [ws, [{ action: "send", body: "x".repeat(64 * 1024 + 1) }], "Acción 1: un mensaje tiene como mucho 64 KB"],
      [mqtt, [{ action: "wait", messages: 1, timeoutMs: 1 }, { action: "send", body: "x" }], "Acción 2: en MQTT se publica en un tema"],
      [ws, [{ action: "send", body: "x", topic: "t" }], "Acción 1: solo MQTT publica en un tema"],
      [io, [{ action: "send", body: "x" }], "Acción 1: en Socket.IO se emite un evento: falta su nombre"],
      [ws, [{ action: "send", body: "x", ack: true }], "Acción 1: solo Socket.IO emite eventos"],
      [mqtt, [{ action: "send", body: "x", topic: "t", event: "e" }], "Acción 1: solo Socket.IO emite eventos"],
    ];
    for (const [target, messages, detail] of cases) {
      const outcome = await runner.run(input(target.id, { messages }));
      assert.equal(outcome.kind, "refused");
      assert.equal(outcome.kind === "refused" && outcome.detail, detail);
      assert.equal(outcome.channel?.id, target.id);
    }
  });

  test("lo que se rechaza al abrir vuelve como rechazo con el detalle de sus campos", async () => {
    const { runner, add } = world();
    const ws = await add(channel("ws", { url: "{{base}}/socket", auth: { type: "ntlm", params: {} } }));
    const unresolved = await runner.run(input(ws.id));
    assert.equal(unresolved.kind, "refused");
    assert.equal(
      unresolved.kind === "refused" && unresolved.detail,
      "Variables sin valor: base: {{base}} no tiene valor: elige un entorno",
    );
    const unsupported = await runner.run(input(ws.id, {}, { variables: { base: "wss://eco.example.test" } }));
    assert.match(unsupported.kind === "refused" ? unsupported.detail : "", /^La autenticación de este canal no se puede firmar al abrir: NTLM/);
  });

  test("un fallo que no es de dominio no se disfraza de rechazo", async () => {
    const { runner, add, environments } = world();
    environments.findById = async () => {
      throw new Error("la base de datos no contesta");
    };
    const ws = await add(channel("ws"));
    await assert.rejects(runner.run(input(ws.id, {}, { environmentId: "e" })), /la base de datos no contesta/);
  });

  test("WebSocket: pausa, espera, un medio cierre que no existe y el guion que se para ahí", async () => {
    const { runner, transport, add } = world();
    transport.script("wss://eco.example.test/socket", { greeting: ["hola"], reply: (text) => [`eco ${text}`] });
    const ws = await add(channel("ws"));
    const outcome = await runner.run(
      input(ws.id, {
        untilMessages: 2,
        request: "{}",
        messages: [
          { action: "send", body: "uno", delayMs: 5 },
          { action: "wait", messages: 1, timeoutMs: 1_000 },
          { action: "end" },
          { action: "send", body: "nunca" },
        ],
      }),
    );
    assert.equal(outcome.kind, "session");
    if (outcome.kind !== "session") return;
    assert.deepEqual(outcome.problems, [
      "Acción 3 (end): Este canal no tiene un envío que terminar: se cierra entero",
    ]);
    assert.deepEqual(
      outcome.received.map((message) => message.body),
      ["hola", "eco uno"],
    );
    assert.equal(outcome.session.status, "closed");
    assert.deepEqual(
      outcome.session.conversation.messages.map((message) => [message.direction, message.body]),
      [
        ["in", "hola"],
        ["out", "uno"],
        ["in", "eco uno"],
      ],
    );
    assert.equal(transport.sent.some((sent) => sent.text === "nunca"), false);
  });

  test("un servidor que cierra solo: la sesión se lee ya guardada, con su transcripción", async () => {
    const { runner, transport, add } = world();
    transport.script("wss://eco.example.test/socket", { greeting: ["adiós"], closeAfterGreeting: 4001 });
    const ws = await add(channel("ws", { messages: [{ name: "saludo", body: "hola" }] }));
    const outcome = await runner.run(input(ws.id));
    assert.equal(outcome.kind, "session");
    if (outcome.kind !== "session") return;
    assert.equal(outcome.session.conversation.closeCode, 4001);
    assert.deepEqual(
      outcome.session.conversation.messages.map((message) => message.body),
      ["adiós"],
    );
    assert.deepEqual(outcome.received, [{ body: "adiós" }]);
  });

  test("MQTT: los mensajes guardados con su tema, QoS y retain, hasta los que se esperan", async () => {
    const mqtt = mqttTransport();
    const { runner, add } = world({ mqtt });
    const broker = await add(
      channel("mqtt", {
        url: "mqtt://b.example.test",
        messages: [
          { name: "a", body: "1", topic: "casa/luz", qos: 1, retain: true },
          { name: "b", body: "2", topic: "casa/puerta" },
        ],
      }),
    );
    const outcome = await runner.run(input(broker.id, { untilMessages: 2, idleMs: 5_000 }));
    assert.equal(outcome.kind, "session");
    if (outcome.kind !== "session") return;
    assert.deepEqual(outcome.problems, []);
    assert.deepEqual(outcome.received, [
      { body: "eco 1", topic: "casa/luz" },
      { body: "eco 2", topic: "casa/puerta" },
    ]);
    const out = outcome.session.conversation.messages.filter((message) => message.direction === "out");
    assert.deepEqual(
      out.map((message) => [message.topic, message.qos, message.retain]),
      [
        ["casa/luz", 1, true],
        ["casa/puerta", 0, false],
      ],
    );
    assert.equal(mqtt.plans[0].clientId.startsWith("eq-"), true);
  });

  test("Socket.IO: cada trama guardada es un evento, con el acuse si lo pide el guion", async () => {
    const io = socketIoTransport();
    const { runner, add } = world({ socketio: io });
    const server = await add(
      channel("socketio", {
        url: "https://io.example.test/chat",
        messages: [{ name: "a", body: '{"sala":1}', event: "unirse" }],
      }),
    );
    const saved = await runner.run(input(server.id, { untilMessages: 1 }));
    assert.equal(saved.kind, "session");
    assert.deepEqual(io.emitted, [["unirse", [{ sala: 1 }], false]]);
    assert.equal(io.options[0].namespace, "/chat");
    assert.deepEqual(saved.kind === "session" && saved.received, [{ body: "recibido unirse", event: "unirse" }]);

    const scripted = await runner.run(
      input(server.id, { untilMessages: 1, messages: [{ action: "send", body: "", event: "ping", ack: true }] }),
    );
    assert.equal(scripted.kind, "session");
    assert.deepEqual(io.emitted[1], ["ping", [], true]);
  });
});

describe("una sesión sin pantalla: gRPC y cierres a mitad de guion", () => {
  /** Un planificador que abre un canal a mano: con envío que terminar, o sin él (unaria). */
  function planner(options: { halfClose: boolean; requests: (string | undefined)[] }) {
    let ends = 0;
    const grpc = {
      prepare: async (channel: Channel) => {
        options.requests.push(channel.grpc?.message);
        return async (listeners: ChannelListeners) => {
          listeners.onOpen?.();
          listeners.onMessage(Buffer.from('{"ok":true}'), false);
          return {
            send: () => {},
            close: () => {},
            end: () => {
              if (!options.halfClose) throw new ConflictError("unaria", "grpc-not-client-streaming");
              ends += 1;
              listeners.onClose(0, "OK");
            },
          } satisfies OpenChannel;
        };
      },
    } as unknown as GrpcSessionPlanner;
    return { grpc, ends: () => ends };
  }

  test("un stream de cliente se termina solo al acabar el guion; la petición de la corrida sustituye la guardada", async () => {
    const requests: (string | undefined)[] = [];
    const { grpc, ends } = planner({ halfClose: true, requests });
    const { runner, add } = world({ grpc });
    const call = await add(
      channel("grpc", { url: "grpc://svc.example.test:1", grpc: { ...DEFAULT_GRPC_SETTINGS, message: '{"guardada":1}' } }),
    );
    const outcome = await runner.run(input(call.id, { request: '{"de":"la corrida"}' }));
    assert.equal(outcome.kind, "session");
    assert.equal(ends(), 1);
    assert.deepEqual(requests, ['{"de":"la corrida"}']);
    assert.deepEqual(outcome.kind === "session" && outcome.received, [{ body: '{"ok":true}' }]);
    assert.equal(outcome.kind === "session" && outcome.session.conversation.closeCode, 0);
  });

  test("una unaria no tiene envío que terminar, y eso no es un problema del guion", async () => {
    const { grpc } = planner({ halfClose: false, requests: [] });
    const { runner, add } = world({ grpc });
    const call = await add(
      channel("grpc", {
        url: "grpc://svc.example.test:1",
        grpc: { ...DEFAULT_GRPC_SETTINGS },
        expectations: { status: 0, minMessages: 1 },
      }),
    );
    // Sin `untilMessages`: manda el `minMessages` del canal, que ya se cumplió con la respuesta.
    const outcome = await runner.run(input(call.id));
    assert.equal(outcome.kind, "session");
    assert.deepEqual(outcome.kind === "session" && outcome.problems, []);
    assert.equal(outcome.kind === "session" && outcome.session.status, "closed");
  });

  test("un servidor que cierra a mitad de guion: lo que quedaba no se manda", async () => {
    const { runner, transport, add } = world();
    transport.script("wss://eco.example.test/socket", { greeting: ["adiós"], closeAfterGreeting: 1000 });
    const ws = await add(channel("ws"));
    const outcome = await runner.run(
      input(ws.id, {
        messages: [
          { action: "wait", messages: 5, timeoutMs: 200 },
          { action: "send", body: "tarde", delayMs: 1 },
        ],
      }),
    );
    assert.equal(outcome.kind, "session");
    assert.deepEqual(outcome.kind === "session" && outcome.problems, []);
    assert.equal(transport.sent.length, 0);
  });
});

describe("el guion por omisión", () => {
  test("gRPC no manda sus tramas guardadas: su petición va con la llamada", () => {
    const grpc = channel("grpc", {
      grpc: { ...DEFAULT_GRPC_SETTINGS },
      messages: [{ name: "a", body: "{}" }],
    });
    assert.deepEqual(defaultScript(grpc), []);
    assert.deepEqual(defaultScript(channel("ws", { messages: [{ name: "a", body: "x" }] })), [
      { action: "send", body: "x" },
    ]);
  });
});
