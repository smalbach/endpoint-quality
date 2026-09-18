/**
 * Un servidor gRPC de verdad, en el mismo proceso: las cuatro formas de llamada, un error con su
 * estado, uno que no contesta nunca y —si se pide— la reflexión.
 *
 * De verdad y no guionizado porque lo que se prueba es justo lo que un doble no tiene: HTTP/2, los
 * trailers, el plazo que viaja como `grpc-timeout`, y la conexión que la guarda fija a una IP.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Metadata,
  Server,
  ServerCredentials,
  loadPackageDefinition,
  status,
  type GrpcObject,
  type ServiceClientConstructor,
  type ServerDuplexStream,
  type ServerReadableStream,
  type ServerUnaryCall,
  type ServerWritableStream,
  type sendUnaryData,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { ReflectionService } from "@grpc/reflection";

export const SHOP_PROTO = `syntax = "proto3";
package demo.v1;

import "google/protobuf/timestamp.proto";
import "common/money.proto";

service Shop {
  rpc GetItem(GetItemRequest) returns (Item) {
    option idempotency_level = NO_SIDE_EFFECTS;
  }
  rpc Buy(GetItemRequest) returns (Item);
  rpc Watch(GetItemRequest) returns (stream Item);
  rpc Upload(stream Item) returns (Summary);
  rpc Chat(stream Item) returns (stream Item);
  rpc Slow(GetItemRequest) returns (Item);
}

message GetItemRequest {
  string item_id = 1;
  int32 count = 2;
  google.protobuf.Timestamp at = 3;
}

message Item {
  string name = 1;
  common.Money price = 2;
}

message Summary {
  int32 received = 1;
}
`;

export const MONEY_PROTO = `syntax = "proto3";
package common;

message Money {
  int64 units = 1;
  string currency = 2;
}
`;

/** Los ficheros como los sube alguien: con una carpeta raíz que los `import` no nombran. */
export const SHOP_FILES = [
  { path: "protos/demo/v1/shop.proto", content: SHOP_PROTO },
  { path: "protos/common/money.proto", content: MONEY_PROTO },
];

type Item = { name: string; price?: { units: string | number; currency: string } };
type Request = { item_id: string; count: number };

export type GrpcTestServer = {
  port: number;
  /** La metadata que recibió cada llamada, para comprobar que la credencial llegó. */
  received: Record<string, string>[];
  close(): Promise<void>;
};

export async function startGrpcServer(
  options: { reflection?: boolean; credentials?: ServerCredentials; host?: string } = {},
): Promise<GrpcTestServer> {
  // proto-loader lee de disco, que es lo que necesita la reflexión para sus descriptores.
  const directory = mkdtempSync(join(tmpdir(), "eq-grpc-"));
  mkdirSync(join(directory, "demo/v1"), { recursive: true });
  mkdirSync(join(directory, "common"), { recursive: true });
  writeFileSync(join(directory, "demo/v1/shop.proto"), SHOP_PROTO);
  writeFileSync(join(directory, "common/money.proto"), MONEY_PROTO);
  const definition = loadSync("demo/v1/shop.proto", { includeDirs: [directory], keepCase: true, longs: String });
  const loaded = loadPackageDefinition(definition) as GrpcObject;
  const Shop = ((loaded.demo as GrpcObject).v1 as GrpcObject).Shop as ServiceClientConstructor;

  const received: Record<string, string>[] = [];
  // Lo binario (`-bin`) en base64, que es como se escribe en el canal.
  const remember = (metadata: Metadata) =>
    received.push(
      Object.fromEntries(
        Object.entries(metadata.getMap()).map(([key, value]) => [
          key,
          Buffer.isBuffer(value) ? value.toString("base64") : String(value),
        ]),
      ),
    );
  const price = { units: 5, currency: "EUR" };

  const server = new Server();
  server.addService(Shop.service, {
    GetItem: (call: ServerUnaryCall<Request, Item>, callback: sendUnaryData<Item>) => {
      remember(call.metadata);
      if (call.request.item_id === "missing") {
        callback({ code: status.NOT_FOUND, details: `no existe ${call.request.item_id}` });
        return;
      }
      const headers = new Metadata();
      headers.set("x-server", "demo");
      call.sendMetadata(headers);
      const trailers = new Metadata();
      trailers.set("x-session-token", "abc-del-servidor");
      trailers.set("x-region", "eu");
      // Metadata binaria de vuelta: la `-bin` que llegó, tal cual; y lo que llegó en `x-eco`, en
      // bytes —un servidor que devuelve la credencial que recibió, pero en binario—.
      const trace = call.metadata.get("x-trace-bin")[0];
      if (Buffer.isBuffer(trace)) trailers.set("x-trace-bin", trace);
      const echo = call.metadata.get("x-eco")[0];
      if (echo !== undefined) {
        trailers.set("x-eco-bin", Buffer.from(String(echo)));
        trailers.set("x-api-key-bin", Buffer.from("clave-binaria-del-servidor"));
      }
      callback(null, { name: `item ${call.request.item_id}`, price }, trailers);
    },
    Buy: (call: ServerUnaryCall<Request, Item>, callback: sendUnaryData<Item>) => {
      remember(call.metadata);
      callback(null, { name: `comprado ${call.request.item_id}`, price });
    },
    Watch: (call: ServerWritableStream<Request, Item>) => {
      remember(call.metadata);
      for (let index = 1; index <= 3; index += 1) call.write({ name: `${call.request.item_id}-${index}` });
      call.end();
    },
    Upload: (call: ServerReadableStream<Item, { received: number }>, callback: sendUnaryData<{ received: number }>) => {
      let count = 0;
      call.on("data", () => (count += 1));
      call.on("end", () => callback(null, { received: count }));
    },
    Chat: (call: ServerDuplexStream<Item, Item>) => {
      call.on("data", (item: Item) => call.write({ name: `eco ${item.name}` }));
      call.on("end", () => call.end());
    },
    Slow: () => {
      // No contesta: el plazo es lo único que la termina.
    },
  });
  if (options.reflection) new ReflectionService(definition).addToServer(server);

  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      `${options.host ?? "127.0.0.1"}:0`,
      options.credentials ?? ServerCredentials.createInsecure(),
      (error, bound) => (error ? reject(error) : resolve(bound)),
    ),
  );
  return {
    port,
    received,
    // A la fuerza: `Slow` deja llamadas abiertas a propósito, y un cierre amable las esperaría.
    close: async () => server.forceShutdown(),
  };
}
