/**
 * Los canales sin la API delante, en lo que las demás pruebas no pisan: crear sin nombre ni URL, los
 * `.proto` que chocan con un tipo bien conocido (antes, un 500), la reflexión que falla con cada
 * clase de error, el esquema (un `import` por su ruta exacta, dos servicios, descriptores rotos), la
 * sesión ya terminada, un espacio de nombres vacío, `{{$hmacSha256}}` en un mensaje, y una sesión sin
 * pantalla a la que el otro lado corta en cada momento del guion o que nadie para hasta el plazo.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { CreateChannelCommand, CreateChannelHandler } from "@/modules/channels/application/commands/manage-channels";
import {
  GetGrpcSchemaHandler,
  GetGrpcSchemaQuery,
  ReflectGrpcCommand,
  ReflectGrpcHandler,
  SaveChannelProtosCommand,
  SaveChannelProtosHandler,
} from "@/modules/channels/application/commands/manage-grpc";
import { ChannelSessionOpener } from "@/modules/channels/application/commands/manage-sessions";
import { HeadlessChannelRunner } from "@/modules/channels/application/headless-session";
import { GrpcSessionPlanner, type GrpcPlanContext } from "@/modules/channels/application/grpc";
import { DEFAULT_GRPC_SETTINGS } from "@/modules/channels/domain/grpc";
import {
  ProtoSchemaError,
  schemaFromDescriptors,
  schemaFromFiles,
  type GrpcSchema,
} from "@/modules/channels/domain/grpc-schema";
import { DEFAULT_LIMITS, blankChannel, type Channel, type ChannelProtocol } from "@/modules/channels/domain/model";
import { DEFAULT_MQTT } from "@/modules/channels/domain/mqtt";
import { onFrame, onTick, startSession, type ChannelSession } from "@/modules/channels/domain/session";
import { DEFAULT_SOCKETIO, socketIoSessionPlan } from "@/modules/channels/domain/socketio";
import { ChannelProgressStream } from "@/modules/channels/infrastructure/channel-progress.stream";
import { ReflectionError } from "@/modules/channels/infrastructure/grpc-reflection";
import type {
  GrpcCall,
  GrpcCallFromSchema,
  GrpcTarget,
  GrpcTransportPort,
} from "@/modules/channels/infrastructure/grpc-transport";
import type { MqttTransportPort, TimelessFrame } from "@/modules/channels/infrastructure/mqtt-transport";
import { ChannelSessionRegistry } from "@/modules/channels/infrastructure/session-registry";
import type { ChannelListeners, OpenChannel } from "@/modules/channels/infrastructure/ws-transport";
import type { Project } from "@/modules/projects/domain/model";
import { FixedClock } from "@/shared/clock/clock.port";
import { loadEnv } from "@/shared/config/env";
import { DomainError, InvalidInputError } from "@/shared/errors/domain-error";
import { BlockedTargetError } from "@/shared/http/safe-fetch";
import { InMemoryChannelRepository, InMemoryChannelSessionRepository } from "../support/in-memory-channels";
import { InMemoryChannelProtoRepository } from "../support/in-memory-protos";
import { InMemoryEnvironmentRepository, InMemoryProjectRepository } from "../support/in-memory-repositories";
import { StubChannelTransport } from "../support/stub-channel-transport";
import { TEST_ENV } from "../support/test-app";

const ORG = "org";
const PROJECT = "proyecto";
const env = loadEnv({ ...TEST_ENV });
const plain = { encrypt: (text: string) => text, decrypt: (text: string) => text };
const clock = new FixedClock(new Date("2026-03-01T10:00:00.000Z"));

function projects(): InMemoryProjectRepository {
  const repository = new InMemoryProjectRepository();
  repository.rows.set(PROJECT, { id: PROJECT, organizationId: ORG, archivedAt: null, deletedAt: null } as Project);
  return repository;
}

function channel(protocol: ChannelProtocol, over: Partial<Channel> = {}): Channel {
  return {
    ...blankChannel({
      id: `canal-${Math.random().toString(36).slice(2, 8)}`,
      projectId: PROJECT,
      name: "canal",
      url: protocol === "mqtt" ? "mqtt://broker.example.test" : "wss://eco.example.test/socket",
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

// ---------------------------------------------------------------------------------------------

describe("crear un canal", () => {
  test("sin nombre ni URL es un 422 que nombra los dos, aunque quien llama no los mande", async () => {
    const channels = new InMemoryChannelRepository();
    const handler = new CreateChannelHandler(projects(), channels, clock, env);
    const error = await rejection(
      handler.execute(new CreateChannelCommand(ORG, PROJECT, {} as CreateChannelCommand["input"], "persona")),
    );
    assert.ok(error instanceof InvalidInputError);
    assert.deepEqual(error.fields.map((field) => field.field).sort(), ["name", "url"]);
    assert.equal(await channels.countByProject(PROJECT), 0);
  });
});

/** Un fichero que redefine `google.protobuf.Timestamp` y otro que importa el de verdad. */
const CLASHING = [
  { path: "propio.proto", content: 'syntax = "proto3"; package google.protobuf; message Timestamp { int64 x = 1; }' },
  {
    path: "usa.proto",
    content:
      'syntax = "proto3"; import "google/protobuf/timestamp.proto"; message Usa { google.protobuf.Timestamp t = 1; }',
  },
];

describe("los .proto de un canal gRPC", () => {
  async function grpcWorld() {
    const channels = new InMemoryChannelRepository();
    const protos = new InMemoryChannelProtoRepository();
    const grpc = channel("grpc", { url: "grpc://svc.example.test:50051" });
    await channels.save(grpc);
    return { channels, protos, grpc, repository: projects() };
  }

  test("sin ficheros, la definición está vacía y sin problema", async () => {
    const { channels, protos, grpc, repository } = await grpcWorld();
    const view = await new GetGrpcSchemaHandler(repository, channels, protos).execute(
      new GetGrpcSchemaQuery(ORG, PROJECT, grpc.id),
    );
    assert.deepEqual(view, { files: [], services: [], problem: null });
  });

  test("un tipo bien conocido redefinido en un fichero subido es un 422 al guardar, no un 500", async () => {
    const { channels, protos, grpc, repository } = await grpcWorld();
    const error = await rejection(
      new SaveChannelProtosHandler(repository, channels, protos).execute(
        new SaveChannelProtosCommand(ORG, PROJECT, grpc.id, CLASHING),
      ),
    );
    assert.ok(error instanceof InvalidInputError);
    assert.equal(error.message, "Los .proto no se pudieron leer");
    assert.match(
      error.fields[0].detail,
      /^google\/protobuf\/timestamp\.proto choca con un tipo de los ficheros subidos: duplicate name 'Timestamp'/,
    );
    assert.deepEqual(await protos.list(grpc.id), []);
  });

  test("y uno así ya guardado se enseña con los ficheros y el motivo", async () => {
    const { channels, protos, grpc, repository } = await grpcWorld();
    await protos.replace(grpc.id, CLASHING);
    const view = await new GetGrpcSchemaHandler(repository, channels, protos).execute(
      new GetGrpcSchemaQuery(ORG, PROJECT, grpc.id),
    );
    assert.deepEqual(
      view.files.map((file) => file.path),
      ["propio.proto", "usa.proto"],
    );
    assert.deepEqual(view.services, []);
    assert.match(view.problem ?? "", /choca con un tipo de los ficheros subidos/);
  });
});

describe("la reflexión bajo demanda", () => {
  async function reflectWith(failure: unknown) {
    const channels = new InMemoryChannelRepository();
    const grpc = channel("grpc", { url: "grpc://svc.example.test:50051" });
    await channels.save(grpc);
    const planner = {
      reflect: async () => {
        throw failure;
      },
    } as unknown as GrpcSessionPlanner;
    const handler = new ReflectGrpcHandler(
      projects(),
      channels,
      new InMemoryEnvironmentRepository(),
      plain,
      env,
      planner,
    );
    return rejection(handler.execute(new ReflectGrpcCommand(ORG, PROJECT, grpc.id, null)));
  }

  test("la guarda, el servidor o sus descriptores: un 422 con el motivo en la URL", async () => {
    for (const failure of [
      new BlockedTargetError("grpc://svc.example.test:50051", "loopback"),
      new ReflectionError("El servidor no tiene la reflexión activada"),
      new ProtoSchemaError("descriptores rotos"),
    ]) {
      const error = await reflectWith(failure);
      assert.ok(error instanceof InvalidInputError);
      assert.equal(error.code, "grpc-reflection-failed");
      assert.equal(error.message, failure.message);
      assert.deepEqual(error.fields, [{ field: "url", detail: failure.message }]);
    }
  });

  test("un rechazo propio del planificador —la metadata— sale tal cual, sin envolverlo", async () => {
    const own = new InvalidInputError("La metadata binaria no es base64", [{ field: "headers", detail: "a-bin" }]);
    const error = await reflectWith(own);
    assert.equal(error, own);
  });
});

describe("el esquema", () => {
  test("un import por su ruta exacta, y dos servicios del mismo paquete en orden", () => {
    const schema = schemaFromFiles([
      {
        path: "tienda.proto",
        content: `syntax = "proto3"; package t; import "comun.proto";
          service Zeta { rpc A (c.Vacio) returns (c.Vacio); }
          service Alfa { rpc B (c.Vacio) returns (c.Vacio); }`,
      },
      { path: "comun.proto", content: 'syntax = "proto3"; package c; message Vacio {}' },
    ]);
    assert.deepEqual(
      schema.services().map((service) => service.name),
      ["t.Alfa", "t.Zeta"],
    );
  });

  test("unos descriptores que no se leen son un error del esquema, con el motivo", () => {
    assert.throws(
      () => schemaFromDescriptors([Uint8Array.from([0x0f])]),
      (error: unknown) =>
        error instanceof ProtoSchemaError &&
        /^La reflexión devolvió descriptores que no se pudieron leer: /.test(error.message),
    );
  });
});

describe("la sesión en el dominio", () => {
  const fresh = (): ChannelSession =>
    startSession({
      id: "s",
      channelId: "c",
      projectId: PROJECT,
      environmentId: null,
      ownerInstance: "i",
      startedBy: "persona",
      now: clock.now(),
    });

  test("una sesión terminada no cambia con una trama ni con el reloj", () => {
    const finished: ChannelSession = { ...fresh(), status: "closed" };
    const after = onFrame(finished, { direction: "in", atMs: 5, body: "tarde" }, DEFAULT_LIMITS, { secrets: [] });
    assert.equal(after.session, finished);
    assert.equal(after.stop, null);
    assert.equal(onTick(finished, DEFAULT_LIMITS.maxDurationMs + 1, DEFAULT_LIMITS), null);
  });

  test("sin mensajes y sin apertura anotada, la inactividad se cuenta desde cero", () => {
    const session = fresh();
    assert.equal(session.conversation.openedAtMs, null);
    assert.equal(onTick(session, DEFAULT_LIMITS.idleMs - 1, DEFAULT_LIMITS), null);
    assert.equal(onTick(session, DEFAULT_LIMITS.idleMs, DEFAULT_LIMITS), "idle-cap");
  });
});

describe("el plan de Socket.IO", () => {
  test("un espacio de nombres vacío es la raíz, y con la raíz manda la ruta de la URL", () => {
    const { plan } = socketIoSessionPlan(
      { ...DEFAULT_SOCKETIO, namespace: "" },
      "https://io.example.test/sala",
      (x) => x,
      [],
    );
    assert.equal(plan.namespace, "/sala");
    const bare = socketIoSessionPlan(
      { ...DEFAULT_SOCKETIO, namespace: "{{vacio}}" },
      "https://io.example.test",
      () => "",
      [],
    );
    assert.equal(bare.plan.namespace, "/");
  });
});

describe("gRPC con reflexión y un stream de cliente", () => {
  test("no hay petición que comprobar al invocar: se llama sin ella", async () => {
    const schema = schemaFromFiles([
      {
        path: "caja.proto",
        content: `syntax = "proto3"; package caja; message Pedido { string id = 1; }
          service Caja { rpc Subir (stream Pedido) returns (Pedido); }`,
      },
    ]);
    const calls: GrpcCall[] = [];
    const transport: GrpcTransportPort = {
      reflect: async () => schema,
      call: async (_target: GrpcTarget, call: GrpcCall | GrpcCallFromSchema, _listeners: ChannelListeners) => {
        calls.push(typeof call === "function" ? call(schema as GrpcSchema) : call);
        return { send: () => {}, close: () => {} };
      },
    };
    const planner = new GrpcSessionPlanner(transport, new InMemoryChannelProtoRepository(), env);
    const context: GrpcPlanContext = {
      url: "grpc://caja.example.test:50051",
      headers: {},
      interpolate: (text) => text,
      limits: DEFAULT_LIMITS,
      // Sin escrituras: con una petición que comprobar, un método con efectos no se invocaría.
      readOnly: false,
      environmentName: "",
    };
    const open = await planner.prepare(
      channel("grpc", {
        url: context.url,
        grpc: {
          ...DEFAULT_GRPC_SETTINGS,
          source: "reflection",
          service: "caja.Caja",
          method: "Subir",
          message: "{{falta}}",
        },
      }),
      context,
    );
    await open({} as ChannelListeners);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].request, null);
    assert.equal(calls[0].method.method.name, "Subir");
  });
});

// ---------------------------------------------------------------------------------------------

let registries: ChannelSessionRegistry[] = [];
afterEach(async () => {
  for (const registry of registries) await registry.onModuleDestroy();
  registries = [];
});

type Emit = (frame: TimelessFrame) => void;

/** Un broker MQTT a medida: abre en el acto y hace lo que diga el guion al abrir y al publicar. */
function scriptedMqtt(script: { onOpen?: (emit: Emit) => void; onSend?: (text: string, emit: Emit) => void } = {}) {
  const sent: string[] = [];
  const transport: MqttTransportPort = {
    async open(_url, _options, emit): Promise<OpenChannel> {
      emit({ direction: "open" });
      script.onOpen?.(emit);
      return {
        send: (text) => {
          sent.push(text);
          script.onSend?.(text, emit);
        },
        close: () => {},
      };
    },
  };
  return { transport, sent };
}

function world(mqtt: MqttTransportPort | null = null) {
  const channels = new InMemoryChannelRepository();
  const sessions = new InMemoryChannelSessionRepository();
  const environments = new InMemoryEnvironmentRepository();
  const transport = new StubChannelTransport();
  // Sin `onModuleInit`: sin el reloj del registro, nada corta una sesión por tiempo salvo el guion.
  const registry = new ChannelSessionRegistry(sessions, transport, clock, env, new ChannelProgressStream(), mqtt);
  registries.push(registry);
  const grpc = {} as GrpcSessionPlanner;
  const opener = new ChannelSessionOpener(environments, plain, clock, env, registry, grpc, null);
  const runner = new HeadlessChannelRunner(channels, sessions, opener, registry);
  const add = async (value: Channel) => {
    await channels.save(value);
    return value;
  };
  return { transport, registry, opener, runner, add };
}

const run = (channelId: string, node: Record<string, unknown> = {}) => ({
  projectId: PROJECT,
  channelId,
  environmentId: null,
  actorId: "persona",
  node: { channelId, ...node },
  variables: {},
  secrets: [],
});

const later = (ms: number, what: () => void) => setTimeout(what, ms);

describe("interpolar un mensaje", () => {
  test("{{$hmacSha256:clave:texto}} sale firmado, en hexadecimal", async () => {
    const { transport, opener, registry, add } = world();
    transport.script("wss://eco.example.test/socket", {});
    const ws = await add(channel("ws"));
    const session = await opener.open({ projectId: PROJECT, channel: ws, environmentId: null, actorId: "persona" });
    await registry.send(session.id, "firma={{$hmacSha256:clave:texto}}");
    assert.deepEqual(
      transport.sent.map((sent) => sent.text),
      [`firma=${createHmac("sha256", "clave").update("texto").digest("hex")}`],
    );
  });
});

describe("una sesión sin pantalla a la que cortan", () => {
  const send = (body: string, over: Record<string, unknown> = {}) => ({ action: "send", body, topic: "t", ...over });

  test("un mensaje recibido sin cuerpo llega como texto vacío, con su tema", async () => {
    const mqtt = scriptedMqtt({ onSend: (_text, emit) => emit({ direction: "in", topic: "casa/luz" }) });
    const { runner, add } = world(mqtt.transport);
    const broker = await add(channel("mqtt"));
    const outcome = await runner.run(run(broker.id, { messages: [send("hola")], untilMessages: 1 }));
    assert.equal(outcome.kind, "session");
    assert.deepEqual(outcome.kind === "session" && outcome.received, [{ body: "", topic: "casa/luz" }]);
  });

  test("el broker cierra al primer mensaje: el resto del guion no sale", async () => {
    const mqtt = scriptedMqtt({ onSend: (_text, emit) => emit({ direction: "close", closeReason: "fuera" }) });
    const { runner, add } = world(mqtt.transport);
    const broker = await add(channel("mqtt"));
    const outcome = await runner.run(run(broker.id, { messages: [send("uno"), send("dos")] }));
    assert.equal(outcome.kind, "session");
    assert.deepEqual(mqtt.sent, ["uno"]);
    assert.deepEqual(outcome.kind === "session" && outcome.problems, []);
  });

  test("cierra mientras el guion hace la pausa de un envío: ese envío no sale", async () => {
    const mqtt = scriptedMqtt({
      onOpen: (emit) => later(20, () => emit({ direction: "close", closeReason: "fuera" })),
    });
    const { runner, add } = world(mqtt.transport);
    const broker = await add(channel("mqtt"));
    const outcome = await runner.run(run(broker.id, { messages: [send("tarde", { delayMs: 300 })] }));
    assert.equal(outcome.kind, "session");
    assert.deepEqual(mqtt.sent, []);
  });

  test("cierra mientras se esperan mensajes: la espera acaba con el cierre, no con su plazo", async () => {
    const mqtt = scriptedMqtt({
      onOpen: (emit) => later(20, () => emit({ direction: "close", closeReason: "fuera" })),
    });
    const { runner, add } = world(mqtt.transport);
    const broker = await add(channel("mqtt"));
    const started = Date.now();
    const outcome = await runner.run(
      run(broker.id, { messages: [{ action: "wait", messages: 3, timeoutMs: 5_000 }], untilMessages: 3 }),
    );
    assert.equal(outcome.kind, "session");
    assert.ok(Date.now() - started < 2_000);
    assert.equal(outcome.kind === "session" && outcome.session.status, "closed");
  });

  test("un envío que el transporte no puede hacer se anota con su motivo y para el guion", async () => {
    const mqtt = scriptedMqtt({
      onSend: () => {
        throw new Error("el socket se cortó");
      },
    });
    const { runner, add } = world(mqtt.transport);
    const broker = await add(channel("mqtt"));
    // Sin mensajes que esperar: al pararse el guion, se cierra.
    const outcome = await runner.run(run(broker.id, { messages: [send("uno"), send("dos")], untilMessages: 0 }));
    assert.equal(outcome.kind, "session");
    assert.deepEqual(outcome.kind === "session" && outcome.problems, ["Acción 1 (send): el socket se cortó"]);
    assert.deepEqual(mqtt.sent, ["uno"]);
  });

  test("una sesión que nadie para se cierra aquí al pasar la duración del canal y el margen", async () => {
    const mqtt = scriptedMqtt();
    const { runner, add, registry } = world(mqtt.transport);
    const broker = await add(channel("mqtt", { limits: { ...DEFAULT_LIMITS, maxDurationMs: 30 }, mqtt: DEFAULT_MQTT }));
    const started = Date.now();
    const outcome = await runner.run(run(broker.id, { messages: [], untilMessages: 5 }));
    const took = Date.now() - started;
    assert.equal(outcome.kind, "session");
    assert.equal(outcome.kind === "session" && outcome.session.status, "closed");
    // La duración (30 ms) y el margen de 2 s: el reloj del registro no corrió, así que corta esto.
    assert.ok(took >= 2_000 && took < 4_000, `tardó ${took} ms`);
    assert.equal(registry.size, 0);
  });
});
