/**
 * El proxy de captura con varias instancias de la API detrás: dos servicios, una sola «tabla».
 *
 * Lo que fijan: que una sesión abierta en una instancia se atiende en otra (el token se busca en la
 * tabla, no en la memoria del proceso que la abrió), que la otra abre su puerto al ver una sesión
 * abierta y lo cierra al no ver ninguna, que parar en una instancia deja el token sin valor en la
 * otra en menos de lo que dura la caché, y que la cuenta y el tope aguantan peticiones a la vez por
 * las dos: ni se pasa del tope ni se repite un `seq`.
 */
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

import { CaptureProxyService } from "@/modules/captures/infrastructure/capture-proxy.service";
import type { CaptureSession } from "@/modules/captures/domain/model";
import { SystemClock } from "@/shared/clock/clock.port";
import { loadEnv } from "@/shared/config/env";
import { generateOpaqueToken, hashOpaqueToken } from "@/shared/crypto/opaque-token";
import { InMemoryCaptureRepository } from "../support/in-memory-captures";
import { TEST_ENV } from "../support/test-app";

let target: Server;
let targetPort: number;

before(async () => {
  target = createServer((_req, res) => {
    // Un poco de espera, para que las peticiones a la vez se solapen de verdad.
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    }, 5);
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  targetPort = (target.address() as AddressInfo).port;
});

after(async () => {
  target.closeAllConnections();
  await new Promise((resolve) => target.close(resolve));
});

// La red privada abierta: el destino de prueba está en loopback.
const env = loadEnv({ ...TEST_ENV, ALLOW_PRIVATE_TARGETS: "true" });
let services: CaptureProxyService[] = [];

afterEach(async () => {
  await Promise.all(services.map((service) => service.onModuleDestroy()));
  services = [];
});

function instances(repository: InMemoryCaptureRepository): [CaptureProxyService, CaptureProxyService] {
  const pair: [CaptureProxyService, CaptureProxyService] = [
    new CaptureProxyService(env, repository, new SystemClock()),
    new CaptureProxyService(env, repository, new SystemClock()),
  ];
  services.push(...pair);
  return pair;
}

async function openSession(
  repository: InMemoryCaptureRepository,
  maxRequests = 50,
): Promise<{ session: CaptureSession; token: string }> {
  const token = generateOpaqueToken();
  const now = new Date();
  const session: CaptureSession = {
    id: randomUUID(),
    projectId: randomUUID(),
    status: "active",
    tokenHash: hashOpaqueToken(token),
    limits: { durationMs: 60_000, maxRequests, maxBodyBytes: 1_024 },
    itemCount: 0,
    startedAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    stoppedAt: null,
    stopReason: null,
    startedBy: randomUUID(),
  };
  await repository.saveSession(session);
  return { session, token };
}

function viaProxy(port: number, path: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers = { "Proxy-Authorization": `Basic ${Buffer.from(`captura:${token}`).toString("base64")}` };
    const req = httpRequest({ host: "127.0.0.1", port, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("el proxy de captura con varias instancias", () => {
  test("la sesión abierta en una instancia se atiende en la otra, y parar en una la corta en la otra", async () => {
    const repository = new InMemoryCaptureRepository();
    const [a, b] = instances(repository);
    const { session, token } = await openSession(repository);
    await a.open(session);

    // La otra instancia no sabía nada: abre su puerto al ver la sesión en la tabla.
    await b.sync();
    const portB = b.port!;
    assert.notEqual(portB, a.port);
    const answer = await viaProxy(portB, `http://127.0.0.1:${targetPort}/pedidos`, token);
    assert.equal(answer.status, 200);
    assert.equal(repository.sessions.get(session.id)!.itemCount, 1);
    assert.deepEqual(
      [...repository.items.values()].map((item) => [item.seq, item.sessionId]),
      [[1, session.id]],
    );

    // Parar en A. B tenía la credencial recordada, y aun así deja de valer en menos de 2 s.
    await a.stop(session, "manual");
    const started = Date.now();
    let status = 200;
    while (status !== 407 && Date.now() - started < 2_500) {
      status = (await viaProxy(portB, `http://127.0.0.1:${targetPort}/otra`, token)).status;
      if (status !== 407) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status, 407);
    assert.ok(Date.now() - started <= 2_000, "el «Parar» de otra instancia llega en lo que dura la caché");
    assert.match((await viaProxy(portB, `http://127.0.0.1:${targetPort}/x`, token)).body, /terminó \(manual\)/);

    // Y sin sesiones abiertas, B cierra su puerto en la siguiente vuelta.
    await b.sync();
    await assert.rejects(viaProxy(portB, `http://127.0.0.1:${targetPort}/x`, token));
  });

  test("peticiones a la vez por las dos instancias: el tope se respeta y ningún seq se repite", async () => {
    const repository = new InMemoryCaptureRepository();
    const [a, b] = instances(repository);
    const { session, token } = await openSession(repository, 5);
    const portA = await a.open(session);
    await b.sync();
    const portB = b.port!;

    const answers = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        viaProxy(index % 2 ? portA : portB, `http://127.0.0.1:${targetPort}/n/${index}`, token).catch(() => ({
          status: 0,
          body: "",
        })),
      ),
    );
    const items = [...repository.items.values()].filter((item) => item.sessionId === session.id);
    assert.equal(items.length, 5);
    assert.deepEqual(
      items.map((item) => item.seq).sort((x, y) => x - y),
      [1, 2, 3, 4, 5],
    );
    const row = repository.sessions.get(session.id)!;
    assert.equal(row.itemCount, 5);
    assert.equal(row.status, "stopped");
    assert.equal(row.stopReason, "request-limit");
    assert.ok(answers.some((answer) => answer.status === 200));
    // Después del tope, ninguna de las dos lo atiende.
    await a.sync();
    await b.sync();
    const late = await viaProxy(portB, `http://127.0.0.1:${targetPort}/tarde`, token).catch(() => null);
    assert.ok(late === null || late.status === 407);
  });

  test("una sesión que caduca la cierra la sincronización de cualquier instancia", async () => {
    const repository = new InMemoryCaptureRepository();
    const [a] = instances(repository);
    const { session } = await openSession(repository);
    repository.sessions.get(session.id)!.expiresAt = new Date(Date.now() - 1_000);
    await a.sync();
    const row = repository.sessions.get(session.id)!;
    assert.equal(row.status, "stopped");
    assert.equal(row.stopReason, "expired");
  });
});
