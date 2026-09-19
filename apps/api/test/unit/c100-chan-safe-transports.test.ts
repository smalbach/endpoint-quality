/**
 * Las guardas de salida (`safe-fetch`, `safe-socketio`, `safe-mqtt`) en lo que las demás pruebas no
 * pisan, contra servidores de verdad en loopback: una respuesta pedida en bytes, un `fetch` que falla
 * sin causa, las dos formas del `lookup` fijado; un servidor Socket.IO que corta antes del `CONNECT`
 * (la promesa se quedaba colgada para siempre), un WebSocket rechazado en el upgrade y un sondeo cuya
 * escritura falla; y un broker MQTT que desconecta sin código, antes del `CONNACK`, concede un
 * `SUBACK` vacío o manda propiedades que no se enseñan, más la contrapresión del tope de paquete.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import * as mqttPacket from "mqtt-packet";
import { Server as SocketIoServer } from "socket.io";

import { BlockedTargetError, pinnedLookup, safeFetch, type SafeFetchPolicy } from "@/shared/http/safe-fetch";
import { openSafeSocketIo, SocketIoRejectedError, type SafeSocketIoOptions } from "@/shared/http/safe-socketio";
import {
  guardedStream,
  openSafeMqtt,
  subscribeMqtt,
  type MqttDelivery,
  type SafeMqttOptions,
} from "@/shared/http/safe-mqtt";
import { SocketIoChannelTransport } from "@/modules/channels/infrastructure/socketio-transport";
import { MqttChannelTransport, type TimelessFrame } from "@/modules/channels/infrastructure/mqtt-transport";
import type { Env } from "@/shared/config/env";

const POLICY: SafeFetchPolicy = {
  allowPrivateTargets: true,
  maxRedirects: 2,
  timeoutMs: 2_000,
  maxResponseBytes: 1 << 20,
};

const listen = async (server: HttpServer | Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

const until = async (condition: () => boolean, what: string) => {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(condition(), `no llegó: ${what}`);
};

// ---------------------------------------------------------------------------------------------

describe("safeFetch", () => {
  const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80]);
  let server: HttpServer;
  let origin: string;
  before(async () => {
    server = createHttpServer((_request, response) =>
      response.writeHead(200, { "content-type": "application/zip" }).end(ZIP),
    );
    origin = `http://127.0.0.1:${await listen(server)}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test("pedida en bytes, la respuesta trae los bytes tal cual y el cuerpo de texto vacío", async () => {
    const raw = await safeFetch(`${origin}/a.zip`, POLICY, { responseAs: "bytes" });
    assert.equal(raw.status, 200);
    assert.equal(raw.body, "");
    assert.deepEqual(Buffer.from(raw.bytes!), ZIP);

    // Sin pedirlo, texto y ningún `bytes`: no se guarda la respuesta dos veces.
    const text = await safeFetch(`${origin}/a.zip`, POLICY);
    assert.equal("bytes" in text, false);
    assert.equal(text.body, new TextDecoder().decode(ZIP));
  });

  test("un fallo de fetch sin causa se dice con su propio mensaje, sin nada colgando detrás", async () => {
    await assert.rejects(
      safeFetch(`${origin}/a.zip`, POLICY, { headers: { "x-rota": "a\nb" } }),
      (error: unknown) =>
        error instanceof BlockedTargetError &&
        /está bloqueado: .*invalid header value/is.test(error.message) &&
        !/undefined/.test(error.message),
    );
  });

  test("el lookup fijado contesta la dirección comprobada, pida la lista entera o una sola", () => {
    const lookup = pinnedLookup("203.0.113.7", 4);
    const answers: unknown[][] = [];
    lookup("otro.example.test", { all: true }, (...args: unknown[]) => answers.push(args));
    lookup("otro.example.test", {}, (...args: unknown[]) => answers.push(args));
    assert.deepEqual(answers, [
      [null, [{ address: "203.0.113.7", family: 4 }]],
      [null, "203.0.113.7", 4],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

const IO_OPTIONS: SafeSocketIoOptions = {
  path: "/socket.io",
  namespace: "/",
  auth: null,
  query: {},
  headers: {},
  transports: ["websocket"],
  maxPayload: 64 * 1024,
  connectTimeoutMs: 2_000,
};

describe("Socket.IO: lo que no es un CONNECT aceptado", () => {
  let http: HttpServer;
  let io: SocketIoServer;
  let url: string;
  before(async () => {
    http = createHttpServer();
    io = new SocketIoServer(http, { transports: ["websocket", "polling"] });
    // Ni acepta ni rechaza: corta Engine.IO a medio `CONNECT`.
    io.use((socket) => setTimeout(() => socket.conn.close(), 20));
    url = `http://127.0.0.1:${await listen(http)}`;
  });
  after(async () => {
    io.disconnectSockets(true);
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });

  test("un servidor que corta antes de aceptar el CONNECT: se rechaza con el motivo, no se cuelga", async () => {
    const started = Date.now();
    await assert.rejects(
      openSafeSocketIo(url, POLICY, { ...IO_OPTIONS, connectTimeoutMs: 5_000 }, () => undefined),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof SocketIoRejectedError) &&
        /^el servidor cerró la conexión antes de aceptar el CONNECT: /.test(error.message),
    );
    // Mucho antes del plazo: lo decide el corte, no el reloj.
    assert.ok(Date.now() - started < 2_000);
  });

  test("y el transporte del canal no anota un cierre de una sesión que nunca abrió", async () => {
    const transport = new SocketIoChannelTransport({ ALLOW_PRIVATE_TARGETS: true } as Env);
    const frames: TimelessFrame[] = [];
    await assert.rejects(
      transport.open(
        url,
        {
          path: "/socket.io",
          namespace: "/",
          auth: null,
          query: {},
          listenAll: true,
          events: [],
          transports: ["websocket"],
          headers: {},
          maxMessageBytes: 1024,
          connectTimeoutMs: 5_000,
          ackTimeoutMs: 1_000,
        },
        (frame) => frames.push(frame),
      ),
      /antes de aceptar el CONNECT/,
    );
    assert.deepEqual(frames, []);
  });
});

describe("Socket.IO: errores de transporte", () => {
  let http: HttpServer;
  let port: number;
  let polls = 0;
  before(async () => {
    // Un Engine.IO a mano: el handshake del sondeo sale bien, los sondeos se quedan esperando y cada
    // escritura (el `CONNECT` que manda el cliente) contesta 500. Y un upgrade siempre rechazado.
    http = createHttpServer((request, response) => {
      if (request.method === "POST") {
        request.resume();
        response.writeHead(500).end("no");
        return;
      }
      polls += 1;
      if (polls === 1) {
        response
          .writeHead(200, { "content-type": "text/plain" })
          .end('0{"sid":"s1","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
      }
      // Los demás sondeos no se contestan.
    });
    http.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"));
    port = await listen(http);
  });
  after(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  test("un WebSocket rechazado en el upgrade: el error del transporte, sin una causa inventada", async () => {
    await assert.rejects(
      openSafeSocketIo(`ws://127.0.0.1:${port}`, POLICY, IO_OPTIONS, () => undefined),
      (error: unknown) => error instanceof Error && error.message === "websocket error",
    );
  });

  test("un sondeo cuya escritura contesta 500: el error de escritura con el estado", async () => {
    await assert.rejects(
      openSafeSocketIo(`http://127.0.0.1:${port}`, POLICY, { ...IO_OPTIONS, transports: ["polling"] }, () => undefined),
      (error: unknown) => error instanceof Error && error.message === "polling write error: el sondeo contestó 500",
    );
  });
});

// ---------------------------------------------------------------------------------------------

type Send = (packet: mqttPacket.Packet) => void;
type Script = (packet: mqttPacket.Packet, send: Send, socket: Socket) => void;

const brokers: Server[] = [];
after(async () => {
  for (const server of brokers) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Un broker que contesta lo que diga el guion, en 5.0 si no se dice otra versión. */
async function broker(script: Script, version: 4 | 5 = 5): Promise<number> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const parser = mqttPacket.parser({ protocolVersion: version });
    const send: Send = (packet) => {
      if (!socket.destroyed) socket.write(mqttPacket.generate(packet, { protocolVersion: version }));
    };
    parser.on("packet", (packet: mqttPacket.Packet) => {
      if (packet.cmd === "pingreq") return send({ cmd: "pingresp" });
      if (packet.cmd === "disconnect") return void socket.end();
      script(packet, send, socket);
    });
    socket.on("data", (chunk) => parser.parse(chunk));
  });
  brokers.push(server);
  const close = server.close.bind(server);
  server.close = (callback) => {
    for (const socket of sockets) socket.destroy();
    return close(callback);
  };
  return listen(server);
}

const connack = (packet: mqttPacket.Packet, send: Send) => {
  if (packet.cmd === "connect") send({ cmd: "connack", sessionPresent: false, reasonCode: 0, returnCode: 0 });
};

const mqttOptions = (over: Partial<SafeMqttOptions> = {}): SafeMqttOptions => ({
  protocolVersion: 5,
  clientId: `c100-${Math.random().toString(36).slice(2, 8)}`,
  keepaliveSec: 30,
  clean: true,
  subscriptions: [],
  maxPacketBytes: 64 * 1024,
  connectTimeoutMs: 2_000,
  ...over,
});

function sink() {
  const delivered: MqttDelivery[] = [];
  const closed: [string, number | undefined][] = [];
  return {
    delivered,
    closed,
    listeners: {
      onMessage: (delivery: MqttDelivery) => delivered.push(delivery),
      onClose: (reason: string, code?: number) => closed.push([reason, code]),
      onError: () => undefined,
    },
  };
}

describe("MQTT contra un broker escrito a mano", () => {
  test("un DISCONNECT sin código (un broker 3.1.1 que lo manda, aunque no le toca) es el código 0", async () => {
    const port = await broker((packet, send, socket) => {
      if (packet.cmd !== "connect") return;
      connack(packet, send);
      setTimeout(() => {
        // En 3.1.1 un DISCONNECT no lleva código: el paquete llega sin `reasonCode`.
        send({ cmd: "disconnect" });
        socket.end();
      }, 20);
    }, 4);
    const events = sink();
    await openSafeMqtt(`mqtt://127.0.0.1:${port}`, POLICY, mqttOptions({ protocolVersion: 4 }), events.listeners);
    await until(() => events.closed.length === 1, "el cierre");
    assert.deepEqual(events.closed, [["el broker desconectó: 0 (código 0x0)", 0]]);
  });

  test("un DISCONNECT antes del CONNACK: no abre, y el motivo es el del broker", async () => {
    const port = await broker((packet, send, socket) => {
      if (packet.cmd !== "connect") return;
      send({ cmd: "disconnect", reasonCode: 0x89 });
      socket.end();
    });
    await assert.rejects(
      openSafeMqtt(`mqtt://127.0.0.1:${port}`, POLICY, mqttOptions(), sink().listeners),
      (error: unknown) => error instanceof Error && error.message === "el broker desconectó: 137 (servidor ocupado)",
    );
  });

  test("un SUBACK sin códigos no se toma por concedido: es un error de protocolo", async () => {
    const port = await broker((packet, send, socket) => {
      connack(packet, send);
      // A mano: `mqtt-packet` no genera un SUBACK sin códigos. Tipo 0x90, id del paquete y
      // propiedades vacías.
      const id = packet.messageId ?? 0;
      if (packet.cmd === "subscribe") socket.write(Buffer.from([0x90, 0x03, id >> 8, id & 0xff, 0x00]));
    });
    const { client } = await openSafeMqtt(`mqtt://127.0.0.1:${port}`, POLICY, mqttOptions(), sink().listeners);
    try {
      await assert.rejects(
        subscribeMqtt(client, "casa/#", 2, 1_000),
        /suback granted 0 reason code\(s\) for 1 subscription/,
      );
    } finally {
      client.end(true);
    }
  });

  test("un mensaje con propiedades de transporte y ninguna de las que se enseñan llega sin propiedades", async () => {
    const port = await broker((packet, send) => {
      if (packet.cmd !== "connect") return;
      connack(packet, send);
      send({
        cmd: "publish",
        topic: "casa/luz",
        payload: Buffer.from("on"),
        qos: 0,
        retain: false,
        dup: false,
        properties: { messageExpiryInterval: 60, payloadFormatIndicator: true },
      });
    });
    const events = sink();
    const { client } = await openSafeMqtt(`mqtt://127.0.0.1:${port}`, POLICY, mqttOptions(), events.listeners);
    try {
      await until(() => events.delivered.length === 1, "el mensaje");
      assert.equal(events.delivered[0].topic, "casa/luz");
      assert.equal("properties" in events.delivered[0], false);
    } finally {
      client.end(true);
    }
  });
});

describe("el transporte MQTT del canal", () => {
  test("un cuerpo UTF-8 válido con caracteres de control se anota como binario, en hexadecimal", async () => {
    const port = await broker((packet, send) => {
      if (packet.cmd !== "connect") return;
      connack(packet, send);
      for (const payload of [Buffer.from([0x61, 0x01, 0x62]), Buffer.from([0x61, 0x1b, 0x62]), Buffer.from("a\tb\n")])
        send({ cmd: "publish", topic: "t", payload, qos: 0, retain: false, dup: false });
    });
    const frames: TimelessFrame[] = [];
    const channel = await new MqttChannelTransport({ ALLOW_PRIVATE_TARGETS: true } as Env).open(
      `mqtt://127.0.0.1:${port}`,
      {
        version: 5,
        clientId: "c100-texto",
        keepaliveSec: 30,
        cleanSession: true,
        subscriptions: [],
        maxMessageBytes: 1024,
        connectTimeoutMs: 2_000,
      },
      (frame) => frames.push(frame),
    );
    try {
      const received = () => frames.filter((frame) => frame.direction === "in");
      await until(() => received().length === 3, "los tres mensajes");
      assert.deepEqual(
        received().map((frame) => [frame.kind, frame.body]),
        [
          ["binary", "610162"],
          ["binary", "611b62"],
          ["text", "a\tb\n"],
        ],
      );
    } finally {
      channel.close(1000, "fin");
    }
  });
});

describe("MQTT: lo que llega detrás de un no", () => {
  const both = (first: mqttPacket.Packet, second: mqttPacket.Packet) =>
    Buffer.concat([
      mqttPacket.generate(first, { protocolVersion: 5 }),
      mqttPacket.generate(second, { protocolVersion: 5 }),
    ]);

  test("un mensaje que viaja pegado a un CONNACK que rechaza no se entrega: la sesión no abrió", async () => {
    const port = await broker((packet, _send, socket) => {
      if (packet.cmd === "connect")
        socket.write(
          both(
            { cmd: "connack", sessionPresent: false, reasonCode: 0x87 },
            { cmd: "publish", topic: "alarmas/1", payload: Buffer.from("fuego"), qos: 0, retain: true, dup: false },
          ),
        );
    });
    const events = sink();
    await assert.rejects(
      openSafeMqtt(`mqtt://127.0.0.1:${port}`, POLICY, mqttOptions(), events.listeners),
      /CONNACK 135 \(no autorizado\)/,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(events.delivered, []);
  });

  test("un CONNACK bueno detrás de uno que rechaza no abre la sesión", async () => {
    const port = await broker((packet, _send, socket) => {
      if (packet.cmd === "connect")
        socket.write(
          both(
            { cmd: "connack", sessionPresent: false, reasonCode: 0x86 },
            { cmd: "connack", sessionPresent: false, reasonCode: 0 },
          ),
        );
    });
    let opened = 0;
    await assert.rejects(
      openSafeMqtt(`mqtt://127.0.0.1:${port}`, POLICY, mqttOptions(), {
        ...sink().listeners,
        onOpen: () => (opened += 1),
      }),
      /CONNACK 134/,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(opened, 0);
  });
});

describe("el tope de paquete y la contrapresión", () => {
  test("si nadie lee, el socket de dentro se pausa; al leer, se reanuda y no se pierde nada", async () => {
    const inner = new PassThrough();
    const outer = guardedStream(inner, 1 << 20);
    // Un PUBLISH de 200 KB, en trozos: más de lo que el lado de fuera guarda sin que nadie lea (su
    // `highWaterMark`, 64 KB en este Node).
    const packet = mqttPacket.generate({
      cmd: "publish",
      topic: "t",
      payload: Buffer.alloc(200 * 1024, 97),
      qos: 0,
      retain: false,
      dup: false,
    });
    for (let at = 0; at < packet.length; at += 4096) inner.write(packet.subarray(at, at + 4096));
    await until(() => inner.isPaused(), "la pausa");

    const received: Buffer[] = [];
    outer.on("data", (chunk: Buffer) => received.push(chunk));
    await until(() => Buffer.concat(received).length === packet.length, "todo el paquete");
    assert.deepEqual(Buffer.concat(received), packet);
    assert.equal(inner.isPaused(), false);
    outer.destroy();
  });
});
