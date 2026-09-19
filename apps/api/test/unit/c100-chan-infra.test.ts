/**
 * La infraestructura de los canales en lo que las demás pruebas no pisan: el registro cuando la fila
 * de la sesión ya no está, un evento de Socket.IO sin interpolación, los fallos de guardar y de latir
 * que no son `Error`; el stream en vivo con lo que llega mientras se lee la instantánea; y la
 * reflexión gRPC contra servidores escritos a mano que contestan otra cosa de la que se pregunta,
 * repiten dependencias, describen ficheros sin fin o se caen, más un método que el servidor no tiene.
 */
import { after, afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Server, ServerCredentials, status as grpcStatus, type ServerDuplexStream } from "@grpc/grpc-js";
import { fromJSON } from "@grpc/proto-loader";
import * as protobuf from "protobufjs";
import * as descriptor from "protobufjs/ext/descriptor";
import { firstValueFrom, toArray, type Observable } from "rxjs";
import type { QueryBus } from "@nestjs/cqrs";

import type { ChannelSessionView } from "@/modules/channels/application/views";
import { schemaFromFiles } from "@/modules/channels/domain/grpc-schema";
import { DEFAULT_LIMITS } from "@/modules/channels/domain/model";
import { startSession, type ChannelSession } from "@/modules/channels/domain/session";
import { ChannelProgressStream } from "@/modules/channels/infrastructure/channel-progress.stream";
import { ReflectionError } from "@/modules/channels/infrastructure/grpc-reflection";
import { GrpcChannelTransport, type GrpcTarget } from "@/modules/channels/infrastructure/grpc-transport";
import { ChannelSessionRegistry, type SessionPlan } from "@/modules/channels/infrastructure/session-registry";
import type { ChannelListeners, OpenChannel } from "@/modules/channels/infrastructure/ws-transport";
import { ChannelsController } from "@/modules/channels/presentation/channels.controller";
import { InMemoryBusHub, InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import { FixedClock } from "@/shared/clock/clock.port";
import { loadEnv, type Env } from "@/shared/config/env";
import { InMemoryChannelSessionRepository } from "../support/in-memory-channels";
import { SHOP_FILES } from "../support/grpc-server";
import { StubChannelTransport } from "../support/stub-channel-transport";
import { TEST_ENV } from "../support/test-app";

// ---------------------------------------------------------------------------------------------

let registries: ChannelSessionRegistry[] = [];
afterEach(async () => {
  for (const registry of registries) await registry.onModuleDestroy();
  registries = [];
});

function setup(options: { hub?: InMemoryBusHub; repository?: InMemoryChannelSessionRepository } = {}) {
  const repository = options.repository ?? new InMemoryChannelSessionRepository();
  const clock = new FixedClock(new Date("2026-03-01T10:00:00.000Z"));
  const env = { CHANNEL_MAX_OPEN: 10, REQUEST_TIMEOUT_MS: 5_000 } as Env;
  const bus = options.hub ? new InMemoryInstanceBus(options.hub) : null;
  const registry = new ChannelSessionRegistry(
    repository,
    new StubChannelTransport(),
    clock,
    env,
    new ChannelProgressStream(),
    null,
    bus,
  );
  registries.push(registry);
  const logged: string[] = [];
  (registry as unknown as { logger: { error: (text: string) => void } }).logger.error = (text) => logged.push(text);
  return { repository, clock, registry, logged };
}

let counter = 0;
const newSession = (registry: ChannelSessionRegistry, clock: FixedClock): ChannelSession =>
  startSession({
    id: `00000000-0000-4000-a000-${String((counter += 1)).padStart(12, "0")}`,
    channelId: "canal",
    projectId: "proyecto",
    environmentId: null,
    ownerInstance: registry.instance,
    startedBy: "persona",
    now: clock.now(),
  });

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

const opened =
  (extra: Partial<OpenChannel> = {}) =>
  async (listeners: ChannelListeners): Promise<OpenChannel> => {
    listeners.onOpen?.({ status: 101, headers: {} });
    return { send: () => {}, close: () => {}, ...extra };
  };

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("el registro cuando la fila ya no está", () => {
  test("una apertura que termina sin fila (el canal se borró mientras conectaba) devuelve la sesión de partida", async () => {
    const { registry, clock, repository } = setup();
    const start = newSession(registry, clock);
    const result = await registry.start(start, {
      ...plan(),
      open: async (listeners) => {
        listeners.onOpen?.({ status: 101, headers: {} });
        listeners.onClose(4000, "adiós");
        for (let index = 0; index < 5; index++) await settle();
        repository.rows.delete(start.id);
        return { send: () => {}, close: () => {} };
      },
    });
    assert.equal(result, start);
    assert.equal(registry.owns(start.id), false);
  });

  test("cerrar por el bus una sesión cuya fila no se encuentra aquí devuelve la que se tenía", async () => {
    const hub = new InMemoryBusHub();
    const owner = setup({ hub });
    // Otra instancia con otra base de datos (o con la fila ya borrada): no la encuentra al releer.
    const other = setup({ hub, repository: new InMemoryChannelSessionRepository() });
    const session = await owner.registry.start(newSession(owner.registry, owner.clock), plan({ open: opened() }));
    const row = (await owner.repository.findById("proyecto", session.id))!;
    const closed = await other.registry.route(row, { op: "close", sessionId: row.id });
    assert.equal(closed, row);
    assert.equal(owner.registry.owns(row.id), false);
  });
});

describe("el registro en lo que no es de todos los días", () => {
  test("un evento de Socket.IO en una sesión sin interpolación sale tal cual, sin buscar variables", async () => {
    const { registry, clock } = setup();
    const emitted: [string, unknown[], boolean][] = [];
    const session = await registry.start(
      newSession(registry, clock),
      plan({ open: opened({ emit: (event, args, ack) => emitted.push([event, args, ack]) }) }),
    );
    await registry.send(session.id, "{{sin_resolver}}", undefined, undefined, { event: "sala", ack: false });
    assert.deepEqual(emitted, [["sala", ["{{sin_resolver}}"], false]]);
  });

  test("un latido que falla con algo que no es un Error se registra con su texto", async () => {
    const { registry, repository, logged } = setup();
    repository.findStale = async () => {
      throw "sin conexión";
    };
    await registry.beat();
    assert.deepEqual(logged, ["El latido de las sesiones falló: sin conexión"]);
  });

  test("un mensaje que no se puede guardar, con un fallo que no es un Error, se registra y la sesión sigue", async () => {
    const repository = new InMemoryChannelSessionRepository();
    repository.appendMessages = async () => {
      throw "disco lleno";
    };
    const { registry, clock, logged } = setup({ repository });
    const session = await registry.start(newSession(registry, clock), plan({ open: opened() }));
    await registry.send(session.id, "hola");
    assert.deepEqual(logged, [`No se pudo guardar un mensaje de ${session.id}: disco lleno`]);
    assert.equal(registry.owns(session.id), true);
  });
});

// ---------------------------------------------------------------------------------------------

describe("el stream en vivo de una sesión", () => {
  const message = (seq: number) => ({ seq, direction: "in", atMs: seq, body: `m${seq}` });

  /** Un controlador cuya consulta tarda: lo que se publique mientras tanto queda retenido. */
  function controller(view: Partial<ChannelSessionView>, duringRead: (progress: ChannelProgressStream) => void) {
    const progress = new ChannelProgressStream();
    const queryBus = {
      execute: async () => {
        duringRead(progress);
        await settle();
        return { id: "s1", status: "open", live: true, ...view } as ChannelSessionView;
      },
    } as unknown as QueryBus;
    return new ChannelsController({} as never, queryBus, progress);
  }

  const collect = async (stream: Promise<Observable<{ data: unknown; type: string }>>) =>
    firstValueFrom((await stream).pipe(toArray()));

  test("lo publicado durante la lectura sale después de la instantánea, sin repetir lo que ya traía", async () => {
    const events = await collect(
      controller({ messages: [message(0), message(1)] as never }, (progress) => {
        progress.publish({ sessionId: "s1", type: "message", message: message(1) as never });
        progress.publish({ sessionId: "s1", type: "message", message: message(2) as never });
        progress.publish({ sessionId: "s1", type: "finished", status: "closed", stopReason: "closed-by-us" });
      }).stream("org", "proyecto", "s1"),
    );
    assert.deepEqual(
      events.map((event) =>
        event.type === "message" ? `message ${(event.data as { message: { seq: number } }).message.seq}` : event.type,
      ),
      ["snapshot", "message 2", "finished"],
    );
  });

  test("una vista sin mensajes empieza a contar desde el primero", async () => {
    const events = await collect(
      controller({}, (progress) => {
        progress.publish({ sessionId: "s1", type: "message", message: message(0) as never });
        progress.publish({ sessionId: "s1", type: "finished", status: "closed", stopReason: "closed-by-us" });
      }).stream("org", "proyecto", "s1"),
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["snapshot", "message", "finished"],
    );
  });
});

// ---------------------------------------------------------------------------------------------

const REFLECTION_PROTO = (pkg: string) => `
syntax = "proto3";
package ${pkg};
service ServerReflection {
  rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse);
}
message ServerReflectionRequest {
  string host = 1;
  oneof message_request { string file_by_filename = 3; string file_containing_symbol = 4; string list_services = 7; }
}
message ServerReflectionResponse {
  string valid_host = 1;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }
`;

function reflectionService(pkg: string) {
  const root = new protobuf.Root();
  protobuf.parse(REFLECTION_PROTO(pkg), root, { keepCase: true });
  return fromJSON(root.toJSON(), { keepCase: true, defaults: true, oneofs: true })[`${pkg}.ServerReflection`] as never;
}

type Request = { list_services?: string; file_containing_symbol?: string; file_by_filename?: string };
type Answer = (request: Request, call: ServerDuplexStream<Request, object>) => void;

const fileBytes = (value: object) =>
  Buffer.from(descriptor.FileDescriptorProto.encode(descriptor.FileDescriptorProto.fromObject(value)).finish());
const FILE_B = fileBytes({
  name: "b.proto",
  package: "b",
  syntax: "proto3",
  messageType: [{ name: "Hoja", field: [{ name: "id", number: 1, label: 1, type: 9, jsonName: "id" }] }],
});
const FILE_A = fileBytes({
  name: "a.proto",
  package: "a",
  syntax: "proto3",
  dependency: ["b.proto"],
  messageType: [
    { name: "Pedido", field: [{ name: "hoja", number: 1, label: 1, type: 11, typeName: ".b.Hoja", jsonName: "hoja" }] },
  ],
  service: [{ name: "Arbol", method: [{ name: "Ver", inputType: ".a.Pedido", outputType: ".b.Hoja" }] }],
});

const transport = new GrpcChannelTransport({ ...loadEnv(TEST_ENV), ALLOW_PRIVATE_TARGETS: true });
const servers: Server[] = [];
after(() => {
  for (const server of servers) server.forceShutdown();
});

async function reflectionServer(answer: Answer, version: "v1" | "v1alpha" = "v1"): Promise<GrpcTarget> {
  const server = new Server();
  server.addService(reflectionService(`grpc.reflection.${version}`), {
    ServerReflectionInfo: (call: ServerDuplexStream<Request, object>) => {
      call.on("data", (request: Request) => answer(request, call));
      call.on("end", () => call.end());
    },
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, bound) =>
      error ? reject(error) : resolve(bound),
    ),
  );
  servers.push(server);
  return { url: `grpc://127.0.0.1:${port}`, metadata: {}, connectTimeoutMs: 2_000, maxMessageBytes: 1 << 20 };
}

describe("la reflexión contra servidores que contestan de lado", () => {
  test("a la lista contesta con otra cosa: no hay servicios que leer", async () => {
    const target = await reflectionServer((_request, call) =>
      call.write({ file_descriptor_response: { file_descriptor_proto: [FILE_B] } }),
    );
    assert.deepEqual((await transport.reflect(target)).services(), []);
  });

  test("a un fichero contesta con otra cosa: el servicio listado se queda sin definición", async () => {
    const target = await reflectionServer((request, call) =>
      call.write(
        request.list_services !== undefined
          ? { list_services_response: { service: [{ name: "a.Arbol" }] } }
          : { list_services_response: { service: [] } },
      ),
    );
    assert.deepEqual((await transport.reflect(target)).services(), []);
  });

  test("un fichero que llega con su dependencia ya dentro no se vuelve a pedir", async () => {
    const asked: string[] = [];
    const target = await reflectionServer((request, call) => {
      if (request.list_services !== undefined)
        return call.write({ list_services_response: { service: [{ name: "a.Arbol" }] } });
      asked.push(request.file_containing_symbol ?? `fichero ${request.file_by_filename}`);
      call.write({ file_descriptor_response: { file_descriptor_proto: [FILE_A, FILE_B] } });
    });
    const [service] = (await transport.reflect(target)).services();
    assert.equal(service.name, "a.Arbol");
    assert.deepEqual(asked, ["a.Arbol"]);
  });

  test("un servidor que describe ficheros sin fin se corta en 500", async () => {
    let served = 0;
    const target = await reflectionServer((request, call) => {
      if (request.list_services !== undefined)
        return call.write({ list_services_response: { service: [{ name: "s.Uno" }] } });
      served += 1;
      // Cada fichero depende de uno nuevo: nunca deja de faltar alguno.
      call.write({
        file_descriptor_response: {
          file_descriptor_proto: [fileBytes({ name: `f${served}.proto`, dependency: [`f${served + 1}.proto`] })],
        },
      });
    });
    await assert.rejects(
      transport.reflect(target),
      (error: unknown) =>
        error instanceof ReflectionError && error.message === "El servidor describe más de 500 ficheros",
    );
    assert.equal(served, 500);
  });

  test("un servidor que se cae justo tras contestar: la pregunta siguiente falla con su motivo sin quedarse colgada", async () => {
    const target = await reflectionServer((request, call) => {
      if (request.list_services === undefined) return;
      call.write({ list_services_response: { service: [{ name: "a.Arbol" }, { name: "b.Otro" }] } });
      call.emit("error", { code: grpcStatus.INTERNAL, details: "se cayó" });
    });
    await assert.rejects(
      transport.reflect(target),
      (error: unknown) => error instanceof ReflectionError && error.message === "La reflexión falló: se cayó",
    );
  });
});

describe("la reflexión que falla", () => {
  test("solo v1alpha, y esa falla: el fallo es el de v1alpha, no un «no implementado»", async () => {
    const target = await reflectionServer(
      (_request, call) => call.emit("error", { code: grpcStatus.PERMISSION_DENIED, details: "sin permiso" }),
      "v1alpha",
    );
    await assert.rejects(
      transport.reflect(target),
      (error: unknown) => error instanceof ReflectionError && error.message === "La reflexión falló: sin permiso",
    );
  });

  test("un descriptor que no se puede leer: el motivo es el del lector, que no trae detalle de gRPC", async () => {
    const target = await reflectionServer((request, call) =>
      call.write(
        request.list_services !== undefined
          ? { list_services_response: { service: [{ name: "a.Arbol" }] } }
          : { file_descriptor_response: { file_descriptor_proto: [Buffer.from([0x0f])] } },
      ),
    );
    await assert.rejects(
      transport.reflect(target),
      (error: unknown) =>
        error instanceof ReflectionError && /^La reflexión falló: index out of range/.test(error.message),
    );
  });
});

describe("un método que el servidor no tiene", () => {
  test("un stream de servidor contra un servidor sin ese servicio cierra con UNIMPLEMENTED, sin tumbar nada", async () => {
    const target = await reflectionServer(() => undefined);
    const schema = schemaFromFiles(SHOP_FILES);
    const closed: [number, string][] = [];
    let done: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => (done = resolve));
    await transport.call(
      target,
      {
        method: schema.method("demo.v1.Shop", "Watch")!,
        request: { text: "{}", value: {} },
        deadlineMs: null,
        decode: (text) => JSON.parse(text) as object,
      },
      {
        onMessage: () => undefined,
        onClose: (code, reason) => {
          closed.push([code, reason]);
          done();
        },
        onError: () => undefined,
      },
    );
    await finished;
    assert.equal(closed[0][0], grpcStatus.UNIMPLEMENTED);
  });
});
