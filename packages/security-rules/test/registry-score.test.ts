import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluateRules, RULE_BY_KEY, RULES } from "../src/registry.ts";
import { DEFAULT_RULES, normalizeSelection, PRESETS, RULE_GROUPS } from "../src/presets.ts";
import { summarize } from "../src/score.ts";
import { byTestType, isDenied, isSuccess, RULE_KEYS, SEVERITIES, type Finding, type Severity } from "../src/types.ts";
import { similar } from "../src/rules/helpers.ts";
import { context, endpoint, result } from "./fixtures.ts";

const finding = (severity: Severity, endpointId: string | null = "a"): Finding => ({
  ruleKey: "cors",
  ruleId: "X",
  ruleName: "X",
  category: "X",
  severity,
  endpointId,
  title: "t",
  detail: "d",
  remediation: "r",
  references: [],
  reproduce: [],
  evidence: {},
});

const allOn = PRESETS.find((preset) => preset.id === "all")!.rules;

describe("el registro de reglas", () => {
  it("cada clave de RULE_KEYS tiene su regla, en el mismo orden del informe", () => {
    assert.deepEqual(
      RULES.map((rule) => rule.key),
      [...RULE_KEYS],
    );
    for (const key of RULE_KEYS) assert.equal(RULE_BY_KEY[key].key, key);
    for (const rule of RULES) assert.equal(rule.references.length, 2, rule.key);
  });

  it("una regla apagada no aporta hallazgos aunque haya evidencia", () => {
    const flood = Array.from({ length: 10 }, (_, index) =>
      result({ endpointId: "a", testType: `rate-limit:${index}` }),
    );
    const ctx = context({ endpoints: [endpoint({ id: "a", method: "GET", path: "/x" })] });
    assert.equal(evaluateRules(flood, ctx, DEFAULT_RULES).filter((f) => f.ruleKey === "rate_limit").length, 0);
    assert.equal(evaluateRules(flood, ctx, allOn).filter((f) => f.ruleKey === "rate_limit").length, 1);
  });

  it("una regla que revienta deja un hallazgo info que la nombra y el resto sigue", () => {
    const broken = result({
      endpointId: "a",
      testType: "cors",
      responseHeaders: null as unknown as Record<string, string>,
    });
    const findings = evaluateRules(
      [broken, result({ endpointId: "a", testType: "method-tamper:DELETE", status: 200 })],
      context(),
      normalizeSelection({
        ...Object.fromEntries(RULE_KEYS.map((key) => [key, false])),
        cors: true,
        method_tampering: true,
      }),
    );
    const failure = findings.find((f) => f.ruleKey === "cors")!;
    assert.equal(failure.severity, "info");
    assert.equal(failure.endpointId, null);
    assert.equal(failure.title, "La regla «Configuración CORS» no se pudo evaluar");
    assert.ok(failure.detail.length > 0);
    assert.deepEqual(failure.references, RULE_BY_KEY.cors.references);
    assert.ok(
      findings.some((f) => f.ruleKey === "method_tampering"),
      "las demás reglas siguen corriendo",
    );
  });

  it("si la regla lanza algo que no es un Error, el detalle es su texto", () => {
    const rule = RULE_BY_KEY.cors;
    const original = rule.evaluate;
    rule.evaluate = () => {
      throw "sin memoria";
    };
    try {
      const [failure] = evaluateRules([], context(), allOn);
      assert.equal(failure.ruleKey, "cors");
      assert.equal(failure.detail, "sin memoria");
    } finally {
      rule.evaluate = original;
    }
  });
});

describe("la puntuación, en los bordes", () => {
  it("cada severidad resta su peso: crítico 25, alto 12, medio 5, bajo 1, info 0", () => {
    const only = (severity: Severity) => summarize([finding(severity)], [], []).score;
    assert.deepEqual(
      SEVERITIES.map((severity) => only(severity)),
      [75, 88, 95, 99, 100],
    );
    assert.equal(summarize([finding("high"), finding("medium"), finding("low"), finding("info")], [], []).score, 82);
  });

  it("nunca baja de 0", () => {
    const summary = summarize(
      Array.from({ length: 5 }, () => finding("critical")),
      [],
      [],
    );
    assert.equal(summary.score, 0);
    assert.equal(summary.bySeverity.critical, 5);
    assert.equal(summary.findings, 5);
  });

  it("el riesgo es la peor severidad presente, e info no sube el riesgo", () => {
    assert.equal(summarize([finding("low"), finding("high")], [], []).risk, "high");
    assert.equal(summarize([finding("low"), finding("medium")], [], []).risk, "medium");
    assert.equal(summarize([finding("info"), finding("low")], [], []).risk, "low");
    assert.equal(summarize([finding("info")], [], []).risk, "low");
  });

  it("cuenta endpoints probados distintos y solo lista como desprotegidos los que requieren sesión", () => {
    const summary = summarize(
      [],
      [
        result({ endpointId: "a", testType: "no-auth", status: 200 }),
        result({ endpointId: "a", testType: "auth:admin", status: 200 }),
        result({ endpointId: "b", testType: "no-auth", status: 200 }),
        result({ endpointId: "c", testType: "no-auth", status: 401 }),
        result({ endpointId: "d", testType: "auth:admin", status: 200 }),
      ],
      [
        { id: "a", method: "GET", path: "/me", requiresAuth: true },
        { id: "b", method: "GET", path: "/health", requiresAuth: false },
        { id: "c", method: "GET", path: "/orders", requiresAuth: true },
        { id: "d", method: "GET", path: "/carts", requiresAuth: true },
      ],
    );
    assert.equal(summary.endpointsTested, 4);
    assert.deepEqual(summary.unprotected, [{ endpointId: "a", method: "GET", path: "/me", status: 200 }]);
  });
});

describe("las selecciones de reglas", () => {
  it("una selección parcial se completa con las recomendadas", () => {
    assert.deepEqual(normalizeSelection(undefined), DEFAULT_RULES);
    const partial = normalizeSelection({ rate_limit: true, cors: false });
    assert.equal(partial.rate_limit, true);
    assert.equal(partial.cors, false);
    assert.equal(partial.injection, true);
    assert.equal(Object.keys(partial).length, RULE_KEYS.length);
  });

  it("los grupos reparten las 17 reglas sin repetir ni dejar ninguna", () => {
    const grouped = RULE_GROUPS.flatMap((group) => group.keys);
    assert.equal(grouped.length, RULE_KEYS.length);
    assert.deepEqual(new Set(grouped), new Set(RULE_KEYS));
  });

  it("cada preset es una selección completa; «Solo autorización» no manda inyección", () => {
    for (const preset of PRESETS) assert.equal(Object.keys(preset.rules).length, RULE_KEYS.length, preset.id);
    const auth = PRESETS.find((preset) => preset.id === "auth")!.rules;
    assert.equal(auth.injection, false);
    assert.equal(auth.bola_idor, true);
  });
});

describe("las utilidades de los veredictos", () => {
  it("2xx es éxito; 401 y 403 son rechazo; 404 no es ninguno", () => {
    assert.deepEqual([199, 200, 299, 300].map(isSuccess), [false, true, true, false]);
    assert.deepEqual([401, 403, 404, 200].map(isDenied), [true, true, false, false]);
  });

  it("byTestType casa el tipo exacto o el prefijo con dos puntos, no un sufijo", () => {
    const results = ["auth", "auth:admin", "no-auth", "authz", "auth-extra"].map((testType) =>
      result({ endpointId: "a", testType }),
    );
    assert.deepEqual(
      byTestType(results, "auth").map((r) => r.testType),
      ["auth", "auth:admin"],
    );
  });

  it("similar da 1 cuando ambos tamaños son 0 y es simétrica", () => {
    assert.equal(similar(0, 0), 1);
    assert.equal(similar(50, 100), 0.5);
    assert.equal(similar(100, 50), 0.5);
  });
});
