/**
 * Los mocks por sus bordes: los topes y los nombres repetidos al crear y renombrar, la clave que
 * aparece al pasar a privado, y la URL pública cuando la petición o la bitácora vienen raras.
 */
import "reflect-metadata";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  CreateMockCommand,
  CreateMockHandler,
  DeleteMockCommand,
  DeleteMockHandler,
  RotateMockKeyCommand,
  RotateMockKeyHandler,
  UpdateMockCommand,
  UpdateMockHandler,
} from "@/modules/mocks/application/commands/manage-mocks";
import { MAX_MOCKS_PER_PROJECT } from "@/modules/mocks/domain/model";
import { MockServeController } from "@/modules/mocks/presentation/mock-serve.controller";
import type { MockAnswer } from "@/modules/mocks/application/queries/answer-mock";
import { type AnswerMockQuery } from "@/modules/mocks/application/queries/answer-mock";
import { RecordMockCallCommand } from "@/modules/mocks/application/commands/record-mock-call";
import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import type { Project } from "@/modules/projects/domain/model";
import { InMemoryMockRepository } from "../support/in-memory-mocks";
import { InMemoryProjectRepository } from "../support/in-memory-repositories";

const ORG = "org-1";
const clock = { now: () => new Date("2026-03-01T10:00:00Z") };

async function setup() {
  const projects = new InMemoryProjectRepository();
  await projects.save({ id: "p-1", organizationId: ORG, archivedAt: null, deletedAt: null } as unknown as Project);
  const mocks = new InMemoryMockRepository();
  const create = new CreateMockHandler(projects, mocks, clock);
  const update = new UpdateMockHandler(projects, mocks, clock);
  const make = (name: string, visibility: "public" | "private" = "public") =>
    create.execute(new CreateMockCommand(ORG, "p-1", name, visibility, undefined, "u"));
  const change = (id: string, input: ConstructorParameters<typeof UpdateMockCommand>[3]) =>
    update.execute(new UpdateMockCommand(ORG, "p-1", id, input));
  return { projects, mocks, make, change };
}

const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof ConflictError || error instanceof NotFoundError || error instanceof InvalidInputError);
  assert.equal((error as { code?: string }).code, expected);
  return true;
};

describe("gestionar mocks", () => {
  test("crear: un nombre repetido (con espacios) y el tope de mocks son 409", async () => {
    const { make } = await setup();
    const first = await make("  front  ");
    assert.equal(first.mock.name, "front");
    await assert.rejects(make("front "), code("mock-duplicate-name"));
    for (let index = 1; index < MAX_MOCKS_PER_PROJECT; index += 1) await make(`m${index}`);
    await assert.rejects(make("uno más"), code("mocks-full"));
  });

  test("cambiar: un mock que no existe es un 404 y un nombre vacío un 422", async () => {
    const { make, change } = await setup();
    await assert.rejects(change("no-existe", { name: "x" }), NotFoundError);
    const created = await make("a");
    await assert.rejects(change(created.mock.id, { name: "   " }), InvalidInputError);
  });

  test("renombrar a un nombre de otro es un 409; al suyo propio, o sin nombre, no pregunta", async () => {
    const { make, change } = await setup();
    const a = await make("a");
    await make("b");
    await assert.rejects(change(a.mock.id, { name: " b " }), code("mock-duplicate-name"));
    const same = await change(a.mock.id, { name: "a", enabled: false });
    assert.equal(same.name, "a");
    assert.equal(same.enabled, false);
    const untouched = await change(a.mock.id, {});
    assert.equal(untouched.name, "a");
    assert.equal(untouched.enabled, false);
    assert.equal(untouched.visibility, "public");
    assert.equal("apiKey" in untouched, false);
  });

  test("pasar a privado un mock sin clave crea una y la enseña esa vez; otra vuelta ya no", async () => {
    const { make, change, mocks } = await setup();
    const created = await make("abierto");
    assert.equal(created.apiKey, null);
    const closed = await change(created.mock.id, { visibility: "private", delay: { kind: "fixed", ms: 10 } });
    assert.ok(closed.apiKey && closed.apiKey.length >= 32);
    assert.deepEqual(closed.delay, { kind: "fixed", ms: 10 });
    const hash = (await mocks.findById("p-1", created.mock.id))!.apiKeyHash;
    assert.ok(hash);
    // Público y privado otra vez: la clave de siempre, sin enseñarla de nuevo.
    await change(created.mock.id, { visibility: "public" });
    const again = await change(created.mock.id, { visibility: "private" });
    assert.equal("apiKey" in again, false);
    assert.equal((await mocks.findById("p-1", created.mock.id))!.apiKeyHash, hash);
  });

  test("rotar o borrar un mock que no existe es un 404", async () => {
    const { projects, mocks } = await setup();
    await assert.rejects(
      new RotateMockKeyHandler(projects, mocks, clock).execute(new RotateMockKeyCommand(ORG, "p-1", "no")),
      code("mock-not-found"),
    );
    await assert.rejects(
      new DeleteMockHandler(projects, mocks).execute(new DeleteMockCommand(ORG, "p-1", "no")),
      code("mock-not-found"),
    );
  });
});

/* ------------------------------------------------------------------ *
 * La URL pública, con dobles de Express
 * ------------------------------------------------------------------ */

type FakeResponse = {
  headers: Map<string, unknown>;
  statusCode: number;
  body: unknown;
  ended: boolean;
  contentType?: string;
  setHeader(name: string, value: unknown): FakeResponse;
  removeHeader(name: string): void;
  status(code: number): FakeResponse;
  type(value: string): FakeResponse;
  json(value: unknown): FakeResponse;
  send(value: unknown): FakeResponse;
  end(): FakeResponse;
};

function fakeResponse(reject: (name: string) => boolean = () => false): FakeResponse {
  const response: FakeResponse = {
    headers: new Map(),
    statusCode: 200,
    body: undefined,
    ended: false,
    setHeader(name, value) {
      if (reject(name)) throw new TypeError(`Invalid character in header content ["${name}"]`);
      this.headers.set(name.toLowerCase(), value);
      return this;
    },
    removeHeader(name) {
      this.headers.delete(name.toLowerCase());
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    type(value) {
      this.contentType = value;
      return this;
    },
    json(value) {
      this.body = value;
      this.ended = true;
      return this;
    },
    send(value) {
      this.body = value;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return response;
}

const fakeRequest = (patch: Record<string, unknown>) =>
  ({ method: "GET", originalUrl: "", url: "/", headers: {}, params: {}, body: undefined, ...patch }) as never;

const hit = (patch: Record<string, unknown> = {}): MockAnswer => ({
  delayMs: 0,
  mockServerId: "mock-1",
  outcome: {
    kind: "hit",
    status: 200,
    headers: [
      { name: "X-Ok", value: "1", enabled: true },
      { name: "X-Rara", value: "€", enabled: true },
    ],
    body: '{"ok":true}',
    trace: {
      endpointId: "e",
      endpointRoute: "GET /pedidos/{id}",
      exampleName: "ejemplo\u0007 ñ",
      exampleId: "x",
      reason: "lowest-2xx",
    },
    ...patch,
  } as MockAnswer["outcome"],
});

function controller(answer: MockAnswer, record: (command: unknown) => Promise<unknown> = async () => undefined) {
  const queries: AnswerMockQuery[] = [];
  const commands: unknown[] = [];
  const queryBus = {
    execute: async (query: AnswerMockQuery) => {
      queries.push(query);
      return answer;
    },
  };
  const commandBus = {
    execute: async (command: unknown) => {
      commands.push(command);
      return record(command);
    },
  };
  return { serve: new MockServeController(queryBus as never, commandBus as never), queries, commands };
}

describe("la URL pública del mock, desde dentro", () => {
  test("la petición llega troceada como hace falta: ruta por segmentos, query, cabeceras repetidas", async () => {
    const { serve, queries, commands } = controller(hit());
    const response = fakeResponse((name) => name === "X-Rara");
    await serve.serve(
      "abc",
      fakeRequest({
        method: "POST",
        originalUrl: "/mock/abc/a%2Fb/%zz/c?x=1&y=dos",
        headers: { "X-Varias": ["uno", "dos"], "x-nada": undefined, accept: "application/json" },
        body: { a: 1 },
      }),
      response as never,
    );
    const [query] = queries;
    assert.equal(query!.publicId, "abc");
    assert.deepEqual(query!.request, {
      method: "POST",
      path: "/a/b/%zz/c",
      query: [
        ["x", "1"],
        ["y", "dos"],
      ],
      headers: { "x-varias": "uno, dos", accept: "application/json" },
      body: { a: 1 },
    });
    // La cabecera que Node rechaza se salta y la respuesta sigue.
    assert.equal(response.headers.get("x-ok"), "1");
    assert.equal(response.headers.has("x-rara"), false);
    assert.equal(response.headers.get("x-eq-mock-endpoint"), "GET /pedidos/{id}");
    // Sin el carácter de control, y la ñ en porcentaje.
    assert.equal(response.headers.get("x-eq-mock-example"), "ejemplo %C3%B1");
    assert.equal(response.headers.get("x-eq-mock-reason"), "lowest-2xx");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '{"ok":true}');
    const [recorded] = commands as RecordMockCallCommand[];
    assert.ok(recorded instanceof RecordMockCallCommand);
    assert.equal(recorded.mockServerId, "mock-1");
    assert.equal(recorded.path, "/a/b/%zz/c");
  });

  test("sin originalUrl se usa la url, y una ruta que no empieza por el prefijo es la raíz", async () => {
    const { serve, queries } = controller(hit());
    await serve.serve("abc", fakeRequest({ originalUrl: "", url: "/otra/cosa" }), fakeResponse() as never);
    assert.equal(queries[0]!.request.path, "/");
    assert.deepEqual(queries[0]!.request.query, []);
    await serve.serve("abc", fakeRequest({ originalUrl: "/mock/abc" }), fakeResponse() as never);
    assert.equal(queries[1]!.request.path, "/");
  });

  test("204, 304 y un cuerpo vacío terminan sin cuerpo", async () => {
    for (const [status, body] of [
      [204, "no debería salir"],
      [304, "tampoco"],
      [200, ""],
    ] as const) {
      const { serve } = controller(hit({ status, body }));
      const response = fakeResponse();
      await serve.serve("abc", fakeRequest({ originalUrl: "/mock/abc/x" }), response as never);
      assert.equal(response.statusCode, status);
      assert.equal(response.ended, true);
      assert.equal(response.body, undefined);
    }
  });

  test("un problema sale como Problem Details, con Allow si lo trae, y la bitácora que falla no lo estropea", async () => {
    const answer: MockAnswer = {
      delayMs: 0,
      mockServerId: "mock-1",
      outcome: {
        kind: "problem",
        status: 405,
        code: "mock-wrong-method",
        title: "Ese método no",
        detail: "detalle",
        allow: ["GET", "HEAD"],
      },
    };
    const { serve, commands } = controller(answer, async () => {
      throw new Error("bitácora caída");
    });
    const response = fakeResponse();
    await serve.serve("abc", fakeRequest({ originalUrl: "", url: "/mock/abc/x?y=1" }), response as never);
    assert.equal(response.statusCode, 405);
    assert.equal(response.contentType, "application/problem+json");
    assert.equal(response.headers.get("allow"), "GET, HEAD");
    assert.deepEqual(response.body, {
      type: "https://endpoint-quality.dev/problems/mock-wrong-method",
      title: "Ese método no",
      status: 405,
      detail: "detalle",
      instance: "/mock/abc/x?y=1",
    });
    assert.equal(commands.length, 1);
  });

  test("sin mock detrás no se anota nada, y sin Allow no se inventa", async () => {
    const answer: MockAnswer = {
      delayMs: 0,
      mockServerId: null,
      outcome: { kind: "problem", status: 404, code: "mock-not-found", title: "No", detail: "no" },
    };
    const { serve, commands } = controller(answer);
    const response = fakeResponse();
    await serve.serve("abc", fakeRequest({ originalUrl: "/mock/abc/x" }), response as never);
    assert.equal(response.headers.has("allow"), false);
    assert.equal(commands.length, 0);
  });

  test("el preflight sin publicId en los parámetros llega al motor con uno vacío", async () => {
    const { serve, queries } = controller(hit());
    await serve.preflight(fakeRequest({ method: "OPTIONS", originalUrl: "/mock//x", params: {} }), fakeResponse() as never);
    assert.equal(queries[0]!.publicId, "");
    const answered = fakeResponse();
    serve.preflight(
      fakeRequest({ method: "OPTIONS", headers: { "access-control-request-method": "GET" }, params: { publicId: "abc" } }),
      answered as never,
    );
    assert.equal(answered.statusCode, 204);
    assert.equal(answered.ended, true);
    assert.equal(queries.length, 1);
  });
});
