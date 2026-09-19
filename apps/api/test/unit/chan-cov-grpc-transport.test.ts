/**
 * El transporte gRPC y la reflexión, contra servidores de verdad en loopback: lo que un método no
 * admite (mandar a una unaria, terminar dos veces un stream, mandar después de terminar), una
 * conexión que nunca está lista, y un servidor de reflexión escrito a mano que contesta lo que un
 * servidor de verdad contesta pocas veces —solo la versión v1alpha, un error en la lista o en un
 * fichero, un error de permisos, dependencias repetidas—.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { Server, ServerCredentials, status as grpcStatus, type ServerDuplexStream } from "@grpc/grpc-js";
import { fromJSON } from "@grpc/proto-loader";
import * as protobuf from "protobufjs";
import * as descriptor from "protobufjs/ext/descriptor";

import { loadEnv } from "@/shared/config/env";
import { ConflictError } from "@/shared/errors/domain-error";
import { schemaFromFiles } from "@/modules/channels/domain/grpc-schema";
import { GrpcChannelTransport, type GrpcCall, type GrpcTarget } from "@/modules/channels/infrastructure/grpc-transport";
import { ReflectionError } from "@/modules/channels/infrastructure/grpc-reflection";
import type { ChannelListeners } from "@/modules/channels/infrastructure/ws-transport";
import { SHOP_FILES, startGrpcServer, type GrpcTestServer } from "../support/grpc-server";
import { TEST_ENV } from "../support/test-app";

const transport = new GrpcChannelTransport({ ...loadEnv(TEST_ENV), ALLOW_PRIVATE_TARGETS: true });
const schema = schemaFromFiles(SHOP_FILES);
const callOf = (method: string, request: GrpcCall["request"]): GrpcCall => ({
  method: schema.method("demo.v1.Shop", method)!,
  request,
  deadlineMs: null,
  decode: (text) => JSON.parse(text) as object,
});

function recorder() {
  const events: string[] = [];
  let done: (code: number) => void = () => undefined;
  const closed = new Promise<number>((resolve) => (done = resolve));
  const listeners: ChannelListeners = {
    onOpen: () => undefined,
    onSent: () => events.push("out"),
    onEvent: (text) => events.push(`event ${text}`),
    onMessage: (data) => events.push(`in ${data.toString()}`),
    onClose: (code) => {
      events.push(`close ${code}`);
      done(code);
    },
    onError: (error) => events.push(`error ${error.message}`),
  };
  return { events, closed, listeners };
}

describe("lo que un método gRPC admite", () => {
  let server: GrpcTestServer;
  let target: GrpcTarget;
  before(async () => {
    server = await startGrpcServer();
    target = { url: `grpc://127.0.0.1:${server.port}`, metadata: {}, connectTimeoutMs: 2_000, maxMessageBytes: 65_536 };
  });
  after(() => server.close());

  test("una unaria no recibe mensajes ni tiene envío que terminar; sin petición, viaja la vacía", async () => {
    const { events, closed, listeners } = recorder();
    const channel = await transport.call(target, callOf("GetItem", null), listeners);
    for (const action of [() => channel.check?.("{}"), () => channel.end?.()])
      assert.throws(action, (error: unknown) => error instanceof ConflictError && error.code === "grpc-not-client-streaming");
    assert.equal(await closed, 0);
    // El servidor de prueba lee `item_id` sin valores por omisión: un mensaje vacío le llega sin él.
    assert.ok(events.some((event) => event.startsWith('in {"name":"item undefined"')), JSON.stringify(events));
    assert.ok(!events.includes("out"));
  });

  test("un stream de servidor sin petición manda la vacía y recibe sus mensajes", async () => {
    const { events, closed, listeners } = recorder();
    await transport.call(target, callOf("Watch", null), listeners);
    assert.equal(await closed, 0);
    assert.deepEqual(
      events.filter((event) => event.startsWith("in ")).map((event) => JSON.parse(event.slice(3)).name),
      ["undefined-1", "undefined-2", "undefined-3"],
    );
  });

  test("un stream de cliente se termina una vez; después no se manda nada más", async () => {
    const { events, closed, listeners } = recorder();
    const channel = await transport.call(target, callOf("Upload", null), listeners);
    channel.check?.('{"name":"a"}');
    channel.send('{"name":"a"}');
    channel.end?.();
    channel.end?.();
    assert.throws(
      () => channel.check?.('{"name":"b"}'),
      (error: unknown) => error instanceof ConflictError && error.code === "grpc-stream-ended",
    );
    assert.equal(await closed, 0);
    assert.equal(events.filter((event) => event.startsWith("event ")).length, 1);
    assert.ok(events.includes('in {"received":1}'));
  });
});

describe("una conexión que nunca está lista", () => {
  const held: Socket[] = [];
  const silent = createNetServer((socket) => {
    held.push(socket);
    socket.on("error", () => undefined);
  });
  let port: number;
  before(async () => {
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    port = (silent.address() as AddressInfo).port;
  });
  after(async () => {
    for (const socket of held) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });

  test("se corta por el plazo de conexión, dicho en milisegundos", async () => {
    await assert.rejects(
      transport.call(
        { url: `grpc://127.0.0.1:${port}`, metadata: {}, connectTimeoutMs: 150, maxMessageBytes: 65_536 },
        callOf("Slow", { text: "{}", value: {} }),
        recorder().listeners,
      ),
      /la conexión no estuvo lista en 150 ms/,
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

/** `a.proto` depende de `b.proto`; los dos, como bytes de `FileDescriptorProto`. */
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
  messageType: [{ name: "Pedido", field: [{ name: "hoja", number: 1, label: 1, type: 11, typeName: ".b.Hoja", jsonName: "hoja" }] }],
  service: [{ name: "Arbol", method: [{ name: "Ver", inputType: ".a.Pedido", outputType: ".b.Hoja" }] }],
});

const reflectionServers: Server[] = [];
after(() => {
  for (const server of reflectionServers) server.forceShutdown();
});

async function reflectionServer(answers: { v1?: Answer; v1alpha?: Answer }): Promise<GrpcTarget> {
  const server = new Server();
  for (const [version, answer] of Object.entries(answers)) {
    if (!answer) continue;
    server.addService(reflectionService(`grpc.reflection.${version}`), {
      ServerReflectionInfo: (call: ServerDuplexStream<Request, object>) => {
        call.on("data", (request: Request) => answer(request, call));
        call.on("end", () => call.end());
      },
    });
  }
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, bound) =>
      error ? reject(error) : resolve(bound),
    ),
  );
  reflectionServers.push(server);
  return { url: `grpc://127.0.0.1:${port}`, metadata: {}, connectTimeoutMs: 2_000, maxMessageBytes: 1 << 20 };
}

/** Un servidor bien educado: lista, y cada fichero con sus dependencias, alguna repetida. */
const wellBehaved: Answer = (request, call) => {
  if (request.list_services !== undefined)
    call.write({ list_services_response: { service: [{ name: "a.Arbol" }, { name: "grpc.reflection.v1alpha.ServerReflection" }] } });
  else if (request.file_containing_symbol)
    // El mismo fichero dos veces, y la dependencia pedida después dos veces: se leen una.
    call.write({ file_descriptor_response: { file_descriptor_proto: [FILE_A, FILE_A] } });
  else if (request.file_by_filename === "b.proto")
    call.write({ file_descriptor_response: { file_descriptor_proto: [FILE_B, FILE_A] } });
};

describe("la reflexión contra un servidor escrito a mano", () => {
  test("solo v1alpha: se pregunta a v1, no está, y se usa la otra; las dependencias se leen una vez", async () => {
    const reflected = await transport.reflect(await reflectionServer({ v1alpha: wellBehaved }));
    const [service] = reflected.services();
    assert.equal(service.name, "a.Arbol");
    assert.deepEqual(service.methods.map((method) => [method.name, method.requestType, method.responseType]), [
      ["Ver", "a.Pedido", "b.Hoja"],
    ]);
    assert.deepEqual(JSON.parse(service.methods[0].example), { hoja: { id: "" } });
  });

  test("un error en la lista, o en un fichero, se dice con el texto del servidor", async () => {
    const listError = await reflectionServer({
      v1: (_request, call) => call.write({ error_response: { error_code: 5, error_message: "no hay lista" } }),
    });
    await assert.rejects(transport.reflect(listError), (error: unknown) =>
      error instanceof ReflectionError && error.message === "no hay lista");

    const fileError = await reflectionServer({
      v1: (request, call) =>
        request.list_services !== undefined
          ? call.write({ list_services_response: { service: [{ name: "a.Arbol" }] } })
          : call.write({ error_response: { error_code: 5, error_message: "fichero perdido" } }),
    });
    await assert.rejects(transport.reflect(fileError), (error: unknown) =>
      error instanceof ReflectionError && error.message === "fichero perdido");
  });

  test("un error que no es «no implementado» es un fallo de la reflexión, con el detalle del servidor", async () => {
    const denied = await reflectionServer({
      v1: (_request, call) => call.emit("error", { code: grpcStatus.PERMISSION_DENIED, details: "sin permiso" }),
    });
    await assert.rejects(transport.reflect(denied), (error: unknown) =>
      error instanceof ReflectionError && error.message === "La reflexión falló: sin permiso");
  });

  test("un servidor que corta tras la lista: lo que se preguntaba después falla con su motivo", async () => {
    const cut = await reflectionServer({
      v1: (request, call) => {
        if (request.list_services === undefined) return;
        call.write({ list_services_response: { service: [{ name: "a.Arbol" }] } });
        call.emit("error", { code: grpcStatus.INTERNAL, details: "se cayó" });
      },
    });
    await assert.rejects(transport.reflect(cut), (error: unknown) =>
      error instanceof ReflectionError && error.message === "La reflexión falló: se cayó");
  });

  test("una sesión con reflexión que falla antes de invocar cierra el cliente y lo dice", async () => {
    const listError = await reflectionServer({
      v1: (_request, call) => call.write({ error_response: { error_code: 5, error_message: "sin lista" } }),
    });
    await assert.rejects(
      transport.call(listError, () => callOf("GetItem", null), recorder().listeners),
      (error: unknown) => error instanceof ReflectionError && error.message === "sin lista",
    );
  });
});
