/**
 * El transporte gRPC solo: la guarda de red, el TLS contra el nombre, y el esquema sin red.
 *
 * La guarda es la prueba que importa: con `ALLOW_PRIVATE_TARGETS=false` una dirección privada no se
 * llama —ni por IP ni por un nombre que resuelve a ella—, y el servidor no recibe nada. Y el TLS,
 * porque fijar la IP es justo lo que rompió HTTPS en `safe-fetch.ts`: aquí el certificado se valida
 * contra el nombre de la URL mientras la conexión va a la IP comprobada.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { ServerCredentials } from "@grpc/grpc-js";

import { loadEnv } from "@/shared/config/env";
import { BlockedTargetError } from "@/shared/http/safe-fetch";
import { GrpcChannelTransport, pinnedClient, type GrpcCall } from "@/modules/channels/infrastructure/grpc-transport";
import { exampleOf, messageProblem, schemaFromFiles } from "@/modules/channels/domain/grpc-schema";
import type { ChannelListeners } from "@/modules/channels/infrastructure/ws-transport";
import { SHOP_FILES, startGrpcServer, type GrpcTestServer } from "../support/grpc-server";
import { TEST_ENV } from "../support/test-app";

const policy = (allowPrivateTargets: boolean) => ({
  allowPrivateTargets,
  maxRedirects: 0,
  timeoutMs: 2_000,
  maxResponseBytes: 1024 * 1024,
});

const schema = schemaFromFiles(SHOP_FILES);
const getItem = schema.method("demo.v1.Shop", "GetItem")!;
const call: GrpcCall = {
  method: getItem,
  request: { text: '{"item_id":"1"}', value: { item_id: "1" } },
  deadlineMs: 2_000,
  decode: (text) => JSON.parse(text) as object,
};

/** Las escuchas, apuntadas: cómo terminó la llamada y qué llegó. */
function recorder() {
  const events: string[] = [];
  let done: (value: { code: number; reason: string }) => void = () => undefined;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => (done = resolve));
  const listeners: ChannelListeners = {
    onOpen: (handshake) => events.push(handshake ? "metadata" : "open"),
    onSent: () => events.push("out"),
    onMessage: (data) => events.push(`in ${data.toString()}`),
    onClose: (code, reason) => {
      events.push(`close ${code}`);
      done({ code, reason });
    },
    onError: (error) => events.push(`error ${error.message}`),
  };
  return { events, closed, listeners };
}

describe("la guarda de red, con ALLOW_PRIVATE_TARGETS=false", () => {
  let server: GrpcTestServer;
  before(async () => (server = await startGrpcServer()));
  after(() => server.close());

  test("una IP privada no se llama, y el servidor no recibe nada", async () => {
    const env = { ...loadEnv(TEST_ENV), ALLOW_PRIVATE_TARGETS: false };
    const transport = new GrpcChannelTransport(env);
    const target = {
      url: `grpc://127.0.0.1:${server.port}`,
      metadata: {},
      connectTimeoutMs: 1_000,
      maxMessageBytes: 65_536,
    };
    const before = server.received.length;
    await assert.rejects(transport.call(target, call, recorder().listeners), (error: unknown) => {
      assert.ok(error instanceof BlockedTargetError);
      assert.match(error.message, /loopback \(127\.0\.0\.1\)/);
      return true;
    });
    await assert.rejects(transport.reflect(target), BlockedTargetError);
    assert.equal(server.received.length, before);
  });

  test("tampoco por un nombre que resuelve a ella, ni la de metadatos de la nube, ni otro esquema", async () => {
    await assert.rejects(pinnedClient("grpc://localhost:50051", policy(false), 1024), /loopback/);
    await assert.rejects(pinnedClient("grpcs://169.254.169.254", policy(false), 1024), /link-local/);
    await assert.rejects(pinnedClient("grpc://[::ffff:10.0.0.5]:80", policy(false), 1024), /red privada/);
    await assert.rejects(pinnedClient("https://example.com", policy(false), 1024), /esquema https: no permitido/);
  });

  test("con la guarda abierta, la misma llamada sale: la conversación entera, en orden", async () => {
    const transport = new GrpcChannelTransport({ ...loadEnv(TEST_ENV), ALLOW_PRIVATE_TARGETS: true });
    const { events, closed, listeners } = recorder();
    await transport.call(
      {
        url: `grpc://127.0.0.1:${server.port}`,
        metadata: { "x-tenant": "acme" },
        connectTimeoutMs: 1_000,
        maxMessageBytes: 65_536,
      },
      call,
      listeners,
    );
    assert.equal((await closed).code, 0);
    assert.deepEqual(events.slice(0, 3), ["open", "out", "metadata"]);
    assert.equal(events.at(-1), "close 0");
    assert.equal(server.received.at(-1)?.["x-tenant"], "acme");
  });
});

describe("contra un servidor gRPC con TLS y un certificado para un nombre", () => {
  let server: GrpcTestServer;
  const defaults = getCACertificates("default");

  function fixture(name: string): string {
    let directory = __dirname;
    while (!existsSync(resolve(directory, "test/fixtures/tls", name))) directory = resolve(directory, "..");
    return readFileSync(resolve(directory, "test/fixtures/tls", name), "utf8");
  }

  before(async () => {
    setDefaultCACertificates([...defaults, fixture("ca.pem")]);
    const { address } = await lookup("localhost");
    server = await startGrpcServer({
      host: address.includes(":") ? `[${address}]` : address,
      credentials: ServerCredentials.createSsl(null, [
        { cert_chain: Buffer.from(fixture("localhost.pem")), private_key: Buffer.from(fixture("localhost.key")) },
      ]),
    });
  });

  after(async () => {
    setDefaultCACertificates(defaults);
    await server.close();
  });

  const transport = new GrpcChannelTransport({ ...loadEnv(TEST_ENV), ALLOW_PRIVATE_TARGETS: true });

  test("el certificado se valida contra el nombre, y la conexión va a la IP comprobada", async () => {
    const { closed, listeners } = recorder();
    await transport.call(
      { url: `grpcs://localhost:${server.port}`, metadata: {}, connectTimeoutMs: 2_000, maxMessageBytes: 65_536 },
      call,
      listeners,
    );
    assert.equal((await closed).code, 0);
  });

  test("la verificación sigue puesta: por la IP, que el certificado no nombra, no se abre", async () => {
    const { address, family } = await lookup("localhost");
    const literal = family === 6 ? `[${address}]` : address;
    await assert.rejects(
      transport.call(
        { url: `grpcs://${literal}:${server.port}`, metadata: {}, connectTimeoutMs: 2_000, maxMessageBytes: 65_536 },
        call,
        recorder().listeners,
      ),
      /certificate|altnames|IP/i,
    );
  });
});

describe("el esquema, sin red", () => {
  test("un import que casa con dos ficheros subidos se dice, en vez de elegir uno", () => {
    assert.throws(
      () =>
        schemaFromFiles([
          ...SHOP_FILES,
          { path: "otra/common/money.proto", content: SHOP_FILES[1].content.replace("common", "otra") },
        ]),
      /casa con más de un fichero/,
    );
  });

  test("un mensaje con un campo que el tipo no tiene no se manda vacío", () => {
    assert.equal(messageProblem(getItem.requestType, { item_id: "1", count: 3 }), null);
    assert.match(messageProblem(getItem.requestType, { itemId: "1" }) ?? "", /no tiene el campo itemId/);
    assert.match(messageProblem(getItem.requestType, { at: { secs: 1 } }) ?? "", /at\.secs/);
  });

  test("el ejemplo de un tipo que se contiene a sí mismo no es infinito, y de un oneof sale uno", () => {
    const tree = schemaFromFiles([
      {
        path: "arbol.proto",
        content: `syntax = "proto3"; package t;
          message Nodo { string nombre = 1; repeated Nodo hijos = 2; oneof valor { string texto = 3; int64 numero = 4; }
            map<string, int32> etiquetas = 5; optional bool activo = 6; }
          service Arbol { rpc Ver(Nodo) returns (Nodo); }`,
      },
    ]);
    const type = tree.method("t.Arbol", "Ver")!.requestType;
    assert.deepEqual(exampleOf(type), { nombre: "", texto: "", etiquetas: { clave: 0 }, activo: false });
  });
});
