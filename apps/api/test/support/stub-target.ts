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
import type { IncomingMessage, ServerResponse } from "node:http";
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
  /** Answers 503 to the first N writes and then behaves. A target that is cold, rate-limited or
   * behind a queue that has not caught up — the only failure a retry is honest about. */
  flakyWrites?: number;
};

const SPEC = {
  openapi: "3.1.0",
  info: { title: "Stub", version: "1.0.0" },
  components: {
    schemas: {
      Thing: {
        type: "object",
        required: ["id", "name"],
        properties: { id: { type: "string" }, name: { type: "string" }, size: { type: "integer" } },
      },
      ThingEnvelope: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/Thing" } },
      },
      ThingList: {
        type: "object",
        required: ["data"],
        properties: { data: { type: "array", items: { $ref: "#/components/schemas/Thing" } } },
      },
      Credentials: {
        type: "object",
        required: ["email", "password"],
        properties: { email: { type: "string" }, password: { type: "string" } },
      },
      SessionEnvelope: {
        type: "object",
        required: ["data"],
        properties: {
          data: { type: "object", required: ["token"], properties: { token: { type: "string" } } },
        },
      },
      Problem: {
        type: "object",
        required: ["type", "title", "status"],
        properties: { type: { type: "string" }, title: { type: "string" }, status: { type: "integer" } },
      },
    },
  },
  paths: {
    "/things": {
      get: {
        operationId: "listThings",
        tags: ["Things"],
        responses: {
          "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/ThingList" } } } },
          "401": {},
        },
      },
      post: {
        operationId: "createThing",
        tags: ["Things"],
        // Declared, because a POST that takes a body and does not say so is a contract with a
        // hole in it — and because it is what lets a project with no `bodies` section send
        // anything at all. `id` is `readOnly`: the server makes it, and it must not be sent.
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "size"],
                properties: {
                  id: { type: "string", readOnly: true },
                  name: { type: "string" },
                  size: { type: "integer", minimum: 2 },
                },
              },
            },
          },
        },
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
    /** Lo que hace un destino de verdad: se inicia sesión contra él y lo demás gasta el token. */
    "/session": {
      post: {
        operationId: "createSession",
        tags: ["Session"],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Credentials" } } },
        },
        responses: {
          "201": { content: { "application/json": { schema: { $ref: "#/components/schemas/SessionEnvelope" } } } },
          "422": { content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
        },
      },
    },
  },
} as const;

/** Lo que devuelve `POST /session`, para que una prueba pueda comprobar qué cabecera se envió. */
export const SESSION_TOKEN = "sesion-de-la-corrida";

export const STUB_SPEC_YAML = JSON.stringify(SPEC);

export class StubTarget {
  private server!: Server;
  private things = new Map<string, Record<string, unknown>>();
  private nextId = 100;
  private flakedWrites = 0;
  /** `at` es lo que permite afirmar que dos peticiones se solaparon sin cronometrar la corrida
   * entera: con `slowMs`, dos llegadas más juntas que ese retardo estuvieron en vuelo a la vez. */
  readonly requests: {
    method: string;
    path: string;
    authorization: string | undefined;
    /** Every header, lowercased, so a test can assert that one somebody typed into the editor
     * actually crossed the wire. Kept whole rather than as a handful of named fields: the
     * question «¿llegó tal cual?» is the only one worth asking about a header, and an allowlist
     * would have to grow every time a test asks it about a different name. */
    headers: Record<string, string>;
    at: number;
  }[] = [];

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

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://stub");
    const method = request.method ?? "GET";
    // La cookie cuenta como credencial, como en cualquier API que sirva también a un navegador.
    // Sin esto, un flujo que inicia sesión y presenta la cookie no se podría probar contra este
    // destino, y la única forma de pasar la guarda sería fingir que la cookie es un bearer.
    const cookie = request.headers.cookie;
    const authorization = request.headers.authorization ?? (cookie?.includes("session=") ? cookie : undefined);
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [
        name,
        Array.isArray(value) ? value.join(", ") : (value ?? ""),
      ]),
    );
    this.requests.push({ method, path: url.pathname, authorization, headers, at: Date.now() });

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

    // Antes de la guarda de autenticación, porque iniciar sesión es lo que se hace sin tenerla.
    if (url.pathname === "/session" && method === "POST") {
      const body = await readJson(request);
      // Rechaza lo que no son credenciales, que es lo que hace que el caso de cuerpo inválido de
      // la matriz signifique algo: un destino que contesta 201 a cualquier cosa está roto.
      if (!body || typeof body.email !== "string" || typeof body.password !== "string") {
        return problem(422, "Credenciales inválidas");
      }
      // Un login de verdad suele contestar las dos cosas: el token en el cuerpo, para un cliente
      // que lo guarda, y la cookie, para un navegador. Con la fecha dentro, que lleva una coma y
      // es lo que parte una cookie mal leída.
      response.setHeader(
        "set-cookie",
        `session=${SESSION_TOKEN}; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT; HttpOnly, theme=oscuro; Path=/`,
      );
      return send(201, { data: { token: SESSION_TOKEN } });
    }

    if (this.faults.enforcesAuth) {
      if (!authorization) return problem(401, "No autenticado");
      // The read-only token authenticates and does not reach a write: that is the 403 the
      // authorization matrix exists to check.
      if (authorization.includes("solo-lectura") && method !== "GET") return problem(403, "Scope insuficiente");
    }

    if (this.faults.slowMs) await new Promise((resolve) => setTimeout(resolve, this.faults.slowMs));

    if (url.pathname === "/things" && method === "GET") {
      return send(
        200,
        this.faults.brokenEnvelope ? { items: [...this.things.values()] } : { data: [...this.things.values()] },
      );
    }

    if (url.pathname === "/things" && method === "POST") {
      if (this.faults.notImplemented) return send(405);
      if (this.flakedWrites < (this.faults.flakyWrites ?? 0)) {
        this.flakedWrites += 1;
        return problem(503, "No disponible todavía");
      }
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

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
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
