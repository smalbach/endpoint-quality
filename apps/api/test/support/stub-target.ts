/**
 * A target API the run engine can be pointed at.
 *
 * Not a mock of the runner: a real HTTP server on loopback, with a real OpenAPI document, that
 * can be told to misbehave in each of the specific ways an endpoint fails while still answering
 * 200. Those are the cases the whole product exists for, and a stubbed `fetch` would prove only
 * that the stub behaves.
 *
 * The faults are switched per instance rather than per request, so a test says "an API that
 * drops fields" and then runs the whole matrix against it.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type StubFaults = {
  /** Answers 200 with `{ items: [] }` instead of the declared envelope. The status is right and
   * the body is not, which is the failure a status-only check cannot see. */
  brokenEnvelope?: boolean;
  /** Accepts the write, stores nothing. Passes every check on its own response. */
  dropsFields?: boolean;
  /** Answers 204 to the DELETE and keeps serving the resource. */
  softDelete?: boolean;
  /** Sleeps before answering, to miss a latency budget. */
  slowMs?: number;
  /** Answers 405 to writes: the operation is declared and not routed. */
  notImplemented?: boolean;
  /** Answers `{ "error": "..." }` instead of Problem Details. */
  plainErrors?: boolean;
  /** Rejects everything without a credential, and 403 for the read-only token. */
  enforcesAuth?: boolean;
};

const SPEC = {
  openapi: "3.1.0",
  info: { title: "Stub", version: "1.0.0" },
  components: {
    schemas: {
      Thing: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" }, size: { type: "integer" } } },
      ThingEnvelope: { type: "object", required: ["data"], properties: { data: { $ref: "#/components/schemas/Thing" } } },
      ThingList: { type: "object", required: ["data"], properties: { data: { type: "array", items: { $ref: "#/components/schemas/Thing" } } } },
      Problem: { type: "object", required: ["type", "title", "status"], properties: { type: { type: "string" }, title: { type: "string" }, status: { type: "integer" } } },
    },
  },
  paths: {
    "/things": {
      get: { operationId: "listThings", tags: ["Things"], responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/ThingList" } } } }, "401": {} } },
      post: {
        operationId: "createThing",
        tags: ["Things"],
        responses: {
          "201": { content: { "application/json": { schema: { $ref: "#/components/schemas/ThingEnvelope" } } } },
          "401": {},
          "422": { content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
        },
      },
    },
    "/things/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      get: {
        operationId: "getThing",
        tags: ["Things"],
        responses: {
          "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/ThingEnvelope" } } } },
          "404": { content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
        },
      },
      delete: { operationId: "deleteThing", tags: ["Things"], responses: { "204": {}, "404": {} } },
    },
  },
} as const;

export const STUB_SPEC_YAML = JSON.stringify(SPEC);

export class StubTarget {
  private server!: Server;
  private things = new Map<string, Record<string, unknown>>();
  private nextId = 100;
  readonly requests: { method: string; path: string; authorization: string | undefined }[] = [];

  constructor(private readonly faults: StubFaults = {}) {}

  get origin(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async start(): Promise<void> {
    this.things.set("1", { id: "1", name: "semilla", size: 1 });
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    // `close()` stops accepting and then waits for existing connections to end. The runner uses
    // `fetch`, which keeps sockets alive, so without this the server never finishes closing and
    // the test process hangs at exit with every assertion already green — the worst kind of
    // failing suite, because it looks like a timeout rather than a leak.
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://stub");
    const method = request.method ?? "GET";
    const authorization = request.headers.authorization;
    this.requests.push({ method, path: url.pathname, authorization });

    const send = (status: number, body?: unknown, contentType = "application/json") => {
      if (body === undefined) {
        response.writeHead(status).end();
        return;
      }
      const payload = JSON.stringify(body);
      response.writeHead(status, { "content-type": contentType }).end(payload);
    };
    const problem = (status: number, title: string) =>
      this.faults.plainErrors
        ? send(status, { error: title })
        : send(status, { type: `https://stub/problems/${status}`, title, status }, "application/problem+json");

    if (url.pathname === "/openapi.json") return send(200, SPEC);

    if (this.faults.enforcesAuth) {
      if (!authorization) return problem(401, "No autenticado");
      // The read-only token authenticates and does not reach a write: that is the 403 the
      // authorization matrix exists to check.
      if (authorization.includes("solo-lectura") && method !== "GET") return problem(403, "Scope insuficiente");
    }

    if (this.faults.slowMs) await new Promise((resolve) => setTimeout(resolve, this.faults.slowMs));

    if (url.pathname === "/things" && method === "GET") {
      return send(200, this.faults.brokenEnvelope ? { items: [...this.things.values()] } : { data: [...this.things.values()] });
    }

    if (url.pathname === "/things" && method === "POST") {
      if (this.faults.notImplemented) return send(405);
      const body = await readJson(request);
      if (!body || Object.keys(body).length === 0) return problem(422, "Entidad no procesable");
      const id = String(this.nextId++);
      // The failure a 201 hides: the write is accepted and the fields are not kept.
      const stored = this.faults.dropsFields ? { id, name: "otra-cosa" } : { id, ...body };
      this.things.set(id, stored);
      return send(201, { data: stored });
    }

    const detail = /^\/things\/([^/]+)$/.exec(url.pathname);
    if (detail) {
      const id = decodeURIComponent(detail[1]);
      if (method === "GET") {
        const thing = this.things.get(id);
        return thing ? send(200, { data: thing }) : problem(404, "No encontrado");
      }
      if (method === "DELETE") {
        if (this.faults.notImplemented) return send(405);
        if (!this.things.has(id)) return problem(404, "No encontrado");
        // A soft delete that hides nothing: the DELETE reports success and the resource is still
        // there, which only the read-back after it can see.
        if (!this.faults.softDelete) this.things.delete(id);
        return send(204);
      }
    }

    return problem(404, "No encontrado");
  }
}

async function readJson(request: import("node:http").IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
