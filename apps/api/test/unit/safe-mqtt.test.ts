/**
 * La conexión a un broker MQTT, con bytes de verdad: la guarda de red, la dirección fijada, TLS con
 * el nombre, el tope de paquete, y los «no» del broker dichos con su código.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { resolve } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { MqttClient } from "mqtt";

import {
  BlockedTargetError,
  MqttRejectedError,
  PacketSizeGuard,
  openSafeMqtt,
  pinnedBrokerStream,
  subscribeMqtt,
  unsubscribeMqtt,
  type MqttDelivery,
  type SafeMqttOptions,
} from "@/shared/http/safe-mqtt";
import type { SafeFetchPolicy } from "@/shared/http/safe-fetch";
import type { Env } from "@/shared/config/env";
import { MqttChannelTransport, shownProperties } from "@/modules/channels/infrastructure/mqtt-transport";
import { BROKER_USER, startAedes, startMqtt5, type TestBroker } from "../support/mqtt-broker";

const selfHosted: SafeFetchPolicy = {
  allowPrivateTargets: true,
  maxRedirects: 0,
  timeoutMs: 5_000,
  maxResponseBytes: 1024 * 1024,
};
const hosted: SafeFetchPolicy = { ...selfHosted, allowPrivateTargets: false };

const options = (over: Partial<SafeMqttOptions> = {}): SafeMqttOptions => ({
  protocolVersion: 4,
  clientId: `prueba-${Math.random().toString(36).slice(2, 8)}`,
  keepaliveSec: 30,
  clean: true,
  subscriptions: [],
  maxPacketBytes: 64 * 1024,
  connectTimeoutMs: 3_000,
  ...over,
});

const quiet = () => ({
  delivered: [] as MqttDelivery[],
  closed: [] as string[],
  errors: [] as Error[],
});

function listeners(sink: ReturnType<typeof quiet>) {
  return {
    onMessage: (delivery: MqttDelivery) => sink.delivered.push(delivery),
    onClose: (reason: string) => sink.closed.push(reason),
    onError: (error: Error) => sink.errors.push(error),
  };
}

const until = async (condition: () => boolean, what: string) => {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(condition(), `no llegó: ${what}`);
};

describe("la guarda de red, con un broker", () => {
  test("un broker en una dirección privada se rechaza sin conectar cuando ALLOW_PRIVATE_TARGETS=false", async () => {
    const broker = await startAedes();
    let connected = false;
    try {
      await assert.rejects(
        openSafeMqtt(`mqtt://127.0.0.1:${broker.port}`, hosted, options(), listeners(quiet())),
        (error: unknown) => error instanceof BlockedTargetError && /127\.0\.0\.1/.test(error.message),
      );
      // Por el transporte del canal también: la política sale del entorno, como la de un socket.
      const transport = new MqttChannelTransport({ ALLOW_PRIVATE_TARGETS: false } as Env);
      await assert.rejects(
        transport.open(
          `mqtt://localhost:${broker.port}`,
          {
            version: 4,
            clientId: "x",
            keepaliveSec: 30,
            cleanSession: true,
            subscriptions: [],
            maxMessageBytes: 1024,
            connectTimeoutMs: 1_000,
          },
          () => (connected = true),
        ),
        BlockedTargetError,
      );
      // Una IPv4 disfrazada de IPv6 tampoco pasa: es el fallo de la ola 9.
      await assert.rejects(
        openSafeMqtt(`mqtt://[::ffff:127.0.0.1]:${broker.port}`, hosted, options(), listeners(quiet())),
        BlockedTargetError,
      );
      assert.equal(connected, false);
    } finally {
      await broker.close();
    }
  });

  test("otros esquemas y credenciales en la URL no llegan a conectar", async () => {
    await assert.rejects(openSafeMqtt("http://127.0.0.1:1883", selfHosted, options(), listeners(quiet())), /esquema/);
    await assert.rejects(
      openSafeMqtt("mqtt://u:p@127.0.0.1:1883", selfHosted, options(), listeners(quiet())),
      /credenciales/,
    );
  });

  test("la dirección fijada gana al nombre: uno que no resuelve llega igual", async () => {
    const broker = await startAedes();
    try {
      // `.invalid` no resuelve nunca: si la conexión preguntara al DNS, no conectaría.
      const url = new URL(`mqtt://no-existe.invalid:${broker.port}`);
      const client = new MqttClient(() => pinnedBrokerStream(url, "127.0.0.1", options()), {
        clientId: "fijado",
        reconnectPeriod: 0,
        connectTimeout: 3_000,
      });
      await new Promise<void>((done, fail) => {
        client.once("connect", () => done());
        client.once("error", fail);
      });
      client.end(true);
    } finally {
      await broker.close();
    }
  });
});

describe("contra un broker 3.1.1", () => {
  let broker: TestBroker;
  const PASSWORD = "contraseña-del-broker-3c9d";
  before(async () => {
    broker = await startAedes({ password: PASSWORD, forbidden: "prohibido/" });
  });
  after(async () => broker.close());

  const url = () => `mqtt://127.0.0.1:${broker.port}`;

  test("conecta, se suscribe, recibe el retenido con su tema, y oye lo que publica", async () => {
    await broker.publish("sensores/sala/temp", '{"t":21}', true);
    const sink = quiet();
    const opened: string[] = [];
    const { client, handshake } = await openSafeMqtt(
      url(),
      selfHosted,
      options({ username: BROKER_USER, password: PASSWORD, subscriptions: [{ topic: "sensores/#", qos: 1 }] }),
      { ...listeners(sink), onOpen: (h) => opened.push(h.via) },
    );
    try {
      assert.equal(handshake.status, 0);
      assert.equal(handshake.via, "CONNACK");
      assert.deepEqual(opened, ["CONNACK"]);
      await until(() => sink.delivered.length >= 1, "el retenido");
      assert.equal(sink.delivered[0].topic, "sensores/sala/temp");
      assert.equal(sink.delivered[0].retain, true);
      assert.equal(sink.delivered[0].payload.toString(), '{"t":21}');

      client.publish("sensores/cocina/temp", '{"t":19}', { qos: 1 });
      await until(() => sink.delivered.length >= 2, "el eco de lo publicado");
      assert.equal(sink.delivered[1].topic, "sensores/cocina/temp");
      assert.equal(sink.delivered[1].qos, 1);
    } finally {
      client.end(true);
    }
  });

  test("una contraseña mala es un no del broker, con el código y lo que significa", async () => {
    await assert.rejects(
      openSafeMqtt(url(), selfHosted, options({ username: BROKER_USER, password: "otra" }), listeners(quiet())),
      (error: unknown) =>
        error instanceof MqttRejectedError &&
        /CONNACK 4 \(usuario o contraseña incorrectos\)/.test(error.message) &&
        !error.message.includes("otra"),
    );
  });

  test("una suscripción negada no deja la conexión «abierta»", async () => {
    await assert.rejects(
      openSafeMqtt(
        url(),
        selfHosted,
        options({ username: BROKER_USER, password: PASSWORD, subscriptions: [{ topic: "prohibido/#", qos: 0 }] }),
        listeners(quiet()),
      ),
      (error: unknown) => error instanceof MqttRejectedError && /suscripción a prohibido\/#/.test(error.message),
    );
  });
});

describe("contra un broker 5.0", () => {
  test("conecta, publica y recibe el eco", async () => {
    const broker = await startMqtt5();
    const sink = quiet();
    try {
      const { client, handshake } = await openSafeMqtt(
        `mqtt://127.0.0.1:${broker.port}`,
        selfHosted,
        options({ protocolVersion: 5, subscriptions: [{ topic: "eco/#", qos: 0 }] }),
        listeners(sink),
      );
      assert.equal(handshake.headers.protocolo, "MQTT 5.0");
      client.publish("eco/uno", "hola");
      await until(() => sink.delivered.length === 1, "el eco");
      assert.equal(sink.delivered[0].topic, "eco/uno");
      client.end(true);
    } finally {
      await broker.close();
    }
  });

  test("un 0x86 en el CONNACK se dice como tal", async () => {
    const broker = await startMqtt5({ password: "buena" });
    try {
      await assert.rejects(
        openSafeMqtt(
          `mqtt://127.0.0.1:${broker.port}`,
          selfHosted,
          options({ protocolVersion: 5, username: "u", password: "mala" }),
          listeners(quiet()),
        ),
        /CONNACK 134 \(usuario o contraseña incorrectos\)/,
      );
    } finally {
      await broker.close();
    }
  });

  test("un paquete más grande que el tope corta la conexión antes de entrar en memoria", async () => {
    const broker = await startMqtt5({ oversized: 50_000 });
    const sink = quiet();
    try {
      // El paquete grande puede llegar en el mismo trozo TCP que el CONNACK —entonces la conexión no
      // llega a abrir— o justo después —y entonces se corta abierta—. Las dos son el tope haciendo
      // su trabajo; lo que no puede pasar es que el mensaje se entregue.
      const outcome = await openSafeMqtt(
        `mqtt://127.0.0.1:${broker.port}`,
        selfHosted,
        options({ protocolVersion: 5, maxPacketBytes: 1_000 }),
        listeners(sink),
      ).then(
        async ({ client }) => {
          await until(() => sink.errors.length + sink.closed.length > 0, "el corte");
          client.end(true);
          return [...sink.errors.map((error) => error.message), ...sink.closed].join(" · ");
        },
        (error: Error) => error.message,
      );
      assert.match(outcome, /50\d{3} bytes, y el tope es 1000|cerró/);
      assert.equal(sink.delivered.length, 0);
    } finally {
      await broker.close();
    }
  });
});

describe("el tope de paquete, byte a byte", () => {
  test("lee la longitud aunque llegue partida entre trozos", () => {
    const guard = new PacketSizeGuard(200);
    // PUBLISH con longitud 300 (0xAC 0x02), en dos trozos: el segundo byte de longitud llega solo.
    assert.equal(guard.feed(Buffer.from([0x30, 0xac])), null);
    assert.match(guard.feed(Buffer.from([0x02])) ?? "", /300 bytes/);
  });

  test("deja pasar paquetes seguidos dentro del tope", () => {
    const guard = new PacketSizeGuard(10);
    const packet = Buffer.from([0x30, 0x03, 1, 2, 3]);
    assert.equal(guard.feed(Buffer.concat([packet, packet, Buffer.from([0xd0, 0x00])])), null);
  });

  test("una longitud de más de cuatro bytes es un paquete mal formado", () => {
    assert.match(new PacketSizeGuard(1e9).feed(Buffer.from([0x30, 0xff, 0xff, 0xff, 0xff])) ?? "", /mal formada/);
  });
});

describe("MQTT sobre WebSocket", () => {
  test("ws:// al broker, con la misma conexión fijada", async () => {
    const broker = await startAedes({ websocket: true });
    const sink = quiet();
    try {
      const { client } = await openSafeMqtt(
        `ws://127.0.0.1:${broker.port}/mqtt`,
        selfHosted,
        options({ subscriptions: [{ topic: "ws/#", qos: 0 }] }),
        listeners(sink),
      );
      client.publish("ws/uno", "hola");
      await until(() => sink.delivered.length === 1, "el mensaje por WebSocket");
      client.end(true);
    } finally {
      await broker.close();
    }
  });
});

/** mqtts:// con el certificado de prueba de `test/fixtures/tls`: el mismo caso que rompió HTTPS. */
describe("contra un broker mqtts:// con certificado para un nombre", () => {
  let broker: TestBroker;
  const defaults = getCACertificates("default");
  function fixture(name: string): string {
    let directory = __dirname;
    while (!existsSync(resolve(directory, "test/fixtures/tls", name))) directory = resolve(directory, "..");
    return readFileSync(resolve(directory, "test/fixtures/tls", name), "utf8");
  }

  before(async () => {
    setDefaultCACertificates([...defaults, fixture("ca.pem")]);
    const { address } = await lookup("localhost");
    broker = await startAedes({
      host: address,
      tls: { cert: fixture("localhost.pem"), key: fixture("localhost.key") },
    });
  });
  after(async () => {
    setDefaultCACertificates(defaults);
    await broker.close();
  });

  test("el certificado se valida contra el nombre, y la conexión va a la IP comprobada", async () => {
    const { client } = await openSafeMqtt(
      `mqtts://localhost:${broker.port}`,
      selfHosted,
      options(),
      listeners(quiet()),
    );
    client.end(true);
  });

  test("la verificación sigue puesta: por la IP, el certificado no casa", async () => {
    const { address, family } = await lookup("localhost");
    const literal = family === 6 ? `[${address}]` : address;
    await assert.rejects(
      openSafeMqtt(`mqtts://${literal}:${broker.port}`, selfHosted, options(), listeners(quiet())),
      /altnames|certificate|IP/i,
    );
  });
});

describe("a mitad de sesión, contra un broker 3.1.1", () => {
  let broker: TestBroker;
  before(async () => {
    broker = await startAedes({ forbidden: "prohibido/" });
  });
  after(async () => broker.close());
  const url = () => `mqtt://127.0.0.1:${broker.port}`;

  test("suscribirse concede la QoS, un no del broker se dice con su código y la conexión sigue", async () => {
    const sink = quiet();
    const { client } = await openSafeMqtt(url(), selfHosted, options(), listeners(sink));
    try {
      assert.equal(await subscribeMqtt(client, "casa/#", 1, 2_000), 1);
      await assert.rejects(
        subscribeMqtt(client, "prohibido/#", 0, 2_000),
        (error: unknown) => error instanceof MqttRejectedError && /^128 /.test(error.message),
      );
      // Lo que ya se oía se sigue oyendo: el no de una suscripción no cierra la conexión.
      client.publish("casa/sala", "hola");
      await until(() => sink.delivered.length === 1, "el mensaje del tema concedido");
      assert.equal(sink.closed.length, 0);

      await unsubscribeMqtt(client, "casa/#", 2_000);
      client.publish("casa/sala", "otra vez");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(sink.delivered.length, 1, "tras darse de baja no llega nada");
    } finally {
      client.end(true);
    }
  });

  test("el testamento sale cuando la conexión se corta sin despedirse, y no con un DISCONNECT", async () => {
    const watcher = quiet();
    const { client: watching } = await openSafeMqtt(
      url(),
      selfHosted,
      options({ subscriptions: [{ topic: "estado/#", qos: 0 }] }),
      listeners(watcher),
    );
    const will = { topic: "estado/sensor-1", payload: "caído", qos: 0 as const, retain: false };
    try {
      const polite = await openSafeMqtt(url(), selfHosted, options({ will }), listeners(quiet()));
      polite.client.end(false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(watcher.delivered.length, 0, "un DISCONNECT no publica el testamento");

      const rude = await openSafeMqtt(url(), selfHosted, options({ will }), listeners(quiet()));
      assert.equal(rude.handshake.headers.testamento, "estado/sensor-1 (QoS 0)");
      rude.client.stream.destroy();
      await until(() => watcher.delivered.length === 1, "el testamento");
      assert.equal(watcher.delivered[0].topic, "estado/sensor-1");
      assert.equal(watcher.delivered[0].payload.toString(), "caído");
    } finally {
      watching.end(true);
    }
  });
});

describe("las propiedades de MQTT 5", () => {
  test("las del CONNECT llegan al broker, y las de un mensaje se entregan con él", async () => {
    const broker = await startMqtt5({ forbidden: "prohibido/" });
    const sink = quiet();
    try {
      const { client } = await openSafeMqtt(
        `mqtt://127.0.0.1:${broker.port}`,
        selfHosted,
        options({
          protocolVersion: 5,
          userProperties: [
            { name: "origen", value: "eq" },
            { name: "origen", value: "prueba" },
          ],
          will: { topic: "estado/x", payload: "caído", qos: 1, retain: true },
        }),
        listeners(sink),
      );
      const [connect] = broker.connects ?? [];
      assert.deepEqual({ ...connect.properties?.userProperties }, { origen: ["eq", "prueba"] });
      assert.equal(connect.will?.topic, "estado/x");
      assert.equal(connect.will?.retain, true);

      // Un 0x87 de un broker 5.0 es un no con su nombre.
      await assert.rejects(subscribeMqtt(client, "prohibido/#", 0, 2_000), /135 \(no autorizado\)/);

      client.publish("eco/uno", "hola", {
        properties: {
          userProperties: { traza: "abc" },
          contentType: "text/plain",
          responseTopic: "respuestas/1",
          correlationData: Buffer.from([0, 255]),
        },
      });
      await until(() => sink.delivered.length === 1, "el eco con propiedades");
      const { properties } = sink.delivered[0];
      assert.deepEqual(properties?.userProperties, [["traza", "abc"]]);
      assert.equal(properties?.contentType, "text/plain");
      assert.equal(properties?.responseTopic, "respuestas/1");
      assert.deepEqual(shownProperties(properties!), {
        userProperties: [["traza", "abc"]],
        contentType: "text/plain",
        responseTopic: "respuestas/1",
        correlationData: "00ff",
        correlationEncoding: "hex",
      });
      client.end(true);
    } finally {
      await broker.close();
    }
  });

  test("unos datos de correlación que son texto se enseñan como texto", () => {
    assert.deepEqual(shownProperties({ correlationData: Buffer.from("pedido-7") }), {
      correlationData: "pedido-7",
      correlationEncoding: "text",
    });
  });
});
