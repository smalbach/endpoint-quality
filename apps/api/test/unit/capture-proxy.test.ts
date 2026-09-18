/**
 * El proxy de captura, contra servidores de verdad en loopback.
 *
 * Lo que fijan: que reenvía y graba, que sin el token de la sesión no hace nada, que la guarda de
 * red se aplica igual que en el resto (loopback prohibido con la política cerrada), que los topes
 * cierran la sesión, que un túnel se graba sin contenido, y que la sesión caduca.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import type { AddressInfo } from "node:net";

import { CaptureProxy, tokenFrom, type ProxySession } from "@/modules/captures/infrastructure/capture-proxy";
import { captureItemFrom, type CaptureStopReason, type RawExchange } from "@/modules/captures/domain/model";
import { hashOpaqueToken } from "@/shared/crypto/opaque-token";

const TOKEN = "token-de-prueba-0123456789abcdef";
const OPEN = { allowPrivateTargets: true, maxRedirects: 0, timeoutMs: 3_000, maxResponseBytes: 1_000_000 };
const CLOSED = { ...OPEN, allowPrivateTargets: false };

let target: Server;
let targetPort: number;

before(async () => {
  target = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url === "/grande") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ relleno: "x".repeat(5_000) }));
      }
      res.writeHead(201, { "content-type": "application/json", "set-cookie": "sid=SESION-SECRETA; HttpOnly" });
      res.end(
        JSON.stringify({
          eco: Buffer.concat(chunks).length,
          proxyAuth: req.headers["proxy-authorization"] ?? null,
          accessToken: "RESPUESTA-SECRETA",
        }),
      );
    });
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  targetPort = (target.address() as AddressInfo).port;
});

after(async () => {
  target.closeAllConnections();
  await new Promise((resolve) => target.close(resolve));
});

type Harness = {
  proxy: CaptureProxy;
  port: number;
  exchanges: RawExchange[];
  stops: CaptureStopReason[];
  clock: { now: Date };
};

async function harness(
  policy = OPEN,
  limits = { durationMs: 60_000, maxRequests: 50, maxBodyBytes: 1_024 },
): Promise<Harness> {
  const exchanges: RawExchange[] = [];
  const stops: CaptureStopReason[] = [];
  const clock = { now: new Date("2026-03-01T10:00:00Z") };
  const proxy = new CaptureProxy({
    policy,
    now: () => clock.now,
    maxForwardBodyBytes: 100_000,
    tunnelIdleMs: 2_000,
    hooks: {
      onExchange: (_session, exchange) => exchanges.push(exchange),
      onStop: (_session, reason) => stops.push(reason),
    },
  });
  const port = await proxy.listen(0, "127.0.0.1");
  const session: ProxySession = {
    id: "s1",
    projectId: "p1",
    tokenHash: hashOpaqueToken(TOKEN),
    expiresAt: new Date(clock.now.getTime() + limits.durationMs),
    limits,
    recorded: 0,
  };
  proxy.open(session);
  return { proxy, port, exchanges, stops, clock };
}

const basic = (token: string) => `Basic ${Buffer.from(`captura:${token}`).toString("base64")}`;

function viaProxy(
  port: number,
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: options.method ?? "GET", path: url, headers: options.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

function connectVia(port: number, authority: string, token: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${token ? `Proxy-Authorization: ${basic(token)}\r\n` : ""}\r\n`,
      );
    });
    let data = "";
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("latin1");
      if (data.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(data.split("\r\n")[0]);
      }
    });
    socket.on("error", reject);
  });
}

describe("el proxy de captura", () => {
  test("reenvía, contesta lo del destino y graba la petición", async () => {
    const h = await harness();
    try {
      const answer = await viaProxy(h.port, `http://127.0.0.1:${targetPort}/pedidos?page=2`, {
        method: "POST",
        headers: {
          "Proxy-Authorization": basic(TOKEN),
          "Content-Type": "application/json",
          Authorization: "Bearer TOKEN-DEL-USUARIO",
          Cookie: "sid=COOKIE-DEL-USUARIO",
        },
        body: JSON.stringify({ nombre: "a", password: "hunter2" }),
      });
      assert.equal(answer.status, 201);
      const echoed = JSON.parse(answer.body);
      assert.equal(echoed.eco, JSON.stringify({ nombre: "a", password: "hunter2" }).length);
      // El token de la sesión no se le regala al destino.
      assert.equal(echoed.proxyAuth, null);

      assert.equal(h.exchanges.length, 1);
      const [seen] = h.exchanges;
      assert.equal(seen.method, "POST");
      assert.equal(seen.status, 201);
      assert.equal(seen.encrypted, false);
      assert.equal(seen.url, `http://127.0.0.1:${targetPort}/pedidos?page=2`);
      assert.ok(!Object.keys(seen.requestHeaders).some((name) => name.toLowerCase() === "proxy-authorization"));

      // Lo que llega a la fila, tapado.
      const item = captureItemFrom(seen, { sessionId: "s1", projectId: "p1", seq: 1 });
      const stored = JSON.stringify(item);
      for (const secret of [
        "TOKEN-DEL-USUARIO",
        "COOKIE-DEL-USUARIO",
        "hunter2",
        "SESION-SECRETA",
        "RESPUESTA-SECRETA",
        TOKEN,
      ]) {
        assert.ok(!stored.includes(secret), `${secret} no debería guardarse`);
      }
      assert.equal(item.requestHeaders.Authorization, "Bearer ••••••••");
      assert.equal(item.requestHeaders.Cookie, "••••••••");
      assert.equal(item.responseContentType, "application/json");
    } finally {
      await h.proxy.close();
    }
  });

  test("sin la credencial de la sesión, un 407 y nada reenviado ni grabado", async () => {
    const h = await harness();
    try {
      const none = await viaProxy(h.port, `http://127.0.0.1:${targetPort}/x`);
      assert.equal(none.status, 407);
      assert.match(String(none.headers["proxy-authenticate"]), /^Basic/);
      const wrong = await viaProxy(h.port, `http://127.0.0.1:${targetPort}/x`, {
        headers: { "Proxy-Authorization": basic("otro-token") },
      });
      assert.equal(wrong.status, 407);
      assert.equal(
        await connectVia(h.port, `127.0.0.1:${targetPort}`, null),
        "HTTP/1.1 407 Proxy Authentication Required",
      );
      assert.equal(h.exchanges.length, 0);
    } finally {
      await h.proxy.close();
    }
  });

  test("con la red privada cerrada, loopback no se alcanza ni por HTTP ni por túnel", async () => {
    const h = await harness(CLOSED);
    try {
      const answer = await viaProxy(h.port, `http://127.0.0.1:${targetPort}/x`, {
        headers: { "Proxy-Authorization": basic(TOKEN) },
      });
      assert.equal(answer.status, 403);
      assert.match(answer.body, /loopback/);
      // Un nombre que resuelve a loopback, igual.
      const named = await viaProxy(h.port, `http://localhost:${targetPort}/x`, {
        headers: { "Proxy-Authorization": basic(TOKEN) },
      });
      assert.equal(named.status, 403);
      assert.equal(await connectVia(h.port, `127.0.0.1:${targetPort}`, TOKEN), "HTTP/1.1 403 Forbidden");
      assert.equal(await connectVia(h.port, "169.254.169.254:443", TOKEN), "HTTP/1.1 403 Forbidden");
      // Se graban como rechazadas, para que la pantalla diga por qué no pasó nada.
      assert.equal(h.exchanges.length, 4);
      assert.ok(h.exchanges.every((exchange) => exchange.error && exchange.status === null));
    } finally {
      await h.proxy.close();
    }
  });

  test("un CONNECT abre el túnel y se graba solo el destino, marcado como cifrado", async () => {
    const h = await harness();
    try {
      assert.equal(await connectVia(h.port, `127.0.0.1:${targetPort}`, TOKEN), "HTTP/1.1 200 Connection Established");
      assert.equal(h.exchanges.length, 1);
      const [tunnel] = h.exchanges;
      assert.equal(tunnel.method, "CONNECT");
      assert.equal(tunnel.encrypted, true);
      assert.equal(tunnel.url, `https://127.0.0.1:${targetPort}`);
      assert.equal(tunnel.requestBody.length, 0);
      assert.equal(tunnel.responseBody.length, 0);
      assert.deepEqual(tunnel.requestHeaders, {});
    } finally {
      await h.proxy.close();
    }
  });

  test("el cuerpo se guarda hasta el tope y el cliente lo recibe entero", async () => {
    const h = await harness(OPEN, { durationMs: 60_000, maxRequests: 50, maxBodyBytes: 1_024 });
    try {
      const answer = await viaProxy(h.port, `http://127.0.0.1:${targetPort}/grande`, {
        headers: { "Proxy-Authorization": basic(TOKEN) },
      });
      assert.ok(answer.body.length > 5_000);
      assert.equal(h.exchanges[0].responseBodyTruncated, true);
      assert.ok(h.exchanges[0].responseBody.length <= 1_024);
    } finally {
      await h.proxy.close();
    }
  });

  test("al llegar al tope de peticiones la sesión se cierra y el token deja de servir", async () => {
    const h = await harness(OPEN, { durationMs: 60_000, maxRequests: 2, maxBodyBytes: 1_024 });
    try {
      const auth = { "Proxy-Authorization": basic(TOKEN) };
      assert.equal((await viaProxy(h.port, `http://127.0.0.1:${targetPort}/a`, { headers: auth })).status, 201);
      assert.equal((await viaProxy(h.port, `http://127.0.0.1:${targetPort}/b`, { headers: auth })).status, 201);
      assert.deepEqual(h.stops, ["request-limit"]);
      const third = await viaProxy(h.port, `http://127.0.0.1:${targetPort}/c`, { headers: auth });
      assert.equal(third.status, 407);
      assert.match(third.body, /terminó \(request-limit\)/);
      assert.equal(h.exchanges.length, 2);
    } finally {
      await h.proxy.close();
    }
  });

  test("la sesión caduca: pasado su tiempo, 407 y se avisa del cierre", async () => {
    const h = await harness();
    try {
      h.clock.now = new Date(h.clock.now.getTime() + 61_000);
      const answer = await viaProxy(h.port, `http://127.0.0.1:${targetPort}/x`, {
        headers: { "Proxy-Authorization": basic(TOKEN) },
      });
      assert.equal(answer.status, 407);
      assert.match(answer.body, /expired/);
      assert.deepEqual(h.stops, ["expired"]);
      assert.equal(h.proxy.liveCount(), 0);
    } finally {
      await h.proxy.close();
    }
  });

  test("parar desde fuera invalida el token al momento", async () => {
    const h = await harness();
    try {
      h.proxy.stop("s1", "manual");
      const answer = await viaProxy(h.port, `http://127.0.0.1:${targetPort}/x`, {
        headers: { "Proxy-Authorization": basic(TOKEN) },
      });
      assert.equal(answer.status, 407);
      // Cerrada desde fuera no se avisa: quien la cerró ya lo sabe.
      assert.deepEqual(h.stops, []);
    } finally {
      await h.proxy.close();
    }
  });

  test("abrirlo como página, sin forma de proxy, se explica en vez de reenviar", async () => {
    const h = await harness();
    try {
      const answer = await viaProxy(h.port, "/", { headers: { "Proxy-Authorization": basic(TOKEN) } });
      assert.equal(answer.status, 400);
      assert.match(answer.body, /proxy de captura/);
    } finally {
      await h.proxy.close();
    }
  });
});

describe("la credencial del proxy", () => {
  test("el token va en la contraseña del Basic; el usuario da igual", () => {
    assert.equal(tokenFrom(basic("abc")), "abc");
    assert.equal(tokenFrom(`Basic ${Buffer.from("abc").toString("base64")}`), "abc");
    assert.equal(tokenFrom("Bearer abc"), null);
    assert.equal(tokenFrom(undefined), null);
    assert.equal(tokenFrom(`Basic ${Buffer.from("usuario:").toString("base64")}`), null);
  });
});
