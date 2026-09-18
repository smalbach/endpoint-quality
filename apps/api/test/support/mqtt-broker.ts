/**
 * Brokers MQTT de verdad, en proceso y en loopback, para las pruebas.
 *
 * `aedes` para 3.1.1 —con usuario, contraseña y permisos de suscripción de verdad—, y uno mínimo
 * escrito con `mqtt-packet` para 5.0, que `aedes` no habla. Los dos hablan bytes reales por un
 * socket real: es lo que prueba que el `CONNACK`, el `SUBACK` y el tope de paquete funcionan fuera
 * de un guion.
 */
import { createServer, type Server, type Socket } from "node:net";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createBroker, type Client } from "aedes";
import * as mqttPacket from "mqtt-packet";
import WebSocket, { WebSocketServer } from "ws";

export const BROKER_USER = "sensor";

export type TestBroker = {
  port: number;
  /** Publica desde el propio broker, como lo haría otro cliente. */
  publish(topic: string, payload: string, retain?: boolean): Promise<void>;
  close(): Promise<void>;
  /** Solo el de 5.0: los `CONNECT` que recibió, para mirar el testamento y las propiedades. */
  connects?: mqttPacket.IConnectPacket[];
};

type BrokerOptions = {
  /** La contraseña que acepta. Sin ella, acepta a cualquiera. */
  password?: string;
  /** Los temas que niega al suscribirse (el SUBACK sale con 0x80). */
  forbidden?: string;
  host?: string;
  tls?: { cert: string; key: string };
  /** MQTT sobre WebSocket en vez de TCP. */
  websocket?: boolean;
};

export async function startAedes(options: BrokerOptions = {}): Promise<TestBroker> {
  const broker = createBroker({
    authenticate: (_client: Client, username, password, done) => {
      if (options.password === undefined) return done(null, true);
      if (username === BROKER_USER && password?.toString() === options.password) return done(null, true);
      done(Object.assign(new Error("credenciales"), { returnCode: 4 }), null);
    },
    authorizeSubscribe: (_client, subscription, done) =>
      done(null, options.forbidden && subscription.topic.startsWith(options.forbidden) ? null : subscription),
  });

  let server: Server | TlsServer | HttpServer;
  const sockets = new Set<Socket>();
  if (options.websocket) {
    const http = createHttpServer();
    const wss = new WebSocketServer({ server: http });
    server = http;
    wss.on("connection", (socket) => broker.handle(WebSocket.createWebSocketStream(socket) as never));
  } else if (options.tls) {
    server = createTlsServer(options.tls, (socket) => broker.handle(socket));
  } else {
    server = createServer((socket) => broker.handle(socket));
  }
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, options.host ?? "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    publish: (topic, payload, retain = false) =>
      new Promise((resolve, reject) =>
        broker.publish({ cmd: "publish", topic, payload: Buffer.from(payload), qos: 0, retain, dup: false }, (error) =>
          error ? reject(error) : resolve(),
        ),
      ),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => broker.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Un broker 5.0 mínimo: contesta el `CONNACK` (0, o 0x86 si la contraseña no es la suya), confirma
 * las suscripciones, devuelve cada `PUBLISH` a quien lo mandó y, si se le pide, manda un paquete del
 * tamaño que se diga —para probar el tope—.
 */
export async function startMqtt5(
  options: { password?: string; oversized?: number; forbidden?: string } = {},
): Promise<TestBroker> {
  const sockets = new Set<Socket>();
  const connects: mqttPacket.IConnectPacket[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const parser = mqttPacket.parser({ protocolVersion: 5 });
    const send = (packet: mqttPacket.Packet) => socket.write(mqttPacket.generate(packet, { protocolVersion: 5 }));
    parser.on("packet", (packet: mqttPacket.Packet) => {
      if (packet.cmd === "connect") {
        connects.push(packet);
        const ok = options.password === undefined || packet.password?.toString() === options.password;
        send({ cmd: "connack", sessionPresent: false, reasonCode: ok ? 0 : 0x86 });
        if (!ok) socket.end();
        else if (options.oversized) {
          send({
            cmd: "publish",
            topic: "grande",
            payload: Buffer.alloc(options.oversized, 97),
            qos: 0,
            retain: false,
            dup: false,
          });
        }
      } else if (packet.cmd === "subscribe") {
        // 0x87 («no autorizado») para lo prohibido: el no de un broker 5.0 con permisos.
        const granted = packet.subscriptions.map((s) =>
          options.forbidden && s.topic.startsWith(options.forbidden) ? 0x87 : s.qos,
        );
        send({ cmd: "suback", messageId: packet.messageId, granted });
      } else if (packet.cmd === "unsubscribe") {
        send({ cmd: "unsuback", messageId: packet.messageId, granted: packet.unsubscriptions.map(() => 0) });
      } else if (packet.cmd === "publish") {
        send({ ...packet, messageId: undefined, qos: 0 } as mqttPacket.Packet);
      } else if (packet.cmd === "pingreq") {
        send({ cmd: "pingresp" });
      } else if (packet.cmd === "disconnect") {
        socket.end();
      }
    });
    socket.on("data", (chunk) => parser.parse(chunk));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    publish: async () => undefined,
    connects,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
