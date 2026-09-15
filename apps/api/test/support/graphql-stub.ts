/**
 * A GraphQL endpoint on loopback, for the `graphql` node's tests.
 *
 * A server of its own rather than a route added to `StubTarget`: every other run test reads that
 * target's request log and its 404s, and a route they never asked for is one more thing they would
 * have to not trip over. It also serves the stub contract at `/openapi.json`, so an environment can
 * point both its base URL and its spec here.
 *
 * What it answers is decided by the query text, which is all a test needs:
 * - mentions `broken` — 200 with `data: null` and an `errors` array, what a real server does with a
 *   field it does not know;
 * - mentions `thing` — `data.thing` built from the variables (`id`, `name: cosa-<id>`, `first`);
 * - anything else — `data.__typename`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { STUB_SPEC_YAML } from "./stub-target";

export class GraphqlStub {
  private server!: Server;
  /** Every call, headers lowercased and body parsed, so a test can assert what crossed the wire. */
  readonly requests: { method: string; path: string; headers: Record<string, string>; body: Record<string, unknown> | null }[] =
    [];

  get origin(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** The operations that reached `/graphql`, by the query text they carried. */
  operations(): Record<string, unknown>[] {
    return this.requests.filter((item) => item.path === "/graphql" && item.body).map((item) => item.body!);
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    // Same reason as StubTarget: the runner keeps sockets alive, and close() alone would wait on them.
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://stub");
    const method = request.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : (value ?? "")]),
    );
    const body = method === "POST" ? await readJson(request) : null;
    this.requests.push({ method, path: url.pathname, headers, body });
    const send = (status: number, payload: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    };

    if (url.pathname === "/openapi.json") return send(200, JSON.parse(STUB_SPEC_YAML));
    if (url.pathname !== "/graphql" || method !== "POST") return send(404, { error: "No encontrado" });

    const query = typeof body?.query === "string" ? body.query : "";
    const variables = (body?.variables ?? {}) as Record<string, unknown>;
    if (query.includes("broken")) {
      return send(200, { data: null, errors: [{ message: 'Cannot query field "broken" on type "Query".' }] });
    }
    if (query.includes("thing")) {
      return send(200, {
        data: { thing: { id: String(variables.id), name: `cosa-${String(variables.id)}`, first: variables.first ?? null } },
      });
    }
    return send(200, { data: { __typename: "Query" } });
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
