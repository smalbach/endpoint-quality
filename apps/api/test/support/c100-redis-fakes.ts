/**
 * Un Redis y un BullMQ de mentira, en el mismo proceso, para probar los adaptadores de Redis sin un
 * Redis de verdad.
 *
 * Importar este módulo **antes** que el adaptador deja `require("ioredis")` apuntando a
 * `FakeRedis`: el adaptador compilado lo pide por nombre y el caché de módulos de Node contesta con
 * esto. Solo cubre lo que usan los adaptadores —conectar, caer y volver, pub/sub, los dos guiones de
 * los límites, `quit`— pero con el comportamiento que importa: los clientes de la misma URL comparten
 * «servidor», `PUBLISH` dice cuántos lo oyeron, lo publicado llega en un turno posterior y sin cola
 * fuera de línea un cliente sin conexión falla en el acto.
 *
 * BullMQ no está instalado, a propósito. `installFakeBullmq()` hace que `require("bullmq")` lo
 * encuentre; `uninstallFakeBullmq()` lo quita, para probar el error de cuando falta.
 */
import { EventEmitter } from "node:events";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require("node:module") as {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};

type Entry = { value: string; expiresAt: number | null };

/** Lo que comparten los clientes de una misma URL: sus canales y sus claves. */
export class FakeRedisServer {
  up = true;
  readonly clients = new Set<FakeRedis>();
  readonly channels = new Map<string, Set<FakeRedis>>();
  readonly data = new Map<string, Entry>();
  /** Si no es null, cada orden de este tipo falla con esto (un `Error` o, a propósito, un texto). */
  failEval: unknown = null;
  failPublish: unknown = null;
  failSubscribe: unknown = null;
  failQuit: unknown = null;

  /** Redis se cae: cada cliente vivo pierde la conexión y lo dice con "error". */
  stop(error: unknown = new Error("connect ECONNREFUSED 127.0.0.1:6379")): void {
    this.up = false;
    for (const client of this.clients) client.lose(error);
  }

  /** Redis vuelve: cada cliente vivo reconecta y lo dice con "ready". */
  start(): void {
    this.up = true;
    for (const client of this.clients) client.connect();
  }

  get(key: string): string | null {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }

  pttl(key: string): number {
    const entry = this.get(key) === null ? undefined : this.data.get(key);
    if (!entry) return -2;
    return entry.expiresAt === null ? -1 : entry.expiresAt - Date.now();
  }
}

const servers = new Map<string, FakeRedisServer>();

export function fakeRedisServer(url: string): FakeRedisServer {
  let server = servers.get(url);
  if (!server) {
    server = new FakeRedisServer();
    servers.set(url, server);
  }
  return server;
}

type Options = { retryStrategy?: (times: number) => number; enableOfflineQueue?: boolean } & Record<string, unknown>;

export class FakeRedis extends EventEmitter {
  status = "connecting";
  readonly server: FakeRedisServer;
  /** Lo que devolvió `retryStrategy` en cada reintento: el plazo que ioredis esperaría. */
  readonly retryDelays: number[] = [];
  private attempts = 0;

  constructor(
    readonly url: string,
    readonly options: Options = {},
  ) {
    super();
    this.server = fakeRedisServer(url);
    this.server.clients.add(this);
    setImmediate(() => this.connect());
  }

  connect(): void {
    if (this.status === "end") return;
    if (!this.server.up) return this.lose(new Error("connect ECONNREFUSED 127.0.0.1:6379"));
    this.status = "ready";
    this.attempts = 0;
    this.emit("ready");
  }

  lose(error: unknown): void {
    if (this.status === "end") return;
    this.status = "reconnecting";
    this.attempts += 1;
    if (this.options.retryStrategy) this.retryDelays.push(this.options.retryStrategy(this.attempts));
    this.emit("error", error);
  }

  private offline(): Promise<never> {
    return Promise.reject(new Error("Stream isn't writeable and enableOfflineQueue options is false"));
  }

  async publish(channel: string, message: string): Promise<number> {
    if (this.status !== "ready") return this.offline();
    if (this.server.failPublish !== null) throw this.server.failPublish;
    const listeners = [...(this.server.channels.get(channel) ?? [])];
    setImmediate(() => {
      for (const client of listeners) if (client.status !== "end") client.emit("message", channel, message);
    });
    return listeners.length;
  }

  async subscribe(...channels: string[]): Promise<number> {
    if (this.server.failSubscribe !== null) throw this.server.failSubscribe;
    for (const channel of channels) {
      const set = this.server.channels.get(channel) ?? new Set();
      set.add(this);
      this.server.channels.set(channel, set);
    }
    return channels.length;
  }

  async eval(script: string, _numKeys: number, key: string, ...args: string[]): Promise<unknown> {
    if (this.status !== "ready") return this.offline();
    if (this.server.failEval !== null) throw this.server.failEval;
    const server = this.server;
    if (script.includes("INCR")) {
      const hits = Number(server.get(key) ?? "0") + 1;
      let ttl = server.pttl(key);
      const expiresAt = ttl < 0 ? Date.now() + Number(args[0]) : server.data.get(key)!.expiresAt;
      if (ttl < 0) ttl = Number(args[0]);
      server.data.set(key, { value: String(hits), expiresAt });
      return [hits, ttl];
    }
    const hits = server.get(key);
    if (hits === null) return null;
    const ttl = server.pttl(key);
    if (ttl < 0) return null;
    return [Number(hits), ttl];
  }

  async quit(): Promise<string> {
    this.status = "end";
    this.server.clients.delete(this);
    for (const set of this.server.channels.values()) set.delete(this);
    if (this.server.failQuit !== null) throw this.server.failQuit;
    return "OK";
  }

  /** Como el de verdad: corta la reconexión, incluso si `quit` ya falló. Es lo que se llama al cerrar. */
  disconnect(): void {
    this.status = "end";
    this.server.clients.delete(this);
    for (const set of this.server.channels.values()) set.delete(this);
  }
}

// El adaptador compilado hace `require("ioredis").Redis`.
const ioredisPath = require.resolve("ioredis");
require.cache[ioredisPath] = {
  id: ioredisPath,
  filename: ioredisPath,
  loaded: true,
  exports: { Redis: FakeRedis, default: FakeRedis },
} as unknown as NodeJS.Module;

// ---------------------------------------------------------------------------------------------
// BullMQ

type Job = { id: string; data: { runId: string }; state: "waiting" | "active" | "completed" | "failed" };

/** Un cliente de claves con `EX`, como el que BullMQ expone en `queue.client`. */
export class FakeKv {
  readonly data = new Map<string, { value: string; ttlSeconds: number | null }>();
  async set(key: string, value: string, mode?: string, seconds?: number): Promise<"OK"> {
    this.data.set(key, { value, ttlSeconds: mode === "EX" ? (seconds ?? null) : null });
    return "OK";
  }
  async get(key: string): Promise<string | null> {
    return this.data.get(key)?.value ?? null;
  }
  async del(key: string): Promise<number> {
    return this.data.delete(key) ? 1 : 0;
  }
}

/** Lo que comparten la cola y los trabajadores de un mismo nombre. */
export class FakeBroker {
  readonly jobs = new Map<string, Job>();
  readonly queues: FakeQueue[] = [];
  readonly workers: FakeWorker[] = [];
  readonly kv = new FakeKv();

  dispatch(): void {
    const worker = this.workers.find((candidate) => !candidate.closed);
    if (!worker) return;
    for (const job of this.jobs.values()) if (job.state === "waiting") void worker.run(job);
  }
}

export const brokers = new Map<string, FakeBroker>();
export function fakeBroker(name: string): FakeBroker {
  let broker = brokers.get(name);
  if (!broker) {
    broker = new FakeBroker();
    brokers.set(name, broker);
  }
  return broker;
}

export class FakeQueue {
  closed = false;
  readonly broker: FakeBroker;
  readonly added: { name: string; data: unknown; options: Record<string, unknown> }[] = [];
  constructor(
    readonly name: string,
    readonly options: { connection: { url: string } },
  ) {
    this.broker = fakeBroker(name);
    this.broker.queues.push(this);
  }
  get client(): Promise<FakeKv> {
    return Promise.resolve(this.broker.kv);
  }
  async add(name: string, data: { runId: string }, options: { jobId: string } & Record<string, unknown>) {
    this.added.push({ name, data, options });
    // Mismo jobId, mismo trabajo: BullMQ no lo duplica.
    if (!this.broker.jobs.has(options.jobId)) {
      this.broker.jobs.set(options.jobId, { id: options.jobId, data, state: "waiting" });
      setImmediate(() => this.broker.dispatch());
    }
    return { id: options.jobId };
  }
  /** Como BullMQ: quitar un trabajo en marcha falla, porque está bloqueado por su trabajador. */
  async remove(jobId: string): Promise<number> {
    const job = this.broker.jobs.get(jobId);
    if (job?.state === "active") throw new Error(`Job ${jobId} could not be removed because it is locked`);
    return this.broker.jobs.delete(jobId) ? 1 : 0;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeWorker extends EventEmitter {
  closed = false;
  readonly broker: FakeBroker;
  constructor(
    readonly name: string,
    readonly processor: (job: { id: string; data: { runId: string } }) => Promise<unknown>,
    readonly options: { connection: { url: string }; concurrency: number },
  ) {
    super();
    this.broker = fakeBroker(name);
    this.broker.workers.push(this);
    setImmediate(() => this.broker.dispatch());
  }
  async run(job: Job): Promise<void> {
    job.state = "active";
    try {
      await this.processor({ id: job.id, data: job.data });
      job.state = "completed";
      this.broker.jobs.delete(job.id);
    } catch (error) {
      job.state = "failed";
      this.emit("failed", job, error);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

const BULLMQ_PATH = `${__dirname}/c100-redis-fake-bullmq.js`;
const originalResolve = Module._resolveFilename;
let bullmqInstalled = false;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === "bullmq" && bullmqInstalled) return BULLMQ_PATH;
  return originalResolve.call(this, request, ...rest);
};
require.cache[BULLMQ_PATH] = {
  id: BULLMQ_PATH,
  filename: BULLMQ_PATH,
  loaded: true,
  exports: { Queue: FakeQueue, Worker: FakeWorker },
} as unknown as NodeJS.Module;

export function installFakeBullmq(): void {
  bullmqInstalled = true;
}
export function uninstallFakeBullmq(): void {
  bullmqInstalled = false;
}
