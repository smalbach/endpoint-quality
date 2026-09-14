import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractRealIds,
  fillPath,
  forgeAttackToken,
  planDiscovery,
  planProbes,
  type PlanOptions,
} from "../src/plan.ts";
import { DEFAULT_RULES } from "../src/presets.ts";
import { decodeJwt } from "../src/jwt.ts";
import type { EndpointMeta, ProbeResult } from "../src/types.ts";

const endpoint = (patch: Partial<EndpointMeta> & Pick<EndpointMeta, "id" | "method" | "path">): EndpointMeta => ({
  requiresAuth: true,
  operationId: null,
  pathParameters: /\{/.test(patch.path) ? [...patch.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]) : [],
  body: null,
  ...patch,
});

const options = (patch: Partial<PlanOptions> = {}): PlanOptions => ({
  roles: [
    { name: "admin", hasCredential: true },
    { name: "vendedor", hasCredential: true },
  ],
  adminRole: "admin",
  rules: DEFAULT_RULES,
  rateLimitIterations: 20,
  crossUserPermutations: false,
  ...patch,
});

const result = (patch: Partial<ProbeResult> & Pick<ProbeResult, "endpointId" | "testType">): ProbeResult => ({
  id: `${patch.endpointId}::${patch.testType}`,
  method: "GET",
  path: "/x",
  credential: null,
  token: null,
  headers: {},
  body: null,
  contentType: null,
  note: "",
  status: 200,
  responseHeaders: {},
  bodyText: "",
  bodyBytes: 0,
  durationMs: 1,
  error: null,
  sentAuthorization: false,
  ...patch,
});

describe("el plan de sondas", () => {
  it("rellena la ruta y solo descubre en GET sin parámetros", () => {
    assert.equal(fillPath("/users/{id}/posts/{postId}", "7"), "/users/7/posts/7");
    const discovery = planDiscovery(
      [endpoint({ id: "a", method: "GET", path: "/users" }), endpoint({ id: "b", method: "GET", path: "/users/{id}" })],
      "admin",
    );
    assert.deepEqual(
      discovery.map((probe) => probe.endpointId),
      ["a"],
    );
    assert.equal(discovery[0].credential, "admin");
  });

  it("saca ids reales de una lista, sin repetir", () => {
    const ids = extractRealIds([
      result({
        endpointId: "a",
        testType: "discovery",
        bodyText: JSON.stringify([
          { id: 1, name: "x" },
          { id: 2, userId: 9 },
        ]),
      }),
    ]);
    assert.deepEqual(ids.sort(), ["1", "2", "9"]);
  });

  it("no-auth siempre; una sonda auth por rol con credencial", () => {
    const probes = planProbes([endpoint({ id: "a", method: "GET", path: "/orders" })], options(), []);
    assert.ok(probes.some((probe) => probe.testType === "no-auth"));
    assert.deepEqual(
      probes.filter((probe) => probe.testType.startsWith("auth:")).map((probe) => probe.credential),
      ["admin", "vendedor"],
    );
  });

  it("una regla apagada no genera sus sondas", () => {
    const off = planProbes(
      [endpoint({ id: "a", method: "GET", path: "/orders" })],
      options({ rules: { ...DEFAULT_RULES, cors: false, security_headers: false } }),
      [],
    );
    assert.equal(off.filter((probe) => probe.testType === "cors").length, 0);
    const on = planProbes([endpoint({ id: "a", method: "GET", path: "/orders" })], options(), []);
    assert.equal(on.filter((probe) => probe.testType === "cors").length, 1);
  });

  it("BFLA salta el rol admin y solo sale en métodos destructivos o rutas admin", () => {
    const probes = planProbes(
      [endpoint({ id: "a", method: "DELETE", path: "/orders/{id}", body: { note: "x" } })],
      options({ rules: { ...DEFAULT_RULES, bfla: true } }),
      [],
    );
    assert.deepEqual(
      probes.filter((probe) => probe.testType.startsWith("bfla:")).map((probe) => probe.credential),
      ["vendedor"],
    );
  });

  it("las sondas jwt-attack solo salen en el primer endpoint autenticado", () => {
    const probes = planProbes(
      [endpoint({ id: "a", method: "GET", path: "/orders" }), endpoint({ id: "b", method: "GET", path: "/carts" })],
      options({ rules: { ...DEFAULT_RULES, jwt_attack: true } }),
      [],
    );
    assert.deepEqual(
      new Set(probes.filter((probe) => probe.testType.startsWith("jwt-attack")).map((probe) => probe.endpointId)),
      new Set(["a"]),
    );
  });

  it("forja los tres tokens de ataque a partir de uno real", () => {
    const real = `${btoa('{"alg":"HS256"}')}.${btoa('{"sub":"u","exp":9999999999}')}.firma`
      .replace(/=+/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const none = forgeAttackToken("alg-none", real)!;
    assert.equal(decodeJwt(none)!.header.alg, "none");
    const tampered = forgeAttackToken("tampered", real)!;
    assert.equal(decodeJwt(tampered)!.payload.role, "admin");
    const expired = forgeAttackToken("expired", real)!;
    assert.ok((decodeJwt(expired)!.payload.exp as number) < Math.floor(Date.now() / 1000));
  });
});
