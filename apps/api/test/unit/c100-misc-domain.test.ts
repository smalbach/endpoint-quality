/**
 * Las reglas de dominio de mocks y documentaciones que el DTO ya para antes por HTTP —y que siguen
 * siendo la regla para quien llama al comando directamente—, el retraso aleatorio del mock, el
 * desempate de rutas y ejemplos, el orden de los grupos de la documentación, el CORS del mock y la
 * lectura de GitHub sin base.
 */
import "reflect-metadata";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";

import { blankEndpoint, type Endpoint } from "@/modules/endpoints/domain/model";
import { blankExample, type EndpointExample } from "@/modules/endpoints/domain/examples";
import { MAX_MOCK_DELAY_MS, MAX_MOCK_NAME, delayFor, mockProblems } from "@/modules/mocks/domain/model";
import { chooseExample, matchRoute, type MockRequest } from "@/modules/mocks/domain/serve-mock";
import { MOCK_CORS_HEADERS, mockCors } from "@/modules/mocks/presentation/mock-cors";
import { MAX_DOC_BASE_URL, MAX_DOC_INTRO, MAX_DOC_NAME, docSiteProblems } from "@/modules/docs/domain/model";
import { UNTAGGED_GROUP, buildDocPage } from "@/modules/docs/domain/doc-page";
import { GithubSource } from "@/modules/code-scan/infrastructure/github-source";
import type { SafeFetchPort, SafeFetchResult } from "@/shared/http/safe-fetch";

const NOW = new Date("2026-03-01T10:00:00.000Z");
let sequence = 0;

function endpoint(method: string, path: string, patch: Partial<Endpoint> = {}): Endpoint {
  return {
    ...blankEndpoint({
      id: `e-${(sequence += 1)}`,
      projectId: "p-1",
      origin: "manual",
      orderIndex: 0,
      now: NOW,
      actorId: "u",
    }),
    method: method as Endpoint["method"],
    path,
    ...patch,
  };
}

function example(endpointId: string, name: string, status: number, orderIndex: number): EndpointExample {
  return blankExample({
    projectId: "p-1",
    endpointId,
    name,
    request: { method: "GET", url: "https://api.test/x", headers: [], body: { text: "", contentType: "" } },
    response: { status, headers: [], body: "{}", contentType: "application/json", durationMs: 1 },
    origin: "manual",
    orderIndex,
    now: NOW,
    actorId: "u",
  });
}

const request = (patch: Partial<MockRequest> = {}): MockRequest => ({
  method: "GET",
  path: "/",
  query: [],
  headers: {},
  ...patch,
});

describe("las reglas de un mock", () => {
  test("nombre de más, visibilidad que falta al crear o que no existe", () => {
    assert.deepEqual(mockProblems({ name: "x".repeat(MAX_MOCK_NAME + 1) }), [
      { field: "name", detail: `Como mucho ${MAX_MOCK_NAME} caracteres` },
    ]);
    assert.deepEqual(mockProblems({ name: "m" }, { requireVisibility: true }), [
      { field: "visibility", detail: "Di si el mock es «public» o «private»" },
    ]);
    assert.deepEqual(mockProblems({ visibility: "abierto" as never }), [
      { field: "visibility", detail: "Tiene que ser «public» o «private»" },
    ]);
    // Al cambiar, sin visibilidad no pasa nada: se queda la que tenía.
    assert.deepEqual(mockProblems({ name: "m" }), []);
  });

  test("un retraso fijo negativo o no entero no vale", () => {
    const fixed = (ms: number) => mockProblems({ delay: { kind: "fixed", ms } });
    for (const ms of [-1, 1.5]) assert.deepEqual(fixed(ms), [{ field: "delay.ms", detail: "Tiene que ser un entero de 0 o más" }]);
    assert.deepEqual(fixed(MAX_MOCK_DELAY_MS), []);
  });

  test("un retraso aleatorio: cada extremo por su cuenta, y el mínimo no puede pasar del máximo", () => {
    const random = (minMs: number, maxMs: number) => mockProblems({ delay: { kind: "random", minMs, maxMs } });
    assert.deepEqual(random(0, MAX_MOCK_DELAY_MS), []);
    assert.deepEqual(random(-5, 1.5), [
      { field: "delay.minMs", detail: "Tiene que ser un entero de 0 o más" },
      { field: "delay.maxMs", detail: "Tiene que ser un entero de 0 o más" },
    ]);
    assert.deepEqual(random(MAX_MOCK_DELAY_MS + 1, MAX_MOCK_DELAY_MS + 2), [
      { field: "delay.minMs", detail: `Como mucho ${MAX_MOCK_DELAY_MS} ms` },
      { field: "delay.maxMs", detail: `Como mucho ${MAX_MOCK_DELAY_MS} ms` },
    ]);
    assert.deepEqual(random(300, 100), [{ field: "delay.minMs", detail: "El mínimo no puede ser mayor que el máximo" }]);
  });

  test("el retraso aleatorio se elige en cada petición, entre los dos extremos incluidos", () => {
    const delay = { kind: "random" as const, minMs: 100, maxMs: 200 };
    assert.equal(delayFor(delay, () => 0), 100);
    assert.equal(delayFor(delay, () => 0.5), 150);
    assert.equal(delayFor(delay, () => 0.999_999), 200);
    assert.equal(delayFor({ kind: "none" }), 0);
  });
});

describe("desempates del mock", () => {
  test("la ruta literal gana aunque la del hueco vaya después en la lista", () => {
    const literal = endpoint("GET", "/users/me");
    const hueco = endpoint("GET", "/users/{id}");
    const match = matchRoute([literal, hueco], request({ path: "/users/me" }));
    assert.equal(match.kind, "route");
    assert.equal(match.kind === "route" && match.endpoint.id, literal.id);
  });

  test("dos ejemplos con el mismo estado: decide el orden de la lista", () => {
    const second = example("e", "segundo", 200, 1);
    const first = example("e", "primero", 200, 0);
    const choice = chooseExample([second, first], request());
    assert.equal(choice.kind, "example");
    assert.equal(choice.kind === "example" && choice.example.name, "primero");
    assert.equal(choice.kind === "example" && choice.reason, "lowest-2xx");
  });
});

describe("el CORS del mock, como middleware", () => {
  function run(method: string, headers: Record<string, string>) {
    const set = new Map<string, string>([["access-control-allow-credentials", "true"]]);
    let status: number | null = null;
    let ended = false;
    let nexted = false;
    const response = {
      setHeader: (name: string, value: string) => set.set(name, value),
      removeHeader: (name: string) => set.delete(name),
      status(code: number) {
        status = code;
        return this;
      },
      end: () => (ended = true),
    } as unknown as Response;
    mockCors({ method, headers } as Request, response, (() => (nexted = true)) as NextFunction);
    return { set, status, ended, nexted };
  }

  test("un preflight se contesta aquí con 204 y las cabeceras abiertas, sin credenciales", () => {
    const answer = run("OPTIONS", { "access-control-request-method": "POST", origin: "http://localhost:5173" });
    assert.equal(answer.status, 204);
    assert.equal(answer.ended, true);
    assert.equal(answer.nexted, false);
    for (const [name, value] of Object.entries(MOCK_CORS_HEADERS)) assert.equal(answer.set.get(name), value);
    assert.equal(answer.set.get("access-control-allow-origin"), "*");
    assert.equal(answer.set.has("access-control-allow-credentials"), false);
  });

  test("un OPTIONS de verdad y un GET siguen hasta el mock, con las cabeceras ya puestas", () => {
    for (const method of ["OPTIONS", "GET"]) {
      const answer = run(method, {});
      assert.equal(answer.nexted, true, method);
      assert.equal(answer.status, null);
      assert.equal(answer.ended, false);
      assert.equal(answer.set.get("cache-control"), "no-store");
      assert.equal(answer.set.get("cross-origin-resource-policy"), "cross-origin");
      assert.equal(answer.set.has("access-control-allow-credentials"), false);
    }
  });
});

describe("las reglas de una documentación", () => {
  test("nombre, visibilidad, base e intro fuera de sus límites", () => {
    assert.deepEqual(docSiteProblems({ name: "x".repeat(MAX_DOC_NAME + 1) }), [
      { field: "name", detail: `Como mucho ${MAX_DOC_NAME} caracteres` },
    ]);
    assert.deepEqual(docSiteProblems({ name: "d" }, { requireVisibility: true }), [
      { field: "visibility", detail: "Di si la documentación es «public» o «private»" },
    ]);
    assert.deepEqual(docSiteProblems({ visibility: "abierta" as never }), [
      { field: "visibility", detail: "Tiene que ser «public» o «private»" },
    ]);
    assert.deepEqual(docSiteProblems({ baseUrl: `https://api.test/${"a".repeat(MAX_DOC_BASE_URL)}` }), [
      { field: "baseUrl", detail: `Como mucho ${MAX_DOC_BASE_URL} caracteres` },
    ]);
    assert.deepEqual(docSiteProblems({ intro: "x".repeat(MAX_DOC_INTRO + 1) }), [
      { field: "intro", detail: `Como mucho ${MAX_DOC_INTRO} caracteres` },
    ]);
    assert.deepEqual(docSiteProblems({ name: "d", visibility: "private", baseUrl: "https://api.test", intro: "hola" }), []);
  });

  test("lo sin etiqueta va al final aunque aparezca después de un grupo con etiqueta", () => {
    const page = buildDocPage({
      project: { name: "P", description: "", authType: "none", apiKeyName: "" },
      site: { baseUrl: "", intro: "", includeExamples: false },
      endpoints: [
        endpoint("GET", "/pedidos", { orderIndex: 0, tags: ["Pedidos"] }),
        endpoint("GET", "/suelto", { orderIndex: 1, tags: [] }),
        endpoint("GET", "/clientes", { orderIndex: 2, tags: ["Clientes"] }),
      ],
      examplesOf: () => [],
      generatedAt: NOW,
    });
    assert.deepEqual(
      page.groups.map((group) => group.tag),
      ["Pedidos", "Clientes", UNTAGGED_GROUP],
    );
  });
});

describe("GitHub sin base", () => {
  test("sin base se leen los controladores de todo el repositorio", async () => {
    const tree = "https://api.github.com/repos/acme/api/git/trees/main?recursive=1";
    const files: Record<string, string> = {
      "https://api.github.com/repos/acme/api/contents/a.controller.ts?ref=main": "// a",
      "https://api.github.com/repos/acme/api/contents/apps/b.controller.ts?ref=main": "// b",
    };
    const http: SafeFetchPort = {
      get: async () => {
        throw new Error("no se usa");
      },
      request: async (url) =>
        ({
          status: 200,
          headers: {},
          setCookie: [],
          finalUrl: url,
          durationMs: 1,
          timing: { dnsMs: 0, ttfbMs: 0, downloadMs: 0 },
          body:
            url === tree
              ? JSON.stringify({
                  tree: [
                    { path: "a.controller.ts", type: "blob" },
                    { path: "apps/b.controller.ts", type: "blob" },
                    { path: "apps/c.service.ts", type: "blob" },
                  ],
                })
              : JSON.stringify({ encoding: "base64", content: Buffer.from(files[url]!).toString("base64") }),
        }) as SafeFetchResult,
    };
    const found = await new GithubSource(http).fetchControllers({ repo: "acme/api", branch: "main", basePath: "/", token: null });
    assert.deepEqual(found.sources, [
      { path: "a.controller.ts", content: "// a" },
      { path: "apps/b.controller.ts", content: "// b" },
    ]);
  });
});
