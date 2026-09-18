/**
 * La guarda de un WebSocket: la misma que la de una petición, más lo que solo tiene un socket.
 *
 * Dos capas. La primera sin red: que cada destino que la guarda de HTTP rechaza lo rechaza también
 * un `ws://`, y que la conexión sale hacia la IP comprobada y no hacia el nombre. La segunda contra
 * un servidor `ws` de verdad en loopback, porque el framing, el 401 del upgrade, la redirección que
 * no se sigue y el tope de trama solo existen con bytes de verdad en el cable.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

import { BlockedTargetError, type SafeFetchPolicy } from "@/shared/http/safe-fetch";
import { HandshakeRejectedError, openSafeSocket, pinnedConnection } from "@/shared/http/safe-socket";

const hosted: SafeFetchPolicy = {
  allowPrivateTargets: false,
  maxRedirects: 3,
  timeoutMs: 2_000,
  maxResponseBytes: 1024,
};
const selfHosted: SafeFetchPolicy = { ...hosted, allowPrivateTargets: true };
const OPTIONS = { maxPayload: 64 * 1024, handshakeTimeoutMs: 2_000 };

/** Unas escuchas que apuntan lo que oyen, en orden, para poder afirmar sobre el orden. */
function recorder() {
  const heard: string[] = [];
  const errors: (Error & { code?: string })[] = [];
  let closed: (code: number) => void = () => undefined;
  const closing = new Promise<number>((resolve) => (closed = resolve));
  return {
    heard,
    errors,
    closing,
    listeners: {
      onOpen: () => heard.push("<abierto>"),
      onMessage: (data: Buffer) => heard.push(data.toString()),
      onClose: (code: number) => closed(code),
      onError: (error: Error) => errors.push(error),
    },
  };
}

/** Hasta que se oiga algo, o hasta que se acabe el tiempo. */
async function until(condition: () => boolean, ms = 1_000): Promise<void> {
  const started = Date.now();
  while (!condition() && Date.now() - started < ms) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("los destinos que la guarda de HTTP rechaza, también por socket", () => {
  for (const [url, why] of [
    ["ws://169.254.169.254/socket", /link-local/],
    ["ws://[::ffff:169.254.169.254]/socket", /link-local/],
    ["ws://[::ffff:127.0.0.1]/socket", /loopback/],
    ["ws://localhost:9/socket", /loopback/],
    ["wss://usuario:clave@1.1.1.1/socket", /credenciales/],
    ["http://1.1.1.1/no-es-un-socket", /esquema http: no permitido, solo ws y wss/],
  ] as const) {
    test(url, async () => {
      await assert.rejects(openSafeSocket(url, hosted, OPTIONS, recorder().listeners), (error: Error) => {
        assert.ok(error instanceof BlockedTargetError, error.message);
        assert.match(error.message, why);
        return true;
      });
    });
  }
});

describe("contra un servidor de verdad en loopback", () => {
  let server: Server;
  let sockets: WebSocketServer;
  let port: number;
  const seen: { host?: string; authorization?: string; protocol?: string }[] = [];

  before(async () => {
    server = createServer((request, response) => {
      // Un upgrade que contesta 302: la redirección que no se sigue.
      if (request.url === "/redirige") {
        response.writeHead(302, { Location: "ws://10.0.0.5/interno" }).end();
        return;
      }
      response.writeHead(404).end();
    });
    sockets = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => (protocols.has("eq.v1") ? "eq.v1" : false),
    });
    server.on("upgrade", (request: IncomingMessage, socket, head) => {
      if (request.url === "/redirige") {
        socket.end("HTTP/1.1 302 Found\r\nLocation: ws://10.0.0.5/interno\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (request.url === "/privado" && request.headers.authorization !== "Bearer bueno") {
        socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      sockets.handleUpgrade(request, socket, head, (client: WebSocket) => {
        seen.push({
          host: request.headers.host,
          authorization: request.headers.authorization,
          protocol: client.protocol,
        });
        if (request.url === "/grande") {
          // Cuando el cliente lo pide y no al abrir: mandada al abrir, la trama viaja en el mismo
          // paquete que el 101 y el error salta antes de que la prueba haya podido escuchar.
          client.once("message", () => client.send("x".repeat(OPTIONS.maxPayload + 1)));
          return;
        }
        if (request.url === "/saluda") {
          client.send("hola, soy el saludo");
          return;
        }
        client.on("message", (data) => client.send(`eco: ${String(data)}`));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    // Los clientes primero: `close()` a secas espera a los sockets vivos y deja la suite colgada.
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("la conexión va a la IP comprobada, y el nombre no se vuelve a resolver", async () => {
    // Lo que cierra la ventana de rebinding, probado por lo que hace y no por cómo. El nombre
    // `.invalid` no resuelve nunca —lo reserva el RFC 2606 para esto—, así que si la conexión
    // intentara resolverlo fallaría con ENOTFOUND. Llega, así que fue a la dirección. Si alguien
    // «simplifica» esto dejando que la biblioteca resuelva, es esta prueba la que se pone roja.
    const socket = pinnedConnection("127.0.0.1", false, "no-existe.invalid")({ host: "no-existe.invalid", port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    assert.equal(socket.remoteAddress, "127.0.0.1");
    socket.destroy();
  });

  test("con la guarda puesta, loopback no se abre", async () => {
    await assert.rejects(
      openSafeSocket(`ws://127.0.0.1:${port}/eco`, hosted, OPTIONS, recorder().listeners),
      BlockedTargetError,
    );
  });

  test("abre, conversa, y el Host lo pone la URL y no quien escribe las cabeceras", async () => {
    // Con la IP literal: `localhost` resuelve a `::1` o a `127.0.0.1` según la máquina, y la guarda
    // conecta —bien— a lo que resolvió. Que la conexión no vuelve a resolver el nombre lo prueba el
    // caso `.invalid` de arriba; aquí se prueba la conversación y las cabeceras.
    const ear = recorder();
    const { socket, handshake } = await openSafeSocket(
      `ws://127.0.0.1:${port}/eco`,
      selfHosted,
      { ...OPTIONS, headers: { Authorization: "Bearer bueno", Host: "otro.ejemplo.com" }, subprotocols: ["eq.v1"] },
      ear.listeners,
    );
    try {
      assert.equal(handshake.status, 101);
      socket.send("hola");
      await until(() => ear.heard.length > 1);
      assert.deepEqual(ear.heard, ["<abierto>", "eco: hola"]);
      const last = seen[seen.length - 1];
      // El `Host` que alguien escribió a mano no pasa: lo pone la conexión con el nombre de la URL.
      assert.equal(last.host, `127.0.0.1:${port}`);
      assert.equal(last.authorization, "Bearer bueno");
      assert.equal(last.protocol, "eq.v1");
    } finally {
      socket.terminate();
    }
  });

  test("el saludo que viaja con el 101 no se pierde, y llega después de la apertura", async () => {
    // El fallo que esto fija, medido antes de arreglarlo: con las escuchas puestas tras resolver la
    // promesa, 44 de 50 saludos se perdían. Un servidor que saluda al conectar es lo normal, y el
    // primer mensaje suele ser el que trae la sesión.
    let lost = 0;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ear = recorder();
      const { socket } = await openSafeSocket(`ws://127.0.0.1:${port}/saluda`, selfHosted, OPTIONS, ear.listeners);
      await until(() => ear.heard.length > 1, 300);
      if (ear.heard.join("|") !== "<abierto>|hola, soy el saludo") lost += 1;
      socket.terminate();
    }
    assert.equal(lost, 0);
  });

  test("un 401 en el upgrade vuelve con su número, que es lo que se puede arreglar", async () => {
    await assert.rejects(
      openSafeSocket(`ws://127.0.0.1:${port}/privado`, selfHosted, OPTIONS, recorder().listeners),
      (error: Error) => {
        assert.ok(error instanceof HandshakeRejectedError, error.message);
        assert.equal(error.status, 401);
        return true;
      },
    );
  });

  test("una redirección en el handshake se rechaza y no se sigue", async () => {
    // Un 302 hacia `ws://10.0.0.5` es la forma de siempre de saltarse una comprobación hecha una vez.
    await assert.rejects(
      openSafeSocket(`ws://127.0.0.1:${port}/redirige`, selfHosted, OPTIONS, recorder().listeners),
      (error: Error) => {
        assert.ok(error instanceof HandshakeRejectedError, error.message);
        assert.equal(error.status, 302);
        assert.match(error.message, /no se sigue/);
        return true;
      },
    );
  });

  test("una trama más grande que el tope se rechaza dentro de la biblioteca, sin entregarse", async () => {
    // Lo que importa no es el código de cierre —en local `ws` lo da como 1006, porque aborta, y al
    // otro lado manda 1009— sino que la trama **no llega a nadie**: ni a un manejador de mensajes ni
    // a un contador. Es el tope que `permessage-deflate` no puede saltarse inflando.
    const ear = recorder();
    const { socket } = await openSafeSocket(`ws://127.0.0.1:${port}/grande`, selfHosted, OPTIONS, ear.listeners);
    socket.send("manda");
    await ear.closing;
    assert.equal(ear.errors[0]?.code, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
    assert.deepEqual(ear.heard, ["<abierto>"], "la trama grande no puede haberse entregado");
  });
});
