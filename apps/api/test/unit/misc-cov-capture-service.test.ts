/**
 * El servicio del proxy y los comandos de captura, por los caminos que la prueba HTTP no recorre:
 * apagado, puerto ocupado, la tabla que no deja escribir, la sincronización, y la importación
 * cuando el flujo no sale.
 */
import "reflect-metadata";
import { after, afterEach, before, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";

import { CaptureProxyService } from "@/modules/captures/infrastructure/capture-proxy.service";
import { CaptureAuthority } from "@/modules/captures/infrastructure/capture-authority";
import {
  DeleteCaptureCommand,
  DeleteCaptureHandler,
  ImportCaptureCommand,
  ImportCaptureHandler,
  StartCaptureCommand,
  StartCaptureHandler,
  StopCaptureCommand,
  StopCaptureHandler,
} from "@/modules/captures/application/commands/manage-captures";
import { captureItemFrom, type CaptureSession, type RawExchange } from "@/modules/captures/domain/model";
import { ImportPostmanFlowsCommand } from "@/modules/workflows/application/commands/import-postman-flows";
import { ImportAnythingCommand } from "@/modules/projects/application/commands/import-anything";
import type { Project } from "@/modules/projects/domain/model";
import { SystemClock } from "@/shared/clock/clock.port";
import { loadEnv, type Env } from "@/shared/config/env";
import { generateOpaqueToken, hashOpaqueToken } from "@/shared/crypto/opaque-token";
import { AesGcmSecretCipher } from "@/shared/crypto/secret-cipher";
import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { InMemoryCaptureAuthorityRepository, InMemoryCaptureRepository } from "../support/in-memory-captures";
import { InMemoryProjectRepository } from "../support/in-memory-repositories";
import { TEST_ENV } from "../support/test-app";

let target: Server;
let targetPort: number;

before(async () => {
  target = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((done) => target.listen(0, "127.0.0.1", done));
  targetPort = (target.address() as AddressInfo).port;
});

after(async () => {
  target.closeAllConnections();
  await new Promise((done) => target.close(done));
});

const env = loadEnv({ ...TEST_ENV, ALLOW_PRIVATE_TARGETS: "true" });
const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 3).toString("base64"));
let services: CaptureProxyService[] = [];

afterEach(async () => {
  mock.restoreAll();
  await Promise.all(services.map((service) => service.onModuleDestroy()));
  services = [];
});

function service(repository = new InMemoryCaptureRepository(), overrides: Partial<Env> = {}): CaptureProxyService {
  const settings = { ...env, ...overrides } as Env;
  const created = new CaptureProxyService(
    settings,
    repository,
    new SystemClock(),
    new CaptureAuthority(settings, cipher, new InMemoryCaptureAuthorityRepository()),
  );
  services.push(created);
  return created;
}

async function session(
  repository: InMemoryCaptureRepository,
  patch: Partial<CaptureSession> = {},
): Promise<{ session: CaptureSession; token: string }> {
  const token = generateOpaqueToken();
  const now = new Date();
  const row: CaptureSession = {
    id: randomUUID(),
    projectId: randomUUID(),
    status: "active",
    tokenHash: hashOpaqueToken(token),
    limits: { durationMs: 60_000, maxRequests: 50, maxBodyBytes: 1_024 },
    itemCount: 0,
    startedAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    stoppedAt: null,
    stopReason: null,
    startedBy: randomUUID(),
    decryptHttps: false,
    ...patch,
  };
  await repository.saveSession(row);
  return { session: row, token };
}

function viaProxy(port: number, token: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: `http://127.0.0.1:${targetPort}/x`,
        headers: { "Proxy-Authorization": `Basic ${Buffer.from(`captura:${token}`).toString("base64")}` },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", fail);
    req.end();
  });
}

describe("el servicio del proxy", () => {
  test("apagado: no abre, no arranca nada, y dice por qué", async () => {
    const off = service(undefined, { CAPTURE_PROXY_PORT: undefined });
    assert.equal(off.enabled, false);
    assert.equal(off.port, null);
    assert.equal(off.publicHost, null);
    await off.onApplicationBootstrap();
    assert.equal((off as unknown as { timer: unknown }).timer, null);
    await assert.rejects(off.open({} as CaptureSession), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.code, "capture-disabled");
      return true;
    });
  });

  test("antes de escuchar, el puerto es el configurado; el host público, el del despliegue", () => {
    const configured = service(undefined, { CAPTURE_PROXY_PORT: 18_080, CAPTURE_PROXY_PUBLIC_HOST: "captura.ejemplo.test" });
    assert.equal(configured.port, 18_080);
    assert.equal(configured.publicHost, "captura.ejemplo.test");
    assert.deepEqual(configured.limits(), {
      durationMs: env.CAPTURE_SESSION_MINUTES * 60_000,
      maxRequests: env.CAPTURE_MAX_REQUESTS,
      maxBodyBytes: env.CAPTURE_MAX_BODY_BYTES,
    });
  });

  test("un puerto ocupado es un 409 que lo dice; otro fallo al escuchar, uno genérico", async () => {
    const busy = createServer();
    await new Promise<void>((done) => busy.listen(0, "127.0.0.1", done));
    const port = (busy.address() as AddressInfo).port;
    try {
      const repository = new InMemoryCaptureRepository();
      const { session: row } = await session(repository);
      await assert.rejects(service(repository, { CAPTURE_PROXY_PORT: port }).open(row), (error: unknown) => {
        assert.ok(error instanceof ConflictError);
        assert.equal(error.code, "capture-proxy-unavailable");
        assert.match(error.message, new RegExp(`puerto ${port} .* ocupado`));
        return true;
      });
      await assert.rejects(
        service(repository, { CAPTURE_PROXY_HOST: "203.0.113.250" }).open(row),
        /No se pudo abrir el proxy de captura/,
      );
    } finally {
      await new Promise((done) => busy.close(done));
    }
  });

  test("al arrancar con descifrado sin cifrado válido, se anota el motivo y el proxy sigue", async () => {
    const errors = mock.method(Logger.prototype, "error", () => {});
    const repository = new InMemoryCaptureRepository();
    await session(repository);
    const settings = { ...env, CAPTURE_MITM: true, SECRETS_KEY: undefined } as Env;
    const withoutKey = new CaptureProxyService(
      settings,
      repository,
      new SystemClock(),
      new CaptureAuthority(settings, { encrypt: () => { throw new Error("sin SECRETS_KEY"); }, decrypt: (value) => value }, new InMemoryCaptureAuthorityRepository()),
    );
    services.push(withoutKey);
    await withoutKey.onApplicationBootstrap();
    assert.equal(errors.mock.callCount(), 1);
    assert.match(String(errors.mock.calls[0]!.arguments[0]), /SECRETS_KEY/);
    // Con una sesión abierta en la tabla, la primera sincronización ya abrió el puerto.
    assert.ok((withoutKey.port ?? 0) > 0);
    const timer = (withoutKey as unknown as { timer: NodeJS.Timeout }).timer;
    assert.equal(timer.hasRef(), false);
    await withoutKey.onModuleDestroy();
    assert.equal((withoutKey as unknown as { timer: unknown }).timer, null);
  });

  test("la sincronización cierra el puerto sin sesiones y corta las que otra instancia paró", async () => {
    const repository = new InMemoryCaptureRepository();
    const { session: row, token } = await session(repository);
    const proxy = service(repository);
    const port = await proxy.open(row);
    assert.equal((await viaProxy(port, token)).status, 200);
    // Otra instancia la para en la tabla.
    await repository.stopSession(row.projectId, row.id, "manual", new Date());
    await proxy.sync();
    const inner = (proxy as unknown as { proxy: { listening: boolean; knownSessions(): string[] } }).proxy;
    assert.equal(inner.listening, false);
    assert.deepEqual(inner.knownSessions(), []);
    // Y dos vueltas a la vez son la misma.
    assert.equal(proxy.sync(), proxy.sync());
    await proxy.sync();
  });

  test("una sesión cerrada sin motivo se dice como parada a mano; una caducada se cierra en la tabla", async () => {
    const repository = new InMemoryCaptureRepository();
    const { session: open } = await session(repository);
    const { token: stoppedToken } = await session(repository, { status: "stopped", stopReason: null });
    const { session: late, token: lateToken } = await session(repository, {
      expiresAt: new Date(Date.now() - 1_000),
    });
    const proxy = service(repository);
    // `open` no sincroniza: la caducada sigue «activa» en la tabla hasta que alguien la usa.
    const port = await proxy.open(open);
    const stopped = await viaProxy(port, stoppedToken);
    assert.equal(stopped.status, 407);
    assert.match(stopped.body, /terminó \(manual\)/);
    const expired = await viaProxy(port, lateToken);
    assert.equal(expired.status, 407);
    assert.match(expired.body, /expired/);
    const row = repository.sessions.get(late.id)!;
    assert.equal(row.status, "stopped");
    assert.equal(row.stopReason, "expired");
  });

  test("si la tabla ya no admite lo grabado, se corta sin inventar un motivo; si falla al escribir, se sigue", async () => {
    const repository = new InMemoryCaptureRepository();
    const { session: row, token } = await session(repository, { decryptHttps: undefined as unknown as boolean });
    const proxy = service(repository);
    const port = await proxy.open(row);

    repository.appendNext = async () => {
      throw new Error("disco lleno");
    };
    assert.equal((await viaProxy(port, token)).status, 200);
    await proxy.flush(row.id);

    repository.appendNext = async () => null;
    assert.equal((await viaProxy(port, token)).status, 200);
    await proxy.flush(row.id);
    // Cerrada para el proxy, pero en la tabla sigue como estaba: quien la cerró escribe el motivo.
    assert.equal(repository.sessions.get(row.id)!.status, "active");
    const again = await viaProxy(port, token);
    assert.equal(again.status, 200, "la siguiente vuelve a leer la tabla");
  });

  test("parar dos veces: la primera la cierra, la segunda ya no; flush sin escrituras no espera", async () => {
    const repository = new InMemoryCaptureRepository();
    const { session: row } = await session(repository);
    const proxy = service(repository);
    await proxy.open(row);
    await proxy.flush("sin-escrituras");
    assert.equal(await proxy.stop(row, "manual"), true);
    assert.equal(await proxy.stop(row, "manual"), false);
    assert.equal(repository.sessions.get(row.id)!.stopReason, "manual");
  });

  test("un token que no es de ninguna sesión es un 407; abrir durante una sincronización la espera", async () => {
    const repository = new InMemoryCaptureRepository();
    const { session: row } = await session(repository);
    const proxy = service(repository);
    // Sincronización y apertura a la vez: la apertura espera y el puerto queda abierto.
    const [, port] = await Promise.all([proxy.sync(), proxy.open(row)]);
    const answer = await viaProxy(port, generateOpaqueToken());
    assert.equal(answer.status, 407);
    assert.match(answer.body, /no es de ninguna sesión abierta/);
  });

  test("parar espera a que termine lo que se estaba grabando", async () => {
    const repository = new InMemoryCaptureRepository();
    const { session: row, token } = await session(repository);
    const proxy = service(repository);
    const port = await proxy.open(row);
    let started: () => void = () => {};
    const writing = new Promise<void>((done) => (started = done));
    let release: () => void = () => {};
    const original = repository.appendNext.bind(repository);
    repository.appendNext = async (item, max) => {
      started();
      await new Promise<void>((done) => (release = done));
      return original(item, max);
    };
    const answered = viaProxy(port, token);
    await writing;
    let flushed = false;
    const flushing = proxy.flush(row.id).then(() => (flushed = true));
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(flushed, false);
    release();
    await flushing;
    assert.equal((await answered).status, 200);
    assert.equal(repository.sessions.get(row.id)!.itemCount, 1);
  });

  test("un fallo al preparar la CA que no es un Error se anota con el motivo genérico", async () => {
    const errors = mock.method(Logger.prototype, "error", () => {});
    const authority = { enabled: true, ensure: () => Promise.reject("raro") };
    const odd = new CaptureProxyService(env, new InMemoryCaptureRepository(), new SystemClock(), authority as never);
    services.push(odd);
    await odd.onApplicationBootstrap();
    assert.equal(errors.mock.calls[0]!.arguments[0], "Descifrar HTTPS no pudo arrancar");
  });

  test("una tabla que falla al sincronizar no tumba ni el arranque, ni el reloj, ni abrir, ni parar, ni apagar", async () => {
    const repository = new InMemoryCaptureRepository();
    const { session: row } = await session(repository);
    let syncs = 0;
    repository.expireDue = async () => {
      syncs += 1;
      throw new Error("db caída");
    };
    const proxy = service(repository);
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      await proxy.onApplicationBootstrap();
      assert.equal(syncs, 1);
      mock.timers.tick(1_000);
      await new Promise((done) => setImmediate(done));
      assert.equal(syncs, 2);
    } finally {
      mock.timers.reset();
    }
    const failing = proxy.sync();
    const port = await proxy.open(row);
    await assert.rejects(failing, /db caída/);
    assert.ok(port > 0);
    assert.equal(await proxy.stop(row, "manual"), true);
    const again = proxy.sync();
    await proxy.onModuleDestroy();
    await assert.rejects(again, /db caída/);
  });

  test("si la sincronización no puede abrir el puerto, lo deja para la vuelta siguiente", async () => {
    const busy = createServer();
    await new Promise<void>((done) => busy.listen(0, "127.0.0.1", done));
    try {
      const repository = new InMemoryCaptureRepository();
      await session(repository);
      const proxy = service(repository, { CAPTURE_PROXY_PORT: (busy.address() as AddressInfo).port });
      await proxy.sync();
      assert.equal((proxy as unknown as { proxy: { listening: boolean } }).proxy.listening, false);
    } finally {
      await new Promise((done) => busy.close(done));
    }
  });

  test("apagar a mitad de una sincronización la espera", async () => {
    const repository = new InMemoryCaptureRepository();
    let release: () => void = () => {};
    const original = repository.expireDue.bind(repository);
    repository.expireDue = async (now) => {
      await new Promise<void>((done) => (release = done));
      return original(now);
    };
    const proxy = service(repository);
    const syncing = proxy.sync();
    const destroyed = proxy.onModuleDestroy();
    let finished = false;
    void destroyed.then(() => (finished = true));
    await new Promise((done) => setImmediate(done));
    assert.equal(finished, false);
    release();
    await syncing;
    await destroyed;
    assert.equal(finished, true);
  });
});

/* ------------------------------------------------------------------ *
 * Los comandos, con dobles
 * ------------------------------------------------------------------ */

const ORG = "org-1";
async function projects(): Promise<{ repository: InMemoryProjectRepository; project: Project }> {
  const repository = new InMemoryProjectRepository();
  const project = { id: randomUUID(), organizationId: ORG, archivedAt: null, deletedAt: null, name: "P" } as unknown as Project;
  await repository.save(project);
  return { repository, project };
}
const clock = { now: () => new Date("2026-03-01T10:00:00Z") };

function fakeProxy(patch: Record<string, unknown> = {}) {
  const stops: string[] = [];
  return {
    stops,
    proxy: {
      enabled: true,
      publicHost: null,
      limits: () => ({ durationMs: 60_000, maxRequests: 10, maxBodyBytes: 1_024 }),
      open: async () => 9_999,
      stop: async (session: { id: string }, reason: string) => {
        stops.push(`${session.id}:${reason}`);
        return true;
      },
      flush: async () => undefined,
      ...patch,
    },
  };
}

let seq = 0;
async function seed(
  repository: InMemoryCaptureRepository,
  sessionId: string,
  projectId: string,
  patch: Partial<RawExchange> & { url: string },
) {
  const item = captureItemFrom(
    {
      at: new Date("2026-03-01T10:00:00Z"),
      method: "GET",
      status: 200,
      encrypted: false,
      requestHeaders: {},
      requestBody: Buffer.alloc(0),
      requestBodyTruncated: false,
      responseHeaders: { "content-type": "application/json" },
      responseBody: Buffer.from("{}"),
      responseBodyTruncated: false,
      durationMs: 1,
      error: null,
      ...patch,
    },
    { sessionId, projectId, seq: ++seq },
  );
  await repository.appendItem(item);
  return item;
}

const tunnel = { method: "CONNECT", encrypted: true, status: null };

describe("los comandos de captura", () => {
  test("abrir sin captura en el despliegue es un 409 y no escribe nada", async () => {
    const { repository, project } = await projects();
    const captures = new InMemoryCaptureRepository();
    const { proxy } = fakeProxy({ enabled: false });
    const handler = new StartCaptureHandler(repository, captures, clock, proxy as never, {} as never);
    await assert.rejects(handler.execute(new StartCaptureCommand(ORG, project.id, "u")), /CAPTURE_PROXY_PORT/);
    assert.equal(captures.sessions.size, 0);
  });

  test("una sesión que no llega a escuchar no se queda activa", async () => {
    const { repository, project } = await projects();
    const captures = new InMemoryCaptureRepository();
    const { proxy } = fakeProxy({ open: () => Promise.reject(new ConflictError("ocupado", "capture-proxy-unavailable")) });
    const handler = new StartCaptureHandler(repository, captures, clock, proxy as never, {} as never);
    await assert.rejects(handler.execute(new StartCaptureCommand(ORG, project.id, "u")), /ocupado/);
    const [row] = captures.sessions.values();
    assert.equal(row!.status, "stopped");
    assert.equal(row!.stopReason, "manual");
  });

  test("parar una ya parada devuelve su vista sin tocar nada; parar o borrar una que no existe, 404", async () => {
    const { repository, project } = await projects();
    const captures = new InMemoryCaptureRepository();
    const { proxy, stops } = fakeProxy();
    const { session: row } = await session(captures, {
      projectId: project.id,
      status: "stopped",
      stopReason: "request-limit",
      stoppedAt: new Date("2026-03-01T10:05:00Z"),
    });
    const stop = new StopCaptureHandler(repository, captures, proxy as never);
    const view = await stop.execute(new StopCaptureCommand(ORG, project.id, row.id));
    assert.equal(view.stopReason, "request-limit");
    assert.deepEqual(stops, []);
    await assert.rejects(stop.execute(new StopCaptureCommand(ORG, project.id, "no-existe")), NotFoundError);
    const remove = new DeleteCaptureHandler(repository, captures, proxy as never);
    await assert.rejects(remove.execute(new DeleteCaptureCommand(ORG, project.id, "no-existe")), NotFoundError);
  });

  async function importing(execute: (command: unknown) => Promise<unknown>) {
    const { repository, project } = await projects();
    const captures = new InMemoryCaptureRepository();
    const { proxy } = fakeProxy();
    const { session: row } = await session(captures, { projectId: project.id });
    const bus = { execute: mock.fn(execute) };
    const handler = new ImportCaptureHandler(bus as never, repository, captures, clock, proxy as never);
    const run = (itemIds: string[], flow = false) =>
      handler.execute(new ImportCaptureCommand(ORG, project.id, row.id, { itemIds, flow }, "u"));
    return { captures, project, row, bus, run, handler };
  }

  const endpointsResult = () => ({
    dryRun: false,
    items: [{ name: "captura.har", kind: "har", results: [{ target: "endpoints", name: "x", summary: null, error: null }] }],
  });

  test("importar de una sesión que no existe, o sin nada elegido que exista, se dice", async () => {
    const { run, handler, project } = await importing(async () => endpointsResult());
    await assert.rejects(
      handler.execute(new ImportCaptureCommand(ORG, project.id, "no-existe", { itemIds: [] }, "u")),
      NotFoundError,
    );
    await assert.rejects(run(["no-existe"]), (error: unknown) => {
      assert.ok(error instanceof InvalidInputError);
      assert.equal(error.code, "nothing-to-import");
      return true;
    });
  });

  test("varios túneles solos: el motivo en plural", async () => {
    const { run, captures, project, row } = await importing(async () => endpointsResult());
    const a = await seed(captures, row.id, project.id, { url: "https://a.test:443", ...tunnel });
    const b = await seed(captures, row.id, project.id, { url: "https://b.test:443", ...tunnel });
    await assert.rejects(run([a.id, b.id, a.id]), (error: unknown) => {
      assert.ok(error instanceof InvalidInputError);
      assert.equal(error.code, "capture-only-tunnels");
      assert.match(JSON.stringify(error), /2 túneles: cifrado, sin detalle/);
      return true;
    });
  });

  test("con varios túneles al lado, la nota va en plural y se suma a las que hubiera", async () => {
    const result = endpointsResult();
    (result.items[0]!.results[0] as { notes?: string[] }).notes = ["una nota previa"];
    const { run, captures, project, row, bus } = await importing(async () => result);
    const api = await seed(captures, row.id, project.id, { url: "https://api.test/v1/pedidos" });
    const t1 = await seed(captures, row.id, project.id, { url: "https://a.test:443", ...tunnel });
    const t2 = await seed(captures, row.id, project.id, { url: "https://b.test:443", ...tunnel });
    const answer = await run([api.id, t1.id, t2.id]);
    assert.deepEqual((answer.items[0]!.results[0] as { notes: string[] }).notes, [
      "una nota previa",
      "2 túneles HTTPS no se importan: cifrado, sin detalle",
    ]);
    const command = bus.execute.mock.calls[0]!.arguments[0] as ImportAnythingCommand;
    assert.ok(command instanceof ImportAnythingCommand);
  });

  test("un túnel sin resultado de endpoints no deja nota, y sin resultados no hay flujo que crear", async () => {
    const { run, captures, project, row, bus } = await importing(async (command) =>
      command instanceof ImportAnythingCommand
        ? { dryRun: false, items: [] }
        : { flows: [], notes: [] },
    );
    const api = await seed(captures, row.id, project.id, { url: "https://api.test/v1/pedidos" });
    const t1 = await seed(captures, row.id, project.id, { url: "https://a.test:443", ...tunnel });
    const answer = await run([api.id, t1.id], true);
    assert.deepEqual(answer.items, []);
    assert.equal(bus.execute.mock.callCount(), 1);
  });

  test("un flujo sin peticiones de la API se dice en vez de crear uno vacío", async () => {
    const { run, captures, project, row, bus } = await importing(async () => endpointsResult());
    const bundle = await seed(captures, row.id, project.id, {
      url: "https://app.test/main.js",
      responseHeaders: { "content-type": "text/javascript" },
    });
    const answer = await run([bundle.id], true);
    const flows = answer.items[0]!.results.find((entry) => entry.target === "flows")!;
    assert.match(flows.error ?? "", /el flujo quedaría vacío/);
    assert.equal(bus.execute.mock.callCount(), 1);
  });

  test("un flujo que ya existía se cuenta como actualizado, y uno que falla deja su error", async () => {
    const failures: unknown[] = [];
    const { run, captures, project, row } = await importing(async (command) => {
      if (command instanceof ImportAnythingCommand) return endpointsResult();
      assert.ok(command instanceof ImportPostmanFlowsCommand);
      if (failures.length) throw failures.shift();
      return { flows: [{ name: "Captura", action: "updated", steps: 2 }, { name: "Otra", action: "created", steps: 1 }], notes: ["n"] };
    });
    const api = await seed(captures, row.id, project.id, { url: "https://api.test/v1/pedidos" });

    const updated = await run([api.id], true);
    const flows = updated.items[0]!.results.find((entry) => entry.target === "flows")!;
    assert.equal(flows.summary, "Captura (actualizado, 2 nodos) · Otra (nuevo, 1 nodos)");
    assert.deepEqual(flows.notes, ["n"]);

    failures.push(new Error("colección inválida"));
    const failed = await run([api.id], true);
    assert.equal(failed.items[0]!.results.find((entry) => entry.target === "flows")!.error, "colección inválida");

    failures.push("nada");
    const odd = await run([api.id], true);
    assert.equal(odd.items[0]!.results.find((entry) => entry.target === "flows")!.error, "No se pudo crear el flujo");
  });
});
