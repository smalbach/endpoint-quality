/**
 * El proxy de captura en lo que las otras pruebas no alcanzan: la conexión que se rompe antes de
 * ser una petición, el socket que ya no dice de dónde viene, la caché de credenciales llena y el
 * túnel cuyo destino no contesta ni al apretón de manos TCP.
 */
import { afterEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Agent, IncomingMessage, ServerResponse, request as httpRequest, type Server } from "node:http";
import net, { Socket } from "node:net";

import { CaptureProxy, type CaptureProxyOptions, type ProxySession } from "@/modules/captures/infrastructure/capture-proxy";
import type { RawExchange } from "@/modules/captures/domain/model";
import { hashOpaqueToken } from "@/shared/crypto/opaque-token";

afterEach(() => mock.restoreAll());

const POLICY = { allowPrivateTargets: true, maxRedirects: 0, timeoutMs: 3_000, maxResponseBytes: 1_000_000 };
const basic = (token: string) => `Basic ${Buffer.from(`captura:${token}`).toString("base64")}`;
/** Un puerto al que nadie conecta de verdad: `net.connect` se sustituye para él. */
const SILENT_PORT = 4_444;

const session: ProxySession = {
  id: "s1",
  projectId: "p1",
  expiresAt: new Date("2099-01-01T00:00:00Z"),
  limits: { durationMs: 60_000, maxRequests: 5_000, maxBodyBytes: 4_096 },
  decryptHttps: false,
};

function proxyWith(tokens: string[], extra: Partial<CaptureProxyOptions> = {}) {
  const byHash = new Map(tokens.map((token) => [hashOpaqueToken(token), token]));
  const lookups = new Map<string, number>();
  const exchanges: RawExchange[] = [];
  const proxy = new CaptureProxy({
    policy: POLICY,
    now: () => new Date("2026-03-01T10:00:00Z"),
    maxForwardBodyBytes: 1_000,
    tunnelIdleMs: 2_000,
    connectPorts: new Set([SILENT_PORT]),
    store: {
      lookup: async (hash) => {
        const token = byHash.get(hash);
        if (!token) return null;
        lookups.set(token, (lookups.get(token) ?? 0) + 1);
        return { session };
      },
      record: async (_session, exchange) => {
        exchanges.push(exchange);
        return { open: true };
      },
      expire: async () => undefined,
    },
    ...extra,
  });
  const server = () => (proxy as unknown as { server: Server }).server;
  return { proxy, lookups, exchanges, server };
}

const waitFor = async (condition: () => boolean, ms = 3_000) => {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error("no llegó a tiempo");
    await new Promise((done) => setTimeout(done, 5));
  }
};

/** Un socket falso: lo justo para ver qué se le escribe y si se cierra. */
class FakeSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  constructor(readonly writable = true) {
    super();
  }
  end(text?: string) {
    if (text) this.written.push(text);
  }
  destroy() {
    this.destroyed = true;
  }
}

describe("el proxy de captura, por sus bordes", () => {
  test("una conexión que se rompe antes de ser petición: un 400 si aún se puede escribir, y si no se cierra", async () => {
    const { proxy, server } = proxyWith([]);
    await proxy.listen(0, "127.0.0.1");
    try {
      const alive = new FakeSocket(true);
      server().emit("clientError", new Error("basura"), alive);
      assert.equal(alive.written.length, 1);
      assert.match(alive.written[0], /^HTTP\/1\.1 400 Bad Request/);
      assert.equal(alive.destroyed, false);

      // El cliente cortó con un RST: ya no hay a quién contestar.
      const gone = new FakeSocket(false);
      server().emit("clientError", Object.assign(new Error("reset"), { code: "ECONNRESET" }), gone);
      assert.deepEqual(gone.written, []);
      assert.equal(gone.destroyed, true);
    } finally {
      await proxy.close();
    }
  });

  test("un WebSocket se rechaza con un 501, y un error posterior de ese socket no tumba el proceso", async () => {
    const { proxy, server } = proxyWith([]);
    await proxy.listen(0, "127.0.0.1");
    try {
      const socket = new FakeSocket();
      server().emit("upgrade", {}, socket);
      assert.match(socket.written[0], /^HTTP\/1\.1 501 Not Implemented/);
      // Sin oyente, `emit("error")` lanzaría.
      assert.doesNotThrow(() => socket.emit("error", new Error("EPIPE")));

      const inner = (proxy as unknown as { inner: Server }).inner;
      const tunneled = new FakeSocket();
      inner.emit("upgrade", {}, tunneled);
      assert.match(tunneled.written[0], /^HTTP\/1\.1 501 Not Implemented/);
      assert.doesNotThrow(() => tunneled.emit("error", new Error("EPIPE")));
    } finally {
      await proxy.close();
    }
  });

  test("un socket que ya no sabe su dirección cuenta sus fallos en un cubo común, y el tope llega igual", async () => {
    const { proxy, server } = proxyWith([], { authFailureLimit: { max: 1, windowMs: 60_000 } });
    await proxy.listen(0, "127.0.0.1");
    const ask = async () => {
      // Un socket sin conectar: `remoteAddress` es `undefined`, como el de un cliente que ya se fue.
      const request = new IncomingMessage(new Socket());
      assert.equal(request.socket.remoteAddress, undefined);
      request.method = "GET";
      request.url = "http://destino.test/x";
      request.headers = { "proxy-authorization": basic("uno-que-no-vale") };
      const response = new ServerResponse(request);
      server().emit("request", request, response);
      await waitFor(() => response.writableEnded);
      return response.statusCode;
    };
    try {
      assert.equal(await ask(), 407);
      // El segundo, de otro socket igual de anónimo: el mismo cubo, así que ya no se busca el token.
      assert.equal(await ask(), 429);
    } finally {
      await proxy.close();
    }
  });

  test("la caché de credenciales tiene tope: con mil sesiones más, la primera se vuelve a buscar", async () => {
    const tokens = Array.from({ length: 1_001 }, (_, index) => `token-de-cache-${index}-0123456789abcdef`);
    const { proxy, lookups } = proxyWith(tokens, { authCacheMs: 2_000 });
    const port = await proxy.listen(0, "127.0.0.1");
    const agent = new Agent({ keepAlive: true, maxSockets: 50 });
    const ask = (token: string) =>
      new Promise<number>((done, fail) => {
        // En forma de origen: se autentica —y se recuerda la credencial— y luego es un 400.
        const req = httpRequest(
          { host: "127.0.0.1", port, path: "/", headers: { "Proxy-Authorization": basic(token) }, agent },
          (res) => {
            res.resume();
            res.on("end", () => done(res.statusCode ?? 0));
          },
        );
        req.on("error", fail);
        req.end();
      });
    try {
      assert.equal(await ask(tokens[0]), 400);
      assert.equal(await ask(tokens[0]), 400);
      assert.equal(lookups.get(tokens[0]), 1, "la segunda vez sale de la caché");

      for (let start = 1; start < tokens.length; start += 100) {
        await Promise.all(tokens.slice(start, start + 100).map(ask));
      }
      assert.equal(lookups.get(tokens[1_000]), 1);

      assert.equal(await ask(tokens[0]), 400);
      assert.equal(lookups.get(tokens[0]), 2, "la más vieja salió de la caché para hacer sitio");
    } finally {
      agent.destroy();
      await proxy.close();
    }
  });

  test("un túnel cuyo destino no contesta al conectar: un 504, grabado con el motivo", async () => {
    const original = net.connect;
    let upstream: (EventEmitter & { destroyed: boolean }) | null = null;
    mock.method(net, "connect", (...args: unknown[]) => {
      const options = args[0] as { port?: number };
      if (typeof options !== "object" || options.port !== SILENT_PORT)
        return (original as (...rest: unknown[]) => Socket)(...args);
      // Un destino que nunca completa el apretón de manos: solo llega el plazo.
      const fake = Object.assign(new EventEmitter(), {
        destroyed: false,
        setTimeout: () => fake,
        destroy: () => {
          fake.destroyed = true;
          return fake;
        },
      });
      upstream = fake;
      setImmediate(() => fake.emit("timeout"));
      return fake;
    });

    const token = "token-del-tunel-0123456789abcdef";
    const { proxy, exchanges } = proxyWith([token]);
    const port = await proxy.listen(0, "127.0.0.1");
    try {
      const answer = await new Promise<string>((done, fail) => {
        const socket = original({ host: "127.0.0.1", port }, () =>
          socket.write(
            `CONNECT 127.0.0.1:${SILENT_PORT} HTTP/1.1\r\nHost: 127.0.0.1:${SILENT_PORT}\r\n` +
              `Proxy-Authorization: ${basic(token)}\r\n\r\n`,
          ),
        );
        let data = "";
        socket.on("data", (chunk: Buffer) => (data += chunk.toString("latin1")));
        socket.on("close", () => done(data));
        socket.on("error", fail);
      });
      assert.match(answer, /^HTTP\/1\.1 504 Gateway Timeout/);
      await waitFor(() => exchanges.length === 1);
      assert.equal(exchanges[0].method, "CONNECT");
      assert.equal(exchanges[0].url, `https://127.0.0.1:${SILENT_PORT}`);
      assert.equal(exchanges[0].error, "el destino no contestó a tiempo");
      assert.equal(upstream!.destroyed, true, "el intento de conexión se abandona");
    } finally {
      await proxy.close();
    }
  });
});
