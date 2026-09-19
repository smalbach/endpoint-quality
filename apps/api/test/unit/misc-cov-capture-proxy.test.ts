/**
 * El proxy de captura por los caminos que no son el feliz: la tabla que falla, el cuerpo que no
 * cabe, el destino que corta a medias, las cabeceras repetidas, los cuerpos comprimidos, los
 * túneles con datos de más o que se quedan callados, y el descifrado cuando el dispositivo no
 * termina el apretón de manos o manda algo que no es HTTP.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Agent, type Server } from "node:http";
import { connect as netConnect, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { connect as tlsConnect, createSecureContext, type TLSSocket } from "node:tls";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";

import {
  CaptureProxy,
  type CaptureProxyOptions,
  type CaptureProxyStore,
  type ProxySession,
} from "@/modules/captures/infrastructure/capture-proxy";
import type { RawExchange } from "@/modules/captures/domain/model";
import { hashOpaqueToken } from "@/shared/crypto/opaque-token";

const TOKEN = "token-de-cobertura-0123456789abcdef";
const OPEN = { allowPrivateTargets: true, maxRedirects: 0, timeoutMs: 3_000, maxResponseBytes: 1_000_000 };
const CLOSED = { ...OPEN, allowPrivateTargets: false };
const basic = (token: string) => `Basic ${Buffer.from(`captura:${token}`).toString("base64")}`;
const AUTH = { "Proxy-Authorization": basic(TOKEN) };

function fixture(name: string): string {
  let directory = __dirname;
  while (!existsSync(resolve(directory, "test/fixtures/tls", name))) directory = resolve(directory, "..");
  return readFileSync(resolve(directory, "test/fixtures/tls", name), "utf8");
}

let target: Server;
let targetPort: number;
/** Un puerto en el que nadie escucha: conectar ahí es un ECONNREFUSED. */
let deadPort: number;
/** Uno que acepta la conexión y, en cuanto le llega algo, la corta con un RST. */
let resetter: NetServer;
let resetPort: number;

before(async () => {
  target = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const json = (value: unknown) => Buffer.from(JSON.stringify(value));
      const encoded: Record<string, [string, Buffer]> = {
        "/gzip": ["gzip", gzipSync(json({ via: "gzip" }))],
        "/x-gzip": ["x-gzip", gzipSync(json({ via: "x-gzip" }))],
        "/deflate": ["deflate", deflateSync(json({ via: "deflate" }))],
        "/br": ["br", brotliCompressSync(json({ via: "br" }))],
        "/identity": ["identity", json({ via: "identity" })],
        "/raro": ["compress", json({ via: "raro" })],
        "/roto": ["gzip", Buffer.from("esto no es gzip")],
      };
      const hit = encoded[req.url ?? ""];
      if (hit) {
        res.writeHead(200, { "content-type": "application/json", "content-encoding": hit[0] });
        return res.end(hit[1]);
      }
      if (req.url === "/cookies") {
        res.setHeader("set-cookie", ["a=uno", "b=dos"]);
        res.setHeader("content-type", "application/json");
        return res.end("{}");
      }
      if (req.url === "/corta") {
        res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
        res.write('{"empieza":');
        return setTimeout(() => res.socket?.destroy(), 20);
      }
      if (req.url === "/goteo") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("primer trozo");
        // Nunca termina: quien corta es el cliente.
        return;
      }
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
  });
  await new Promise<void>((done) => target.listen(0, "127.0.0.1", done));
  targetPort = (target.address() as AddressInfo).port;
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  deadPort = (probe.address() as AddressInfo).port;
  await new Promise((done) => probe.close(done));
  resetter = createNetServer((socket) => socket.once("data", () => socket.resetAndDestroy()));
  await new Promise<void>((done) => resetter.listen(0, "127.0.0.1", done));
  resetPort = (resetter.address() as AddressInfo).port;
});

after(async () => {
  target.closeAllConnections();
  await new Promise((done) => target.close(done));
  await new Promise((done) => resetter.close(done));
});

type Harness = {
  proxy: CaptureProxy;
  port: number;
  exchanges: RawExchange[];
  expired: number;
  clock: { now: Date };
  session: ProxySession;
};

async function harness(
  options: {
    policy?: typeof OPEN;
    store?: Partial<CaptureProxyStore>;
    extra?: Partial<CaptureProxyOptions>;
    session?: Partial<ProxySession>;
  } = {},
): Promise<Harness> {
  const clock = { now: new Date("2026-03-01T10:00:00Z") };
  const session: ProxySession = {
    id: "s1",
    projectId: "p1",
    expiresAt: new Date(clock.now.getTime() + 60_000),
    limits: { durationMs: 60_000, maxRequests: 50, maxBodyBytes: 4_096 },
    decryptHttps: false,
    ...options.session,
  };
  const h = { exchanges: [] as RawExchange[], expired: 0, clock, session } as Harness;
  const tokenHash = hashOpaqueToken(TOKEN);
  h.proxy = new CaptureProxy({
    policy: options.policy ?? OPEN,
    now: () => clock.now,
    maxForwardBodyBytes: 1_000,
    tunnelIdleMs: 2_000,
    connectPorts: new Set([443, targetPort, deadPort, resetPort]),
    store: {
      lookup: async (hash) => (hash === tokenHash ? { session } : null),
      record: async (_session, exchange) => {
        h.exchanges.push(exchange);
        return { open: true };
      },
      expire: async () => {
        h.expired += 1;
      },
      ...options.store,
    },
    ...options.extra,
  });
  h.port = await h.proxy.listen(0, "127.0.0.1");
  return h;
}

type Answer = { status: number; body: string; headers: Record<string, unknown>; aborted: boolean };

function viaProxy(
  port: number,
  url: string,
  options: { method?: string; headers?: Record<string, string> | string[]; body?: string; agent?: false | Agent } = {},
): Promise<Answer> {
  return new Promise((done, fail) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: url,
        headers: options.headers as Record<string, string>,
        agent: options.agent ?? false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let aborted = false;
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("aborted", () => (aborted = true));
        res.on("error", () => (aborted = true));
        res.on("close", () =>
          done({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
            aborted: aborted || !res.complete,
          }),
        );
      },
    );
    req.on("error", fail);
    req.end(options.body);
  });
}

/** Escribe lo que se le pida en un socket crudo y devuelve todo lo que llega hasta que se cierra. */
function raw(port: number, text: string, settleMs = 5_000): Promise<string> {
  return new Promise((done, fail) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => socket.write(text));
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      done(data);
    }, settleMs);
    socket.on("data", (chunk: Buffer) => (data += chunk.toString("latin1")));
    socket.on("close", () => {
      clearTimeout(timer);
      done(data);
    });
    socket.on("error", fail);
  });
}

const connectLine = (authority: string, token: string | null = TOKEN) =>
  `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${token ? `Proxy-Authorization: ${basic(token)}\r\n` : ""}\r\n`;

/** Un túnel abierto: el socket, con el `200` ya leído. */
function tunnel(port: number, authority: string): Promise<Socket> {
  return new Promise((done, fail) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => socket.write(connectLine(authority)));
    let data = "";
    const onData = (chunk: Buffer) => {
      data += chunk.toString("latin1");
      if (!data.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      if (data.startsWith("HTTP/1.1 200")) done(socket);
      else fail(new Error(data.split("\r\n")[0]));
    };
    socket.on("data", onData);
    socket.on("error", fail);
  });
}

const waitFor = async (condition: () => boolean, ms = 3_000) => {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error("no llegó a tiempo");
    await new Promise((done) => setTimeout(done, 10));
  }
};

describe("el proxy, fuera del camino feliz", () => {
  test("escuchar dos veces abre un solo servidor, y antes de escuchar no hay puerto", async () => {
    const h = await harness();
    try {
      assert.equal(h.proxy.listening, true);
      assert.equal(await h.proxy.listen(0, "127.0.0.1"), h.port);
      await h.proxy.close();
      assert.equal(h.proxy.port, null);
      assert.equal(h.proxy.listening, false);
      const [a, b] = await Promise.all([h.proxy.listen(0, "127.0.0.1"), h.proxy.listen(0, "127.0.0.1")]);
      assert.equal(a, b);
    } finally {
      await h.proxy.close();
    }
  });

  test("una tabla que no contesta al buscar el token es un 407 que invita a reintentar", async () => {
    const h = await harness({ store: { lookup: () => Promise.reject(new Error("db caída")) } });
    try {
      const answer = await viaProxy(h.port, `http://127.0.0.1:${targetPort}/x`, { headers: AUTH });
      assert.equal(answer.status, 407);
      assert.match(answer.body, /vuelve a intentarlo/);
    } finally {
      await h.proxy.close();
    }
  });

  test("una escritura que falla no tumba la petición de quien usa su aplicación", async () => {
    const h = await harness({ store: { record: () => Promise.reject(new Error("disco lleno")) } });
    try {
      const answer = await viaProxy(h.port, `http://127.0.0.1:${targetPort}/x`, { headers: AUTH });
      assert.equal(answer.status, 200);
      assert.equal(JSON.parse(answer.body).path, "/x");
      // Sigue abierta: un fallo de escritura no cuenta como tope.
      assert.deepEqual(h.proxy.knownSessions(), ["s1"]);
    } finally {
      await h.proxy.close();
    }
  });

  test("una sesión caducada cuyo aviso a la tabla falla sigue siendo un 407", async () => {
    const h = await harness({ store: { expire: () => Promise.reject(new Error("db caída")) } });
    try {
      h.clock.now = new Date(h.clock.now.getTime() + 120_000);
      const answer = await viaProxy(h.port, `http://127.0.0.1:${targetPort}/x`, { headers: AUTH });
      assert.equal(answer.status, 407);
      assert.match(answer.body, /expired/);
    } finally {
      await h.proxy.close();
    }
  });

  test("varias peticiones por la misma conexión se atienden y la conexión se cuenta una vez", async () => {
    const h = await harness();
    const agent = new (await import("node:http")).Agent({ keepAlive: true, maxSockets: 1 });
    try {
      for (const path of ["/uno", "/dos"]) {
        const answer = await viaProxy(h.port, `http://127.0.0.1:${targetPort}${path}`, { headers: AUTH, agent });
        assert.equal(answer.status, 200);
      }
      assert.equal(h.exchanges.length, 2);
      const sockets = (h.proxy as unknown as { sockets: Map<string, Set<Socket>> }).sockets.get("s1");
      assert.equal(sockets?.size, 1);
    } finally {
      agent.destroy();
      await h.proxy.close();
    }
  });

  test("un cuerpo mayor que el que reenvía el proxy es un 413 y no se graba", async () => {
    const h = await harness();
    try {
      const answer = await viaProxy(h.port, `http://127.0.0.1:${targetPort}/x`, {
        method: "POST",
        headers: AUTH,
        body: "x".repeat(5_000),
      });
      assert.equal(answer.status, 413);
      assert.match(answer.body, /supera 1000 bytes/);
      assert.equal(answer.headers["x-capture-proxy"], "refused");
      assert.equal(h.exchanges.length, 0);
    } finally {
      await h.proxy.close();
    }
  });

  test("un destino bloqueado que además llena la sesión la corta después de contestar", async () => {
    const h = await harness({
      policy: CLOSED,
      store: {
        record: async (_session, exchange) => {
          h.exchanges.push(exchange);
          return { open: false };
        },
      },
    });
    try {
      const answer = await viaProxy(h.port, `http://127.0.0.1:${targetPort}/x`, { headers: AUTH });
      assert.equal(answer.status, 403);
      await waitFor(() => h.proxy.knownSessions().length === 0);
      // El túnel bloqueado, igual.
      assert.equal(await raw(h.port, connectLine(`127.0.0.1:${targetPort}`)), "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      // Y el puerto no permitido, igual.
      assert.match(await raw(h.port, connectLine("127.0.0.1:25")), /^HTTP\/1.1 403 Forbidden/);
      await waitFor(() => h.proxy.knownSessions().length === 0);
      assert.equal(h.exchanges.length, 3);
    } finally {
      await h.proxy.close();
    }
  });

  test("un destino que no escucha es un 502 grabado con el motivo", async () => {
    const h = await harness();
    try {
      const answer = await viaProxy(h.port, `http://127.0.0.1:${deadPort}/x`, { headers: AUTH });
      assert.equal(answer.status, 502);
      assert.match(answer.body, /^El destino no contestó/);
      assert.equal(h.exchanges.length, 1);
      assert.match(h.exchanges[0]!.error ?? "", /^el destino no contestó: /);
      assert.equal(h.exchanges[0]!.status, null);
    } finally {
      await h.proxy.close();
    }
  });

  test("un destino que corta a media respuesta corta al cliente, se graba y, si llenó la sesión, la cierra", async () => {
    const h = await harness({
      store: {
        record: async (_session, exchange) => {
          h.exchanges.push(exchange);
          return { open: false };
        },
      },
    });
    try {
      const answer = await viaProxy(h.port, `http://127.0.0.1:${targetPort}/corta`, { headers: AUTH });
      assert.equal(answer.status, 200);
      assert.equal(answer.aborted, true);
      await waitFor(() => h.exchanges.length === 1);
      assert.match(h.exchanges[0]!.error ?? "", /el destino no contestó/);
      await waitFor(() => h.proxy.knownSessions().length === 0);
    } finally {
      await h.proxy.close();
    }
  });

  test("un cliente que se va a media respuesta suelta también al destino, y se graba", async () => {
    const h = await harness();
    try {
      await new Promise<void>((done, fail) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: h.port, path: `http://127.0.0.1:${targetPort}/goteo`, headers: AUTH, agent: false },
          (res) => {
            res.once("data", () => {
              req.destroy();
              done();
            });
          },
        );
        req.on("error", () => undefined);
        req.on("response", () => undefined);
        req.end();
        setTimeout(() => fail(new Error("sin respuesta")), 3_000);
      });
      await waitFor(() => h.exchanges.length === 1);
      assert.match(h.exchanges[0]!.error ?? "", /el destino no contestó/);
    } finally {
      await h.proxy.close();
    }
  });

  test("las cabeceras repetidas se unen, las que nombra Connection no se reenvían, y la codificación se pide sin comprimir", async () => {
    const h = await harness();
    try {
      const answer = await viaProxy(h.port, `http://127.0.0.1:${targetPort}/eco`, {
        headers: [
          "Host", `127.0.0.1:${targetPort}`,
          "Proxy-Authorization", basic(TOKEN),
          "X-Varias", "uno",
          "X-Varias", "dos",
          "Connection", "x-del-salto, keep-alive",
          "X-Del-Salto", "no pasa",
          "Accept-Encoding", "gzip",
        ],
      });
      assert.equal(answer.status, 200);
      const seen = JSON.parse(answer.body).headers as Record<string, string>;
      assert.equal(seen["x-varias"], "uno, dos");
      assert.equal(seen["x-del-salto"], undefined);
      assert.equal(seen["accept-encoding"], "identity");
      assert.equal(seen["proxy-authorization"], undefined);
      // Lo grabado: con el nombre como lo escribió el cliente, unido, y sin la credencial del proxy.
      const recorded = h.exchanges[0]!.requestHeaders;
      assert.equal(recorded["X-Varias"], "uno, dos");
      assert.equal(recorded["X-Del-Salto"], "no pasa");
      assert.equal(recorded["Proxy-Authorization"], undefined);
      assert.equal(recorded["Connection"], undefined);
    } finally {
      await h.proxy.close();
    }
  });

  test("varias Set-Cookie llegan al cliente por separado y se graban unidas", async () => {
    const h = await harness();
    try {
      const answer = await viaProxy(h.port, `http://127.0.0.1:${targetPort}/cookies`, { headers: AUTH });
      assert.deepEqual(answer.headers["set-cookie"], ["a=uno", "b=dos"]);
      assert.equal(h.exchanges[0]!.responseHeaders["set-cookie"], "a=uno, b=dos");
    } finally {
      await h.proxy.close();
    }
  });

  test("un cuerpo comprimido se guarda descomprimido; uno roto o de una codificación desconocida, vacío", async () => {
    const h = await harness();
    try {
      for (const kind of ["gzip", "x-gzip", "deflate", "br", "identity"]) {
        const answer = await viaProxy(h.port, `http://127.0.0.1:${targetPort}/${kind}`, { headers: AUTH });
        assert.equal(answer.status, 200);
        const stored = h.exchanges.at(-1)!;
        assert.deepEqual(JSON.parse(stored.responseBody.toString("utf8")), { via: kind }, kind);
      }
      for (const kind of ["raro", "roto"]) {
        await viaProxy(h.port, `http://127.0.0.1:${targetPort}/${kind}`, { headers: AUTH });
        assert.equal(h.exchanges.at(-1)!.responseBody.length, 0, kind);
      }
    } finally {
      await h.proxy.close();
    }
  });

  test("un WebSocket por el proxy es un 501, y lo que no es HTTP un 400", async () => {
    const h = await harness();
    try {
      const upgrade = await raw(
        h.port,
        `GET http://127.0.0.1:${targetPort}/ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      );
      assert.match(upgrade, /^HTTP\/1.1 501 Not Implemented/);
      const garbage = await raw(h.port, "ESTO NO ES HTTP\r\n\r\n");
      assert.match(garbage, /^HTTP\/1.1 400 Bad Request/);
      assert.equal(h.exchanges.length, 0);
    } finally {
      await h.proxy.close();
    }
  });
});

describe("los túneles, fuera del camino feliz", () => {
  test("un destino de túnel mal escrito es un 400 y no se graba", async () => {
    const h = await harness();
    try {
      for (const authority of [`usuario:clave@127.0.0.1:${targetPort}`, `127.0.0.1:${targetPort}/ruta`])
        assert.match(await raw(h.port, connectLine(authority)), /^HTTP\/1.1 400 Bad Request/, authority);
      assert.equal(h.exchanges.length, 0);
    } finally {
      await h.proxy.close();
    }
  });

  test("lo que el cliente manda junto al CONNECT llega al destino", async () => {
    const h = await harness();
    try {
      const answer = await raw(
        h.port,
        `${connectLine(`127.0.0.1:${targetPort}`)}GET /por-el-tunel HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
      );
      assert.match(answer, /^HTTP\/1.1 200 Connection Established\r\n\r\nHTTP\/1.1 200 OK/);
      assert.match(answer, /"path":"\/por-el-tunel"/);
      await waitFor(() => h.exchanges.length === 1);
      assert.equal(h.exchanges[0]!.encrypted, true);
    } finally {
      await h.proxy.close();
    }
  });

  test("un túnel que llena la sesión la corta en cuanto se graba", async () => {
    const h = await harness({
      store: {
        record: async (_session, exchange) => {
          h.exchanges.push(exchange);
          return { open: false };
        },
      },
    });
    try {
      const socket = await tunnel(h.port, `127.0.0.1:${targetPort}`);
      await new Promise((done) => socket.once("close", done));
      assert.equal(h.exchanges.length, 1);
      assert.deepEqual(h.proxy.knownSessions(), []);
    } finally {
      await h.proxy.close();
    }
  });

  test("un túnel a un puerto permitido donde nadie escucha es un 502 grabado", async () => {
    const h = await harness();
    try {
      assert.match(await raw(h.port, connectLine(`127.0.0.1:${deadPort}`)), /^HTTP\/1.1 502 Bad Gateway/);
      await waitFor(() => h.exchanges.length === 1);
      assert.match(h.exchanges[0]!.error ?? "", /^el destino no contestó: .*ECONNREFUSED/);
    } finally {
      await h.proxy.close();
    }
  });

  test("un destino que corta el túnel ya abierto corta también al cliente", async () => {
    const h = await harness();
    try {
      const socket = await tunnel(h.port, `127.0.0.1:${resetPort}`);
      socket.write("hola");
      await new Promise((done) => socket.once("close", done));
      // Grabado al abrirse, sin error: lo que pasó después no cambia lo que se vio.
      assert.equal(h.exchanges.length, 1);
      assert.equal(h.exchanges[0]!.error, null);
    } finally {
      await h.proxy.close();
    }
  });

  test("un túnel callado más de lo que se aguanta se corta", async () => {
    const h = await harness({ extra: { tunnelIdleMs: 150 } });
    try {
      const socket = await tunnel(h.port, `127.0.0.1:${targetPort}`);
      const started = Date.now();
      await new Promise((done) => socket.once("close", done));
      assert.ok(Date.now() - started < 2_000);
      assert.equal(h.exchanges.length, 1);
      assert.equal(h.exchanges[0]!.error, null);
    } finally {
      await h.proxy.close();
    }
  });
});

describe("descifrar, fuera del camino feliz", () => {
  const context = createSecureContext({ cert: fixture("localhost.pem"), key: fixture("localhost.key") });
  const mitm = { contextFor: async () => context };

  test("si no se puede firmar el certificado, 502 y el túnel grabado con el motivo", async () => {
    for (const [failure, reason] of [
      [new Error("sin CA"), "no se pudo descifrar: sin CA"],
      ["algo raro", "no se pudo descifrar: no se pudo firmar el certificado"],
    ] as const) {
      let open = true;
      const h = await harness({
        session: { decryptHttps: true },
        extra: { mitm: { contextFor: () => Promise.reject(failure) } },
        store: {
          record: async (_session, exchange) => {
            h.exchanges.push(exchange);
            open = !open;
            return { open };
          },
        },
      });
      try {
        assert.match(await raw(h.port, connectLine(`127.0.0.1:${targetPort}`)), /^HTTP\/1.1 502 Bad Gateway/);
        assert.equal(h.exchanges[0]!.error, reason);
        assert.equal(h.exchanges[0]!.encrypted, true);
      } finally {
        await h.proxy.close();
      }
    }
  });

  test("un dispositivo que manda algo que no es TLS deja el túnel grabado con el motivo", async () => {
    const h = await harness({ session: { decryptHttps: true }, extra: { mitm } });
    try {
      const answer = await raw(h.port, `${connectLine(`localhost:${targetPort}`)}esto no es un ClientHello\r\n\r\n`);
      assert.match(answer, /^HTTP\/1.1 200 Connection Established/);
      await waitFor(() => h.exchanges.length === 1);
      assert.match(h.exchanges[0]!.error ?? "", /no aceptó el certificado de la CA de captura/);
    } finally {
      await h.proxy.close();
    }
  });

  test("un dispositivo que no empieza el apretón de manos se graba al vencer el plazo", async () => {
    const h = await harness({ policy: { ...OPEN, timeoutMs: 200 }, session: { decryptHttps: true }, extra: { mitm } });
    try {
      const socket = await tunnel(h.port, `localhost:${targetPort}`);
      await waitFor(() => h.exchanges.length === 1);
      assert.match(h.exchanges[0]!.error ?? "", /no terminó el apretón de manos/);
      socket.destroy();
    } finally {
      await h.proxy.close();
    }
  });

  test("un dispositivo que cuelga sin apretón de manos deja el túnel grabado una sola vez", async () => {
    const h = await harness({ session: { decryptHttps: true }, extra: { mitm, tunnelIdleMs: 100 } });
    try {
      const socket = await tunnel(h.port, `localhost:${targetPort}`);
      socket.destroy();
      await waitFor(() => h.exchanges.length === 1);
      await new Promise((done) => setTimeout(done, 50));
      assert.equal(h.exchanges.length, 1);
      assert.match(h.exchanges[0]!.error ?? "", /CA de captura/);
    } finally {
      await h.proxy.close();
    }
  });

  /** Un túnel descifrado, confiando en cualquier certificado: aquí se mira lo de dentro, no la CA. */
  async function secureTunnel(h: Harness): Promise<TLSSocket> {
    const socket = await tunnel(h.port, `localhost:${targetPort}`);
    return new Promise((done, fail) => {
      const secure = tlsConnect({ socket, servername: "localhost", rejectUnauthorized: false }, () => done(secure));
      secure.on("error", fail);
    });
  }
  const exchangeOver = (secure: TLSSocket, text: string, ms = 3_000): Promise<string> =>
    new Promise((done) => {
      let data = "";
      const timer = setTimeout(() => done(data), ms);
      secure.on("data", (chunk: Buffer) => (data += chunk.toString("latin1")));
      secure.on("close", () => {
        clearTimeout(timer);
        done(data);
      });
      secure.write(text);
    });

  test("dentro del túnel, una URL absoluta no cambia el destino y una que no se parsea va a la raíz", async () => {
    const h = await harness({ session: { decryptHttps: true }, extra: { mitm } });
    try {
      const first = await secureTunnel(h);
      // El destino de verdad es HTTP en claro: la conexión TLS del proxy con él falla, y se graba.
      const answer = await exchangeOver(first, "GET http://otro.test/ruta?x=1 HTTP/1.1\r\nHost: otro.test\r\nConnection: close\r\n\r\n");
      assert.match(answer, /^HTTP\/1.1 502/);
      const second = await secureTunnel(h);
      await exchangeOver(second, "OPTIONS * HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      await waitFor(() => h.exchanges.length === 2);
      assert.deepEqual(
        h.exchanges.map((exchange) => `${exchange.method} ${exchange.url}`),
        [`GET https://localhost:${targetPort}/ruta?x=1`, `OPTIONS https://localhost:${targetPort}/`],
      );
    } finally {
      await h.proxy.close();
    }
  });

  test("dentro del túnel, un WebSocket es un 501 y lo que no es HTTP cierra la conexión", async () => {
    const h = await harness({ session: { decryptHttps: true }, extra: { mitm } });
    try {
      const upgrade = await exchangeOver(
        await secureTunnel(h),
        "GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
      assert.match(upgrade, /^HTTP\/1.1 501 Not Implemented/);
      const garbage = await exchangeOver(await secureTunnel(h), "ESTO NO ES HTTP\r\n\r\n");
      assert.equal(garbage, "");
      assert.equal(h.exchanges.length, 0);
    } finally {
      await h.proxy.close();
    }
  });

  test("si la sesión caduca con el túnel abierto, lo que viene después no se atiende y se corta", async () => {
    const h = await harness({ session: { decryptHttps: true }, extra: { mitm } });
    try {
      const secure = await secureTunnel(h);
      h.clock.now = new Date(h.clock.now.getTime() + 120_000);
      const answer = await exchangeOver(secure, "GET /tarde HTTP/1.1\r\nHost: x\r\n\r\n");
      assert.equal(answer, "");
      assert.equal(h.exchanges.length, 0);
      assert.deepEqual(h.proxy.knownSessions(), []);
    } finally {
      await h.proxy.close();
    }
  });
});
