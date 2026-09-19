/**
 * Las secciones de la configuración, validadas al escribirse: lo que la API guarda pasa por aquí,
 * así que lo que esto acepta es lo que el motor luego tiene que saber leer.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  budgetRuleSchema,
  CONFIG_SECTIONS,
  isConfigSection,
  parseSection,
  safeParseSection,
  scenarioCredentialSchema,
} from "../src/schema.ts";
import * as presets from "../src/presets.ts";

const access = (body: Record<string, unknown>) => ({ access: { roles: ["vendedor", "admin"], ...body } });

describe("las secciones", () => {
  test("solo los nombres de sección existentes son secciones", () => {
    assert.ok(CONFIG_SECTIONS.includes("access"));
    assert.equal(isConfigSection("budgets"), true);
    assert.equal(isConfigSection("presupuestos"), false);
  });

  test("parseSection devuelve la sección con sus valores por defecto, y lanza si no vale", () => {
    const parsed = parseSection("access", access({}));
    assert.deepEqual(parsed.access, { roles: ["vendedor", "admin"], deniedStatuses: [403, 404], rules: [], crossRole: [] });
    assert.throws(() => parseSection("access", { access: { roles: ["con espacio"] } }));
  });

  test("safeParseSection nombra el campo que falla, o la sección cuando falla entera", () => {
    assert.deepEqual(safeParseSection("labels", { labels: { getThing: ["lectura"] } }), { ok: true });
    assert.deepEqual(safeParseSection("labels", { labels: { getThing: [" empieza con espacio"] } }), {
      ok: false,
      issues: [{ field: "labels.getThing.0", detail: "una etiqueta no puede llevar comas ni empezar por un espacio" }],
    });
    const whole = safeParseSection("budgets", null);
    assert.equal(whole.ok, false);
    assert.deepEqual(whole.ok ? [] : whole.issues.map((issue) => issue.field), ["budgets"]);
  });
});

describe("la matriz de acceso", () => {
  test("una regla no puede permitir y negar el mismo rol", () => {
    const result = safeParseSection("access", access({ rules: [{ operationId: "getPedido", allow: ["vendedor"], deny: ["vendedor"] }] }));
    assert.deepEqual(result, {
      ok: false,
      issues: [{ field: "access.rules.0.deny", detail: "«vendedor» está a la vez en allow y en deny" }],
    });
  });

  test("una regla que no nombra ningún rol no dice nada y se rechaza", () => {
    const result = safeParseSection("access", access({ rules: [{ operationId: "getPedido" }] }));
    assert.deepEqual(result, {
      ok: false,
      issues: [{ field: "access.rules.0.allow", detail: "la regla no dice nada de ningún rol" }],
    });
  });

  test("una regla con allow o deny, sin solaparse, vale", () => {
    assert.deepEqual(
      safeParseSection("access", access({ rules: [{ operationId: "getPedido", allow: ["admin"], deny: ["vendedor"] }] })),
      { ok: true },
    );
  });

  test("un caso cruzado necesita dos roles distintos", () => {
    const rule = (target: string) => ({ source: "vendedor", target, createOperationId: "crearPedido", operationId: "getPedido", allowed: false });
    assert.deepEqual(safeParseSection("access", access({ crossRole: [rule("admin")] })), { ok: true });
    assert.deepEqual(safeParseSection("access", access({ crossRole: [rule("vendedor")] })), {
      ok: false,
      issues: [{ field: "access.crossRole.0.target", detail: "origen y destino son el mismo rol" }],
    });
  });
});

describe("credenciales y presupuestos", () => {
  test("un rol como credencial conserva su prefijo, y un nombre raro se rechaza", () => {
    assert.equal(scenarioCredentialSchema.parse("role:vendedor"), "role:vendedor");
    assert.equal(scenarioCredentialSchema.parse("none"), "none");
    assert.equal(scenarioCredentialSchema.safeParse("role:1malo").success, false);
  });

  test("el patrón de un presupuesto se compila al escribirlo", () => {
    const rule = { id: "q", thresholdMs: 50, label: "q", source: "RFP" };
    assert.equal(budgetRuleSchema.safeParse({ ...rule, queryMatches: "limit=\\d+" }).success, true);
    const broken = budgetRuleSchema.safeParse({ ...rule, queryMatches: "limit=(" });
    assert.equal(broken.success, false);
    assert.equal(broken.error!.issues[0].message, "no es una expresión regular válida");
  });
});

describe("presets", () => {
  test("una clave de API no aceptada debe responder 401, con id propio o el de siempre", () => {
    assert.deepEqual(presets.unacceptedCredentialRule({ methods: ["GET"] }), {
      id: "auth-api-key",
      credential: "api-key",
      expectedStatus: 401,
      when: { methods: ["GET"] },
    });
    assert.deepEqual(
      presets.unacceptedCredentialRule({ methods: ["POST", "PUT"], id: "clave", description: "Solo OAuth" }),
      { id: "clave", credential: "api-key", expectedStatus: 401, when: { methods: ["POST", "PUT"] }, description: "Solo OAuth" },
    );
  });
});
