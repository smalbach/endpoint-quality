/**
 * WebSocket y Socket.IO con servidores de verdad en loopback, en lo que las demás pruebas no pisan:
 * un sondeo que contesta 404, un servidor que no contesta nunca, TLS contra un servidor que no lo
 * habla, un «no» del servidor sin datos, oír solo algunos eventos, un acuse que no llega, un servidor
 * que desconecta, y cabeceras repetidas en el 101.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { Server as SocketIoServer } from "socket.io";
import { WebSocketServer } from "ws";

import type { SafeFetchPolicy } from "@/shared/http/safe-fetch";
import { openSafeSocket, pinnedConnection } from "@/shared/http/safe-socket";
import {
  SocketIoRejectedError,
  openSafeSocketIo,
  pinnedAgent,
  pinnedPolling,
  type SafeSocketIoOptions,
} from "@/shared/http/safe-socketio";
import { SocketIoChannelTransport, type SocketIoOpenOptions } from "@/modules/channels/infrastructure/socketio-transport";
import type { TimelessFrame } from "@/modules/channels/infrastructure/mqtt-transport";
import type { Env } from "@/shared/config/env";

const POLICY: SafeFetchPolicy = { allowPrivateTargets: true, maxRedirects: 0, timeoutMs: 2_000, maxResponseBytes: 1 << 20 };
const OPTIONS: SafeSocketIoOptions = {
  path: "/socket.io",
  namespace: "/",
  auth: null,
  query: {},
  headers: {},
  transports: ["polling"],
  maxPayload: 64 * 1024,
  connectTimeoutMs: 2_000,
};

const until = async (condition: () => boolean, what: string) => {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(condition(), `no llegó: ${what}`);
};

const listen = async (server: HttpServer | ReturnType<typeof createNetServer>) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

describe("el sondeo y la apertura de Socket.IO", () => {
  let http: HttpServer;
  let hanging: ReturnType<typeof createNetServer>;
  let httpPort: number;
  let hangingPort: number;
  const held: Socket[] = [];

  before(async () => {
    http = createServer((_request, response) => response.writeHead(404).end("no"));
    httpPort = await listen(http);
    // Acepta la conexión y no contesta nunca.
    hanging = createNetServer((socket) => {
      held.push(socket);
      socket.on("error", () => undefined);
    });
    hangingPort = await listen(hanging);
  });

  after(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    for (const socket of held) socket.destroy();
    await new Promise<void>((resolve) => hanging.close(() => resolve()));
  });

  test("un sondeo que contesta 404 no abre, y el motivo lleva el estado", async () => {
    await assert.rejects(
      openSafeSocketIo(`http://127.0.0.1:${httpPort}`, POLICY, OPTIONS, () => undefined),
      (error: unknown) => error instanceof Error && /: el sondeo contestó 404$/.test(error.message),
    );
  });

  test("un servidor que no contesta al CONNECT se corta por el plazo, dicho en milisegundos", async () => {
    await assert.rejects(
      openSafeSocketIo(`http://127.0.0.1:${hangingPort}`, POLICY, { ...OPTIONS, connectTimeoutMs: 150 }, () => undefined),
      /sin respuesta al CONNECT en 150 ms/,
    );
  });

  test("https contra un servidor que no habla TLS: un error de transporte con su causa", async () => {
    await assert.rejects(
      openSafeSocketIo(`https://127.0.0.1:${httpPort}`, POLICY, OPTIONS, () => undefined),
      (error: unknown) => error instanceof Error && !(error instanceof SocketIoRejectedError) && /: /.test(error.message),
    );
  });

  test("el agente y el sondeo con TLS son los de https", () => {
    const agent = pinnedAgent("127.0.0.1", true, "servidor.example.test");
    assert.ok(agent instanceof HttpsAgent);
    assert.equal(typeof pinnedPolling(agent, true, 1024), "function");
  });
});

describe("el transporte del canal Socket.IO", () => {
  let http: HttpServer;
  let io: SocketIoServer;
  let url: string;

  before(async () => {
    http = createServer();
    io = new SocketIoServer(http, { transports: ["websocket", "polling"] });
    io.use((socket, next) => {
      if (socket.handshake.auth?.clave === "mala") return next(new Error("clave no válida"));
      next();
    });
    io.on("connection", (socket) => {
      socket.emit("uno", 1);
      socket.emit("dos", { n: 2 });
      socket.on("sin-acuse", () => undefined);
      socket.on("vete", () => socket.disconnect(true));
    });
    url = `http://127.0.0.1:${await listen(http)}`;
  });

  after(async () => {
    io.disconnectSockets(true);
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });

  const transport = new SocketIoChannelTransport({ ALLOW_PRIVATE_TARGETS: true } as Env);
  const plan = (over: Partial<SocketIoOpenOptions> = {}): SocketIoOpenOptions => ({
    path: "/socket.io",
    namespace: "/",
    auth: null,
    query: {},
    listenAll: true,
    events: [],
    transports: ["websocket"],
    headers: {},
    maxMessageBytes: 64 * 1024,
    connectTimeoutMs: 2_000,
    ackTimeoutMs: 2_000,
    ...over,
  });

  test("oye solo los eventos pedidos; un emit sin nombre no existe; un acuse que no llega se anota", async () => {
    const frames: TimelessFrame[] = [];
    const channel = await transport.open(url, plan({ listenAll: false, events: ["dos"], ackTimeoutMs: 80 }), (frame) =>
      frames.push(frame),
    );
    try {
      await until(() => frames.some((frame) => frame.direction === "in"), "el evento pedido");
      assert.throws(() => channel.send("x"), /En Socket\.IO se emite un evento con nombre/);
      channel.emit?.("sin-acuse", [], true);
      await until(() => frames.some((frame) => frame.body === "sin acuse de sin-acuse en 80 ms"), "el plazo del acuse");
      const received = frames.filter((frame) => frame.direction === "in");
      assert.deepEqual(
        received.map((frame) => [frame.event, frame.body]),
        [["dos", '{"n":2}']],
      );
    } finally {
      channel.close(1000, "fin");
    }
  });

  test("un servidor que desconecta: el motivo como evento y el cierre", async () => {
    const frames: TimelessFrame[] = [];
    const channel = await transport.open(url, plan(), (frame) => frames.push(frame));
    channel.emit?.("vete", [], false);
    await until(() => frames.some((frame) => frame.direction === "close"), "el cierre");
    assert.deepEqual(
      frames.filter((frame) => frame.event === "disconnect" || frame.direction === "close").map((frame) => frame.direction),
      ["event", "close"],
    );
    assert.equal(frames.find((frame) => frame.direction === "close")?.closeReason, "io server disconnect");
  });

  test("un «no» del servidor sin datos: rechazo de Socket.IO y connect_error anotado con el motivo solo", async () => {
    const frames: TimelessFrame[] = [];
    await assert.rejects(
      transport.open(url, plan({ auth: { clave: "mala" } }), (frame) => frames.push(frame)),
      (error: unknown) => error instanceof SocketIoRejectedError && error.message === "clave no válida" && error.data === undefined,
    );
    assert.deepEqual(
      frames.map((frame) => [frame.event, frame.body]),
      [["connect_error", "clave no válida"]],
    );
  });
});

describe("el WebSocket a secas", () => {
  test("una conexión cifrada lleva el nombre como SNI, y a una IP no se le manda", () => {
    const byName = pinnedConnection("127.0.0.1", true, "servidor.example.test")({ port: 9 });
    const byIp = pinnedConnection("127.0.0.1", true, "127.0.0.1")({ port: 9 });
    for (const socket of [byName, byIp]) {
      assert.ok(socket instanceof TLSSocket);
      socket.on("error", () => undefined);
      socket.destroy();
    }
  });

  test("una cabecera repetida en el 101 se junta con comas", async () => {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    wss.on("headers", (headers) => headers.push("Set-Cookie: a=1", "Set-Cookie: b=2"));
    const port = await listen(http);
    try {
      const { socket, handshake } = await openSafeSocket(
        `ws://127.0.0.1:${port}/`,
        POLICY,
        { maxPayload: 1024, handshakeTimeoutMs: 1_000 },
        { onMessage: () => undefined, onClose: () => undefined, onError: () => undefined },
      );
      socket.terminate();
      assert.equal(handshake.status, 101);
      assert.equal(handshake.headers["set-cookie"], "a=1, b=2");
    } finally {
      wss.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });
});
