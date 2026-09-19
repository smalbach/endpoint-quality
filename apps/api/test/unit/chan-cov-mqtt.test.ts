/**
 * MQTT con un broker 5.0 escrito paquete a paquete: lo que un broker de verdad hace pocas veces y
 * la sesión tiene que contar bien —una sesión previa, un DISCONNECT con motivo, propiedades
 * repetidas, un PUBACK con error, un SUBACK o un UNSUBACK que no llega, un no en la baja— y el
 * transporte del canal por encima (lo binario en hexadecimal, publicar sin tema).
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as mqttPacket from "mqtt-packet";

import {
  MqttRejectedError,
  openSafeMqtt,
  pinnedBrokerStream,
  refusalText,
  subscribeMqtt,
  unsubscribeMqtt,
  userPropertyPairs,
  userPropertyRecord,
  type MqttDelivery,
  type SafeMqttOptions,
} from "@/shared/http/safe-mqtt";
import type { SafeFetchPolicy } from "@/shared/http/safe-fetch";
import type { Env } from "@/shared/config/env";
import { MqttChannelTransport, shownProperties, type TimelessFrame } from "@/modules/channels/infrastructure/mqtt-transport";

const policy: SafeFetchPolicy = { allowPrivateTargets: true, maxRedirects: 0, timeoutMs: 5_000, maxResponseBytes: 1 << 20 };

type Send = (packet: mqttPacket.Packet) => void;
type Script = (packet: mqttPacket.Packet, send: Send, socket: Socket) => void;

const servers: { close(): Promise<void> }[] = [];
after(async () => {
  for (const server of servers) await server.close();
});

/** Un broker que contesta lo que diga el guion, y el `CONNACK` de siempre si el guion no lo hace. */
async function broker(script: Script, version: 4 | 5 = 5): Promise<number> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
  return (server.address() as AddressInfo).port;
}

const accept = (packet: mqttPacket.Packet, send: Send, sessionPresent = false) => {
  if (packet.cmd === "connect") send({ cmd: "connack", sessionPresent, reasonCode: 0, returnCode: 0 } as mqttPacket.Packet);
};

const options = (over: Partial<SafeMqttOptions> = {}): SafeMqttOptions => ({
  protocolVersion: 5,
  clientId: `cov-${Math.random().toString(36).slice(2, 8)}`,
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
  const errors: Error[] = [];
  return {
    delivered,
    closed,
    errors,
    listeners: {
      onMessage: (delivery: MqttDelivery) => delivered.push(delivery),
      onClose: (reason: string, code?: number) => closed.push([reason, code]),
      onError: (error: Error) => errors.push(error),
    },
  };
}

const until = async (condition: () => boolean, what: string) => {
  for (let attempt = 0; attempt < 150 && !condition(); attempt += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(condition(), `no llegó: ${what}`);
};

describe("los pares de propiedades de usuario", () => {
  test("un nombre repetido viaja como lista y vuelve como pares, sin perder ninguno", () => {
    const record = userPropertyRecord([
      { name: "a", value: "1" },
      { name: "a", value: "2" },
      { name: "a", value: "3" },
      { name: "b", value: "x" },
    ]);
    assert.deepEqual(record, { a: ["1", "2", "3"], b: "x" });
    assert.deepEqual(userPropertyPairs(record), [
      ["a", "1"],
      ["a", "2"],
      ["a", "3"],
      ["b", "x"],
    ]);
    assert.deepEqual(userPropertyPairs(undefined), []);
  });

  test("un código que no está en la tabla se dice en hexadecimal", () => {
    assert.equal(refusalText(0x42), "66 (código 0x42)");
    assert.equal(refusalText(0x97), "151 (cuota superada)");
  });

  test("unos datos de correlación binarios se enseñan en hexadecimal, y sin ellos no se añade nada", () => {
    assert.deepEqual(shownProperties({ correlationData: Buffer.from([0, 1, 255]), contentType: "x" }), {
      contentType: "x",
      correlationData: "0001ff",
      correlationEncoding: "hex",
    });
    assert.deepEqual(shownProperties({ responseTopic: "r" }), { responseTopic: "r" });
  });
});

describe("un broker 5.0 con guion", () => {
  test("sesión previa, propiedades de un mensaje, y un DISCONNECT del broker con su motivo", async () => {
    const port = await broker((packet, send, socket) => {
      if (packet.cmd !== "connect") return;
      send({ cmd: "connack", sessionPresent: true, reasonCode: 0 });
      send({
        cmd: "publish",
        topic: "casa/luz",
        payload: Buffer.from("on"),
        qos: 0,
        retain: true,
        dup: false,
        properties: {
          userProperties: { origen: ["a", "b"], sala: "cocina" },
          contentType: "text/plain",
          responseTopic: "casa/respuesta",
          correlationData: Buffer.from("id-1"),
        },
      });
      setTimeout(() => {
        send({ cmd: "disconnect", reasonCode: 0x8e });
        socket.end();
      }, 30);
    });
    const events = sink();
    let opened: { headers: Record<string, string> } | null = null;
    const { handshake } = await openSafeMqtt(`mqtt://127.0.0.1:${port}`, policy, options(), {
      ...events.listeners,
      onOpen: (value) => (opened = value),
    });
    assert.equal(handshake.headers["sesión previa"], "sí");
    assert.equal(handshake.headers.protocolo, "MQTT 5.0");
    assert.deepEqual(opened, handshake);
    await until(() => events.closed.length === 1, "el cierre");
    assert.equal(events.delivered.length, 1);
    assert.deepEqual(events.delivered[0].properties, {
      userProperties: [
        ["origen", "a"],
        ["origen", "b"],
        ["sala", "cocina"],
      ],
      contentType: "text/plain",
      responseTopic: "casa/respuesta",
      correlationData: Buffer.from("id-1"),
    });
    assert.equal(events.delivered[0].retain, true);
    assert.deepEqual(events.closed, [["el broker desconectó: 142 (otra conexión tomó la sesión)", 0x8e]]);
  });

  test("un SUBACK con más códigos que temas nombra el que no sabe como «?»", async () => {
    const port = await broker((packet, send) => {
      accept(packet, send);
      if (packet.cmd === "subscribe") send({ cmd: "suback", messageId: packet.messageId, granted: [0, 0x80] });
    });
    await assert.rejects(
      openSafeMqtt(`mqtt://127.0.0.1:${port}`, policy, options({ subscriptions: [{ topic: "a", qos: 0 }] }), sink().listeners),
      (error: unknown) => error instanceof MqttRejectedError && /suscripción a \?: 128/.test(error.message),
    );
  });

  test("un broker que corta antes de confirmar la suscripción: no abre, y lo dice", async () => {
    const port = await broker((packet, send, socket) => {
      accept(packet, send);
      if (packet.cmd === "subscribe") socket.destroy();
    });
    await assert.rejects(
      openSafeMqtt(`mqtt://127.0.0.1:${port}`, policy, options({ subscriptions: [{ topic: "a", qos: 1 }] }), sink().listeners),
      /el broker cerró la conexión antes de confirmarla|closed|ECONNRESET/,
    );
  });

  test("con la sesión abierta: un SUBACK o un UNSUBACK que no llegan se cortan por el plazo, y un no en la baja se dice", async () => {
    let unsubscribes = 0;
    const port = await broker((packet, send) => {
      accept(packet, send);
      if (packet.cmd === "unsubscribe") {
        unsubscribes += 1;
        if (unsubscribes === 2) send({ cmd: "unsuback", messageId: packet.messageId, granted: [0x87] } as mqttPacket.Packet);
      }
      // Los SUBACK no llegan nunca.
    });
    const { client } = await openSafeMqtt(`mqtt://127.0.0.1:${port}`, policy, options(), sink().listeners);
    try {
      await assert.rejects(subscribeMqtt(client, "a", 1, 80), /el broker no confirmó la suscripción en 80 ms/);
      await assert.rejects(unsubscribeMqtt(client, "a", 80), /el broker no confirmó la baja en 80 ms/);
      await assert.rejects(unsubscribeMqtt(client, "b", 1_000), (error: unknown) => error instanceof Error);
    } finally {
      client.end(true);
    }
  });

  test("MQTT sobre WebSocket: un upgrade que no es un 101 se dice con su número", async () => {
    const http = createHttpServer((_request, response) => response.writeHead(404).end());
    http.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    servers.push({ close: () => new Promise<void>((resolve) => http.close(() => resolve())) });
    const port = (http.address() as AddressInfo).port;
    await assert.rejects(
      openSafeMqtt(`ws://127.0.0.1:${port}/mqtt`, policy, options(), sink().listeners),
      (error: unknown) =>
        error instanceof Error && error.message === "el upgrade contestó 404" && (error as { code?: string }).code === "EQ_MQTT_UPGRADE",
    );
  });

  test("sin puerto en la URL, cada esquema va al suyo", async () => {
    const stream = pinnedBrokerStream(new URL("mqtt://127.0.0.1"), "127.0.0.1", {
      maxPacketBytes: 1024,
      connectTimeoutMs: 100,
    }) as Socket;
    const port = await new Promise<number>((resolve) => {
      stream.once("connect", () => resolve(stream.remotePort ?? 0));
      stream.once("error", (error: Error & { port?: number }) => resolve(error.port ?? 0));
    });
    stream.destroy();
    assert.equal(port, 1883);
  });
});

describe("el transporte del canal sobre el broker con guion", () => {
  const transport = new MqttChannelTransport({ ALLOW_PRIVATE_TARGETS: true } as Env);
  const plan = {
    version: 5 as const,
    clientId: "cov-canal",
    keepaliveSec: 30,
    cleanSession: true,
    subscriptions: [],
    maxMessageBytes: 1024,
    connectTimeoutMs: 2_000,
  };

  test("un cuerpo binario se anota en hexadecimal; un PUBACK con error se cuenta; publicar sin tema no existe", async () => {
    const port = await broker((packet, send) => {
      accept(packet, send);
      if (packet.cmd === "connect")
        send({ cmd: "publish", topic: "bin", payload: Buffer.from([0, 159, 146, 150]), qos: 0, retain: false, dup: false });
      if (packet.cmd === "publish" && packet.qos === 1)
        send({ cmd: "puback", messageId: packet.messageId, reasonCode: 0x87 } as mqttPacket.Packet);
    });
    const frames: TimelessFrame[] = [];
    const channel = await transport.open(`mqtt://127.0.0.1:${port}`, plan, (frame) => frames.push(frame));
    try {
      await until(() => frames.some((frame) => frame.direction === "in"), "el binario");
      const received = frames.find((frame) => frame.direction === "in")!;
      assert.deepEqual([received.kind, received.body, received.bytes, received.topic], ["binary", "009f9296", 4, "bin"]);

      assert.throws(() => channel.send("x"), /En MQTT se publica en un tema/);
      channel.send("hola", { topic: "t", qos: 1, retain: false, userProperties: [{ name: "a", value: "1" }] });
      await until(() => frames.some((frame) => frame.direction === "error"), "el error del PUBACK");
      assert.match(frames.find((frame) => frame.direction === "error")!.body ?? "", /^no se pudo publicar: /);
    } finally {
      channel.close(1000, "fin");
    }
  });

  test("un paquete mayor que el tope con la sesión abierta es un error de la sesión, no de la apertura", async () => {
    const port = await broker((packet, send) => {
      accept(packet, send);
      if (packet.cmd === "connect")
        setTimeout(
          () => send({ cmd: "publish", topic: "grande", payload: Buffer.alloc(8 * 1024, 97), qos: 0, retain: false, dup: false }),
          20,
        );
    });
    const frames: TimelessFrame[] = [];
    const channel = await transport.open(`mqtt://127.0.0.1:${port}`, { ...plan, maxMessageBytes: 16 }, (frame) =>
      frames.push(frame),
    );
    await until(() => frames.some((frame) => frame.direction === "close"), "el cierre");
    const error = frames.find((frame) => frame.direction === "error");
    assert.match(error?.body ?? "", /anunció un paquete de \d+ bytes, y el tope es/);
    assert.equal(frames.some((frame) => frame.direction === "in"), false);
    channel.close(1000, "fin");
  });
});
