import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractRealIds, planDiscovery, planProbes, type PlanOptions } from "../src/plan.ts";
import { DEFAULT_RULES, PRESETS } from "../src/presets.ts";
import { RULE_KEYS, type Probe, type RuleKey } from "../src/types.ts";
import { endpoint, result } from "./fixtures.ts";

const none = Object.fromEntries(RULE_KEYS.map((key) => [key, false])) as Record<RuleKey, boolean>;
const only = (...keys: RuleKey[]) => ({ ...none, ...Object.fromEntries(keys.map((key) => [key, true])) });

const options = (patch: Partial<PlanOptions> = {}): PlanOptions => ({
  roles: [
    { name: "admin", hasCredential: true },
    { name: "vendedor", hasCredential: true },
    { name: "invitado", hasCredential: false },
  ],
  adminRole: "admin",
  rules: none,
  rateLimitIterations: 3,
  crossUserPermutations: false,
  ...patch,
});

const ofType = (probes: Probe[], prefix: string) => probes.filter((probe) => probe.testType.startsWith(prefix));

const list = endpoint({ id: "list", method: "GET", path: "/orders" });
const detail = endpoint({ id: "detail", method: "GET", path: "/orders/{id}" });
const create = endpoint({ id: "create", method: "POST", path: "/orders", body: { total: 10 } });
const remove = endpoint({ id: "remove", method: "DELETE", path: "/orders/{id}" });

describe("el descubrimiento de ids reales", () => {
  it("usa la credencial privilegiada, o ninguna si no hay rol admin", () => {
    const [probe] = planDiscovery([list], null);
    assert.equal(probe.credential, null);
    assert.equal(probe.testType, "discovery");
    assert.equal(probe.id, "list::discovery");
  });

  it("no descubre en escrituras aunque no tengan parámetros", () => {
    assert.deepEqual(planDiscovery([create, detail], "admin"), []);
  });

  it("recoge _id, uuid y campos *Id anidados, e ignora los que no son ids", () => {
    const ids = extractRealIds([
      result({
        endpointId: "list",
        testType: "discovery",
        bodyText: JSON.stringify({
          data: {
            items: [
              { _id: "a1", name: "x", total: 5 },
              { uuid: "u-2", customerId: 7, tags: ["id"] },
            ],
          },
          identity: "no",
          ID: "no",
          Id: "no",
        }),
      }),
    ]);
    assert.deepEqual(ids.sort(), ["7", "a1", "u-2"]);
  });

  it("un id que es objeto se recorre en vez de tomarse; un id vacío se descarta", () => {
    const ids = extractRealIds([
      result({ endpointId: "list", testType: "discovery", bodyText: '[{"id":{"id":"dentro"}},{"id":""}]' }),
    ]);
    assert.deepEqual(ids, ["dentro"]);
  });

  it("ignora respuestas que no son 2xx o que no son JSON", () => {
    const ids = extractRealIds([
      result({ endpointId: "a", testType: "discovery", status: 403, bodyText: '[{"id":1}]' }),
      result({ endpointId: "b", testType: "discovery", status: 200, bodyText: "<html>id=2</html>" }),
      result({ endpointId: "c", testType: "discovery", status: 200, bodyText: "" }),
    ]);
    assert.deepEqual(ids, []);
  });

  it("junta ids de varias listas sin repetirlos", () => {
    const ids = extractRealIds([
      result({ endpointId: "a", testType: "discovery", bodyText: '[{"id":1},{"id":2}]' }),
      result({ endpointId: "b", testType: "discovery", bodyText: '[{"id":2},{"id":"1"},{"id":3}]' }),
    ]);
    assert.deepEqual(ids, ["1", "2", "3"]);
  });

  it("se queda en perEndpoint × 4 ids como mucho", () => {
    const many = JSON.stringify(Array.from({ length: 50 }, (_, index) => ({ id: index + 1 })));
    assert.equal(extractRealIds([result({ endpointId: "a", testType: "discovery", bodyText: many })], 1).length, 4);
    assert.equal(extractRealIds([result({ endpointId: "a", testType: "discovery", bodyText: many })]).length, 20);
  });

  it("no baja más de cinco niveles", () => {
    const deep = (levels: number): unknown => (levels === 0 ? { id: "hondo" } : { nivel: deep(levels - 1) });
    const reachable = extractRealIds([
      result({ endpointId: "a", testType: "discovery", bodyText: JSON.stringify(deep(5)) }),
    ]);
    assert.deepEqual(reachable, ["hondo"]);
    const tooDeep = extractRealIds([
      result({ endpointId: "a", testType: "discovery", bodyText: JSON.stringify(deep(6)) }),
    ]);
    assert.deepEqual(tooDeep, []);
  });
});

describe("la matriz de sondas", () => {
  it("con todas las reglas apagadas solo salen no-auth y una auth por rol con credencial", () => {
    const probes = planProbes([list, create], options(), ["1"]);
    assert.deepEqual(
      probes.map((probe) => probe.id),
      [
        "list::no-auth",
        "list::auth:admin",
        "list::auth:vendedor",
        "create::no-auth",
        "create::auth:admin",
        "create::auth:vendedor",
      ],
    );
    const noAuth = probes.find((probe) => probe.id === "create::no-auth")!;
    assert.equal(noAuth.credential, null);
    assert.equal(noAuth.body, '{"total":10}');
    assert.equal(noAuth.contentType, "application/json");
    assert.equal(probes.find((probe) => probe.id === "list::no-auth")!.contentType, null);
  });

  it("los ids de sonda no se repiten ni con todas las reglas encendidas", () => {
    const all = PRESETS.find((preset) => preset.id === "all")!.rules;
    const probes = planProbes([list, detail, create, remove], options({ rules: all, crossUserPermutations: true }), [
      "11",
      "12",
      "13",
    ]);
    assert.equal(new Set(probes.map((probe) => probe.id)).size, probes.length);
  });

  it("CORS sale con security_headers sola, con el Origin malicioso y el método en preflight", () => {
    const [cors] = ofType(planProbes([create], options({ rules: only("security_headers") }), []), "cors");
    assert.equal(cors.credential, "admin");
    assert.deepEqual(cors.headers, { Origin: "https://evil.example.com", "Access-Control-Request-Method": "POST" });
  });

  it("sin ningún rol con credencial, las sondas autenticadas van sin credencial y no hay jwt-attack", () => {
    const probes = planProbes(
      [list],
      options({ roles: [{ name: "invitado", hasCredential: false }], rules: only("cors", "jwt_attack", "bfla") }),
      [],
    );
    assert.equal(ofType(probes, "auth:").length, 0);
    assert.equal(ofType(probes, "cors")[0].credential, null);
    assert.equal(ofType(probes, "jwt-attack").length, 0);
  });

  it("BOLA pide cuatro ids fijos solo en GET con parámetro de ruta", () => {
    const probes = planProbes([list, detail, remove], options({ rules: only("bola_idor") }), []);
    const bola = ofType(probes, "bola-id:");
    assert.deepEqual(
      bola.map((probe) => probe.path),
      ["/orders/1", "/orders/2", "/orders/999", "/orders/99999"],
    );
    assert.ok(bola.every((probe) => probe.endpointId === "detail" && probe.method === "GET"));
  });

  it("la inyección manda 7 payloads; un GET se prueba por POST y la escritura con su verbo", () => {
    const probes = planProbes([detail, create], options({ rules: only("injection") }), []);
    const onDetail = ofType(probes, "injection-").filter((probe) => probe.endpointId === "detail");
    assert.deepEqual(
      onDetail.map((probe) => probe.testType),
      [
        "injection-sql:0",
        "injection-sql:1",
        "injection-sql:2",
        "injection-nosql:0",
        "injection-nosql:1",
        "injection-xss:0",
        "injection-xss:1",
      ],
    );
    assert.ok(onDetail.every((probe) => probe.method === "POST" && probe.contentType === "application/json"));
    assert.equal(onDetail[0].path, `/orders/${encodeURIComponent("' OR '1'='1")}`);
    assert.equal(onDetail[0].note, "' OR '1'='1");

    const onCreate = ofType(probes, "injection-").filter((probe) => probe.endpointId === "create");
    assert.ok(onCreate.every((probe) => probe.method === "POST" && probe.path === "/orders"));
    const sent = JSON.parse(onCreate[0].body!);
    assert.deepEqual(sent, { total: 10, q: "' OR '1'='1", search: "' OR '1'='1", input: "' OR '1'='1" });
  });

  it("la asignación masiva solo sale en escrituras con cuerpo y añade los campos privilegiados", () => {
    const probes = planProbes([list, create, remove], options({ rules: only("mass_assignment") }), []);
    const mass = ofType(probes, "mass-assignment");
    assert.deepEqual(
      mass.map((probe) => probe.endpointId),
      ["create"],
    );
    assert.deepEqual(JSON.parse(mass[0].body!), {
      total: 10,
      role: "admin",
      isAdmin: true,
      verified: true,
      is_admin: true,
    });
  });

  it("el flood de rate limit respeta las iteraciones y nunca baja de una", () => {
    assert.equal(
      ofType(planProbes([list], options({ rules: only("rate_limit"), rateLimitIterations: 4 }), []), "rate-limit")
        .length,
      4,
    );
    assert.equal(
      ofType(planProbes([list], options({ rules: only("rate_limit"), rateLimitIterations: 0 }), []), "rate-limit")
        .length,
      1,
    );
    const [flood] = ofType(planProbes([create], options({ rules: only("rate_limit") }), []), "rate-limit");
    assert.equal(flood.body, '{"total":10}');
  });

  it("BFLA sale en GET de rutas administrativas pero no en un GET corriente", () => {
    const admin = endpoint({ id: "cfg", method: "GET", path: "/admin/settings" });
    const probes = planProbes([list, admin], options({ rules: only("bfla"), adminRole: null }), []);
    const bfla = ofType(probes, "bfla:");
    assert.deepEqual(
      bfla.map((probe) => `${probe.endpointId}/${probe.credential}`),
      ["cfg/admin", "cfg/vendedor"],
      "sin adminRole declarado, todos los roles con credencial se prueban",
    );
  });

  it("method tampering: un GET prueba DELETE/PUT/PATCH, una escritura DELETE y OPTIONS nada", () => {
    const options_ = endpoint({ id: "opt", method: "OPTIONS", path: "/orders" });
    const probes = planProbes([list, create, options_], options({ rules: only("method_tampering") }), []);
    const tamper = ofType(probes, "method-tamper:");
    assert.deepEqual(
      tamper.map((probe) => `${probe.endpointId} ${probe.method}`),
      ["list DELETE", "list PUT", "list PATCH", "create DELETE"],
    );
    assert.equal(tamper[0].note, "GET → DELETE");
  });

  it("content-type manda tres tipos en escrituras, con {} cuando no hay cuerpo", () => {
    const probes = planProbes([list, remove], options({ rules: only("content_type") }), []);
    const types = ofType(probes, "content-type:");
    assert.deepEqual(
      types.map((probe) => [probe.endpointId, probe.contentType, probe.body]),
      [
        ["remove", "text/plain", "{}"],
        ["remove", "application/xml", "{}"],
        ["remove", null, "{}"],
      ],
    );
  });

  it("verbose-error manda JSON roto solo en escrituras", () => {
    const probes = planProbes([list, create], options({ rules: only("verbose_error") }), []);
    const verbose = ofType(probes, "verbose-error");
    assert.equal(verbose.length, 1);
    assert.equal(verbose[0].endpointId, "create");
    assert.throws(() => JSON.parse(verbose[0].body!));
  });

  it("jwt-attack marca los tres ataques con la credencial del primer rol, sin token todavía", () => {
    const probes = ofType(planProbes([list], options({ rules: only("jwt_attack") }), []), "jwt-attack:");
    assert.deepEqual(
      probes.map((probe) => probe.note),
      ["alg-none", "expired", "tampered"],
    );
    assert.ok(probes.every((probe) => probe.credential === "admin" && probe.token === null));
  });

  it("cross-user necesita la regla y las permutaciones", () => {
    const withoutPermutations = planProbes([detail], options({ rules: only("cross_user_access") }), ["5"]);
    assert.equal(ofType(withoutPermutations, "bola-real-id").length, 0);

    const withoutRule = planProbes([detail], options({ crossUserPermutations: true }), ["5"]);
    assert.equal(ofType(withoutRule, "bola-real-id").length, 0);
  });

  it("cross-user sin ids reales no manda nada: el endpoint como cada rol ya es auth:<rol>", () => {
    const probes = planProbes(
      [list, detail],
      options({ rules: only("cross_user_access"), crossUserPermutations: true }),
      [],
    );
    const without = planProbes([list, detail], options({ rules: only("cross_user_access") }), []);
    assert.deepEqual(
      probes.map((probe) => probe.id),
      without.map((probe) => probe.id),
    );
    assert.equal(ofType(probes, "bola-real-id").length, 0);
  });

  it("con ids reales: dos ids × cada rol, solo en endpoints con parámetro, con el verbo del endpoint", () => {
    const probes = planProbes(
      [list, detail, remove],
      options({ rules: only("cross_user_access"), crossUserPermutations: true }),
      ["11", "12", "13"],
    );
    const real = ofType(probes, "bola-real-id:");
    assert.deepEqual(
      real.map((probe) => `${probe.method} ${probe.path} ${probe.credential}`),
      [
        "GET /orders/11 admin",
        "GET /orders/11 vendedor",
        "GET /orders/12 admin",
        "GET /orders/12 vendedor",
        "DELETE /orders/11 admin",
        "DELETE /orders/11 vendedor",
        "DELETE /orders/12 admin",
        "DELETE /orders/12 vendedor",
      ],
    );
    assert.equal(real[0].testType, "bola-real-id:admin:11");
  });

  it("las reglas recomendadas no mandan el flood de rate limit", () => {
    assert.equal(ofType(planProbes([list], options({ rules: DEFAULT_RULES }), []), "rate-limit").length, 0);
  });
});
