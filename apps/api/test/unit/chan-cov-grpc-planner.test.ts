/**
 * El que prepara una llamada gRPC, con un transporte que solo anota: todo lo que se rechaza antes de
 * conectar (sin método, sin `.proto`, un `.proto` roto, un mensaje que no es JSON o no encaja, una
 * variable sin valor, metadata binaria que no es base64, un método con efectos en un entorno sin
 * escrituras) y lo que se decide ya conectado cuando la definición viene de la reflexión.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { GrpcSessionPlanner, storedSchema, type GrpcPlanContext } from "@/modules/channels/application/grpc";
import { DEFAULT_GRPC_SETTINGS, type GrpcSettings } from "@/modules/channels/domain/grpc";
import { schemaFromFiles, type GrpcSchema } from "@/modules/channels/domain/grpc-schema";
import { DEFAULT_LIMITS, blankChannel, type Channel } from "@/modules/channels/domain/model";
import type {
  GrpcCall,
  GrpcCallFromSchema,
  GrpcTarget,
  GrpcTransportPort,
} from "@/modules/channels/infrastructure/grpc-transport";
import type { ChannelListeners, OpenChannel } from "@/modules/channels/infrastructure/ws-transport";
import { loadEnv } from "@/shared/config/env";
import { ConflictError, DomainError, InvalidInputError } from "@/shared/errors/domain-error";
import { InMemoryChannelProtoRepository } from "../support/in-memory-protos";
import { TEST_ENV } from "../support/test-app";

const PROTO = `
  syntax = "proto3";
  package tienda.v1;
  message Pedido { string id = 1; int32 unidades = 2; }
  message Recibo { string id = 1; }
  service Caja {
    rpc Consultar (Pedido) returns (Recibo) { option idempotency_level = NO_SIDE_EFFECTS; }
    rpc Cobrar (Pedido) returns (Recibo);
    rpc Subir (stream Pedido) returns (Recibo);
  }
`;
const FILES = [{ path: "caja.proto", content: PROTO }];

class RecordingTransport implements GrpcTransportPort {
  readonly calls: { target: GrpcTarget; call: GrpcCall }[] = [];
  constructor(private readonly reflected: GrpcSchema = schemaFromFiles(FILES)) {}
  async reflect(): Promise<GrpcSchema> {
    return this.reflected;
  }
  async call(target: GrpcTarget, call: GrpcCall | GrpcCallFromSchema, _listeners: ChannelListeners): Promise<OpenChannel> {
    const resolved = typeof call === "function" ? call(this.reflected) : call;
    this.calls.push({ target, call: resolved });
    return { send: () => {}, close: () => {} };
  }
}

const env = loadEnv({ ...TEST_ENV });
const listeners = {} as ChannelListeners;

function channel(grpc: Partial<GrpcSettings>): Channel {
  const blank = blankChannel({
    id: `canal-${Math.random().toString(36).slice(2, 8)}`,
    projectId: "p",
    name: "caja",
    url: "grpc://caja.example.test:50051",
    now: new Date(),
    by: "persona",
    protocol: "grpc",
  });
  return { ...blank, grpc: { ...DEFAULT_GRPC_SETTINGS, ...grpc } };
}

const context = (over: Partial<GrpcPlanContext> = {}): GrpcPlanContext => ({
  url: "grpc://caja.example.test:50051",
  headers: {},
  interpolate: (text) => text.replace("{{id}}", "P-1"),
  limits: DEFAULT_LIMITS,
  readOnly: false,
  environmentName: "Staging",
  ...over,
});

async function setup(files = FILES) {
  const protos = new InMemoryChannelProtoRepository();
  const transport = new RecordingTransport();
  const planner = new GrpcSessionPlanner(transport, protos, env);
  const save = async (value: Channel) => {
    await protos.replace(value.id, files);
    return value;
  };
  return { protos, transport, planner, save };
}

async function refused(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DomainError, String(error));
    return error;
  }
  assert.fail("no falló");
}

describe("los .proto guardados", () => {
  test("sin ficheros, o con unos que ya no se leen, es un 422 que lo dice", async () => {
    const protos = new InMemoryChannelProtoRepository();
    const none = await refused(storedSchema(protos, "vacio"));
    assert.deepEqual(none.fields, [
      { field: "grpc.source", detail: "Sube los .proto del servicio o usa la reflexión del servidor" },
    ]);
    await protos.replace("roto", [{ path: "roto.proto", content: "message {" }]);
    const broken = await refused(storedSchema(protos, "roto"));
    assert.ok(broken instanceof InvalidInputError);
    assert.equal(broken.fields[0].field, "files");
    assert.match(broken.message, /roto\.proto/);
  });
});

describe("preparar una llamada con .proto", () => {
  test("sin servicio o sin método no hay nada que invocar", async () => {
    const { planner } = await setup();
    for (const settings of [{ service: "", method: "Cobrar" }, { service: "tienda.v1.Caja", method: "" }]) {
      const error = await refused(planner.prepare(channel(settings), context()));
      assert.deepEqual(error.fields, [{ field: "grpc.method", detail: "Elige el servicio y el método que se invocan" }]);
    }
  });

  test("un método que ya no está en la definición", async () => {
    const { planner, save } = await setup();
    const error = await refused(planner.prepare(await save(channel({ service: "tienda.v1.Caja", method: "Borrar" })), context()));
    assert.equal(error.message, "tienda.v1.Caja/Borrar no está en la definición");
  });

  test("el mensaje: variables sin valor, no JSON, no un objeto, o campos que el tipo no tiene", async () => {
    const { planner, save } = await setup();
    const cases: [string, (error: DomainError) => void][] = [
      [
        '{"id":"{{falta}}"}',
        (error) => {
          assert.equal(error.code, "unresolved-variables");
          assert.deepEqual(error.fields, [{ field: "grpc.message", detail: "{{falta}} no tiene valor en el entorno" }]);
        },
      ],
      ["{roto", (error) => assert.match(error.message, /^El mensaje no es JSON: /)],
      ["[1]", (error) => assert.deepEqual(error.fields, [{ field: "grpc.message", detail: "Un objeto JSON: {…}" }])],
      ['{"itemId":1}', (error) => assert.deepEqual(error.fields, [
        { field: "grpc.message", detail: "tienda.v1.Pedido no tiene el campo itemId" },
      ])],
    ];
    for (const [message, check] of cases) {
      check(await refused(planner.prepare(await save(channel({ service: "tienda.v1.Caja", method: "Cobrar", message })), context())));
    }
  });

  test("un entorno sin escrituras solo deja invocar lo declarado sin efectos", async () => {
    const { planner, save, transport } = await setup();
    const cobrar = await save(channel({ service: "tienda.v1.Caja", method: "Cobrar", message: '{"id":"{{id}}"}' }));
    const error = await refused(planner.prepare(cobrar, context({ readOnly: true })));
    assert.ok(error instanceof ConflictError);
    assert.equal(error.code, "writes-not-allowed");
    assert.match(error.message, /«Staging» no permite escrituras, y tienda\.v1\.Caja\/Cobrar/);

    const consultar = await save(channel({ service: "tienda.v1.Caja", method: "Consultar", message: '{"id":"{{id}}"}', deadlineMs: 900 }));
    const open = await planner.prepare(consultar, context({ readOnly: true, headers: { "x-trace-bin": "AQID" } }));
    await open(listeners);
    const [{ target, call }] = transport.calls;
    assert.deepEqual(call.request, { text: '{"id":"P-1"}', value: { id: "P-1" } });
    assert.equal(call.deadlineMs, 900);
    assert.deepEqual(target.metadata, { "x-trace-bin": "AQID" });
    assert.equal(target.connectTimeoutMs, Math.min(DEFAULT_LIMITS.maxDurationMs, env.REQUEST_TIMEOUT_MS));
    // Cada mensaje del stream se comprueba contra el tipo al mandarlo.
    assert.deepEqual(call.decode('{"unidades": 2}'), { unidades: 2 });
    assert.throws(() => call.decode('{"otro": 1}'), (thrown: unknown) =>
      thrown instanceof InvalidInputError && thrown.fields[0].field === "text");
  });

  test("un stream de cliente no manda nada al invocar: una variable del mensaje no impide abrir", async () => {
    const { planner, save, transport } = await setup();
    const subir = await save(channel({ service: "tienda.v1.Caja", method: "Subir", message: '{"id":"{{nadie}}"}' }));
    await (await planner.prepare(subir, context()))(listeners);
    assert.equal(transport.calls[0].call.request, null);
  });

  test("metadata binaria que ya resuelta no es base64 se dice antes de conectar, con su clave", async () => {
    const { planner, save } = await setup();
    const error = await refused(
      planner.prepare(
        await save(channel({ service: "tienda.v1.Caja", method: "Consultar" })),
        context({ headers: { "x-firma-bin": "no es base64!", "x-ok": "v" } }),
      ),
    );
    assert.equal(error.message, "La metadata binaria no es base64");
    assert.deepEqual(error.fields, [
      { field: "headers", detail: "x-firma-bin: Una clave -bin lleva bytes: escribe el valor en base64" },
    ]);
  });
});

describe("preparar una llamada con reflexión", () => {
  test("el método se resuelve con lo que contesta el servidor, dentro de la llamada", async () => {
    const { planner, transport } = await setup();
    const open = await planner.prepare(
      channel({ source: "reflection", service: "tienda.v1.Caja", method: "Consultar", message: "" }),
      context(),
    );
    assert.equal(transport.calls.length, 0);
    await open(listeners);
    assert.equal(transport.calls[0].call.method.service, "tienda.v1.Caja");
    // Un mensaje vacío es `{}`.
    assert.deepEqual(transport.calls[0].call.request?.value, {});
  });

  test("y lo que falle ya conectado sale de la apertura con su motivo", async () => {
    const { planner } = await setup();
    const open = await planner.prepare(
      channel({ source: "reflection", service: "tienda.v1.Caja", method: "Cobrar", message: "{}" }),
      context({ readOnly: true }),
    );
    await assert.rejects(open(listeners), (error: unknown) => error instanceof ConflictError && error.code === "writes-not-allowed");
  });

  test("reflejar a secas pasa por la misma comprobación de la metadata", async () => {
    const { planner } = await setup();
    const schema = await planner.reflect({ url: "grpc://x:1", headers: {}, limits: DEFAULT_LIMITS });
    assert.deepEqual(schema.services().map((service) => service.name), ["tienda.v1.Caja"]);
    assert.throws(
      () => planner.reflect({ url: "grpc://x:1", headers: { "a-bin": "%%%" }, limits: DEFAULT_LIMITS }),
      InvalidInputError,
    );
  });
});
