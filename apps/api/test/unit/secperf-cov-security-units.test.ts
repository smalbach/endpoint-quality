/**
 * The pure halves of security runs: the report renderer, the detail filters, and the two AI
 * adapters — the Anthropic one against a replaced global `fetch`, so every way a model answer can
 * be wrong is shown to degrade to the deterministic analysis and never to nothing.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Finding, ProbeResult, SecuritySummary } from "@eq/security-rules";
import { normalizeSelection } from "@eq/security-rules";

import { loadEnv } from "@/shared/config/env";

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://unused/unused",
  JWT_ACCESS_SECRET: "a".repeat(48),
  JWT_REFRESH_SECRET: "b".repeat(48),
};
import type { SecurityRun } from "@/modules/security-runs/domain/model";
import { statusFromFindings } from "@/modules/security-runs/domain/model";
import { deterministicAnalysis, groupsFrom } from "@/modules/security-runs/domain/ai";
import {
  securityReportFormat,
  toSecurityReportHtml,
  toSecurityReportJson,
} from "@/modules/security-runs/presentation/report";
import { buildDetail } from "@/modules/security-runs/application/queries/get-security-run";
import { AnthropicSecurityAi, FallbackSecurityAi } from "@/modules/security-runs/infrastructure/security-ai";

const NOW = new Date("2026-05-01T12:00:00.000Z");

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  ruleKey: "auth_jwt",
  ruleId: "R1",
  ruleName: "Autenticación",
  category: "auth",
  severity: "critical",
  endpointId: "ep-1",
  title: "Sin proteger",
  detail: "Responde sin token",
  remediation: "Exige un token",
  references: [],
  reproduce: [],
  evidence: {},
  ...overrides,
});

const summary = (overrides: Partial<SecuritySummary> = {}): SecuritySummary => ({
  score: 50,
  risk: "high",
  findings: 2,
  bySeverity: { critical: 1, high: 1, medium: 0, low: 0, info: 0 },
  endpointsTested: 3,
  unprotected: [],
  ...overrides,
});

const probe = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  id: "p",
  endpointId: "ep-1",
  testType: "no-auth",
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
  ...overrides,
});

function run(overrides: Partial<SecurityRun> = {}): SecurityRun {
  return {
    id: "run-1",
    projectId: "p1",
    environmentId: "e1",
    label: "Corrida",
    status: "failed",
    rules: normalizeSelection(undefined),
    options: { rateLimitIterations: 5, requestTimeoutMs: 1000, crossUserPermutations: false, endpointIds: [], adminRole: null },
    progress: { phase: "Terminado", percentage: 100, detail: "", endpointsTested: 1, endpointsTotal: 1 },
    score: 50,
    risk: "high",
    summary: summary(),
    findings: [],
    probes: [],
    ai: null,
    visibility: "private",
    shareToken: null,
    triggeredByKind: "user",
    triggeredBy: "u1",
    startedAt: NOW,
    finishedAt: NOW,
    error: null,
    ...overrides,
  };
}

const label = (id: string | null) => (id ? `GET /${id}` : "—");

describe("el informe de seguridad", () => {
  test("el formato: html solo si se pide html; todo lo demás es json", () => {
    assert.equal(securityReportFormat("html"), "html");
    assert.equal(securityReportFormat("json"), "json");
    assert.equal(securityReportFormat("pdf"), "json");
    assert.equal(securityReportFormat(undefined), "json");
  });

  test("el JSON resuelve la etiqueta del endpoint de cada hallazgo y lleva la hora de generación", () => {
    const report = toSecurityReportJson({
      run: run({ findings: [finding(), finding({ endpointId: null, title: "Global" })] }),
      endpointLabel: label,
      generatedAt: NOW,
    }) as { findings: { endpoint: string; title: string }[]; generatedAt: Date; score: number; label: string };
    assert.equal(report.label, "Corrida");
    assert.equal(report.score, 50);
    assert.deepEqual(
      report.findings.map((entry) => entry.endpoint),
      ["GET /ep-1", "—"],
    );
    assert.equal(report.generatedAt, NOW);
  });

  test("el color de la puntuación sigue el umbral: verde ≥80, ámbar ≥60, rojo por debajo o sin puntuación", () => {
    const colorOf = (score: number | null) =>
      /\.score \{[^}]*color: (#[0-9a-f]+)/.exec(
        toSecurityReportHtml({ run: run({ score }), endpointLabel: label, generatedAt: NOW }),
      )![1];
    assert.equal(colorOf(95), "#047857");
    assert.equal(colorOf(80), "#047857");
    assert.equal(colorOf(65), "#b45309");
    assert.equal(colorOf(10), "#b91c1c");
    assert.equal(colorOf(null), "#b91c1c");
  });

  test("sin resumen, sin puntuación y sin hallazgos: guiones, ceros y «Sin hallazgos»", () => {
    const html = toSecurityReportHtml({
      run: run({ score: null, risk: null, summary: null, findings: [] }),
      endpointLabel: label,
      generatedAt: NOW,
    });
    assert.match(html, /<div class="score">—<\/div>/);
    assert.match(html, /Riesgo<\/div><div class="n">—<\/div>/);
    assert.match(html, /Hallazgos<\/div><div class="n">0<\/div>/);
    assert.match(html, /Sin hallazgos\./);
    assert.doesNotMatch(html, /<table>/);
    assert.doesNotMatch(html, /Endpoints sin proteger/);
    assert.doesNotMatch(html, /Análisis/);
  });

  test("con hallazgos, endpoints sin proteger y análisis: todo escapado, y la severidad desconocida se muestra tal cual", () => {
    const html = toSecurityReportHtml({
      run: run({
        label: "<b>peligro</b>",
        summary: summary({
          bySeverity: { critical: 2, high: 0, medium: 1, low: 4, info: 0 },
          unprotected: [{ endpointId: "ep-1", method: "GET", path: "/me?<x>", status: 200 }],
        }),
        findings: [
          finding({ title: "<script>alert(1)</script>" }),
          finding({ severity: "extraña" as Finding["severity"], ruleName: "Rara" }),
        ],
        ai: {
          executiveSummary: "Resumen & más",
          scoreJustification: "Porque sí",
          top: [{ title: "Lo peor", description: "Arréglalo", severity: "critical" }],
          groups: [],
        },
      }),
      endpointLabel: label,
      generatedAt: NOW,
    });
    assert.match(html, /&lt;b&gt;peligro&lt;\/b&gt;/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /Endpoints sin proteger/);
    assert.match(html, /GET \/me\?&lt;x&gt;<\/code> → 200/);
    assert.match(html, /<h2>Análisis<\/h2>/);
    assert.match(html, /Resumen &amp; más/);
    assert.match(html, /<li><strong>Lo peor<\/strong> — Arréglalo<\/li>/);
    assert.match(html, />Crítico<\/span>/);
    assert.match(html, />extraña<\/span>/);
    assert.match(html, /GET \/ep-1/);
    // The severity cards read the summary counts.
    assert.match(html, /Crítico<\/div><div class="n" style="color:#b91c1c">2</);
    assert.match(html, /Bajo<\/div><div class="n" style="color:#0369a1">4</);
  });

  test("un resumen guardado sin alguna severidad cuenta cero en su tarjeta", () => {
    const partial = { critical: 3 } as SecuritySummary["bySeverity"];
    const html = toSecurityReportHtml({
      run: run({ summary: summary({ bySeverity: partial }) }),
      endpointLabel: label,
      generatedAt: NOW,
    });
    assert.match(html, /Crítico<\/div><div class="n" style="color:#b91c1c">3</);
    assert.match(html, /Alto<\/div><div class="n" style="color:#c2410c">0</);
  });
});

describe("el detalle filtrado y paginado", () => {
  const detailRun = run({
    findings: [
      finding({ severity: "low", ruleKey: "cors", endpointId: "a" }),
      finding({ severity: "critical", ruleKey: "auth_jwt", endpointId: "b" }),
      finding({ severity: "medium", ruleKey: "cors", endpointId: "b" }),
    ],
    probes: [
      probe({ id: "1", endpointId: "a", method: "GET", testType: "no-auth", status: 200 }),
      probe({ id: "2", endpointId: "a", method: "POST", testType: "injection:sql", status: 500 }),
      probe({ id: "3", endpointId: "b", method: "GET", testType: "injection:xss", status: 404 }),
      probe({ id: "4", endpointId: "b", method: "GET", testType: "auth:admin", status: 201 }),
    ],
  });

  test("sin filtros: hallazgos del peor al más leve, sondas en la primera página", () => {
    const detail = buildDetail(detailRun, { page: 1, pageSize: 50 });
    assert.deepEqual(
      detail.findings.map((entry) => entry.severity),
      ["critical", "medium", "low"],
    );
    assert.equal(detail.findingsTotal, 3);
    assert.equal(detail.probes.total, 4);
  });

  test("cada filtro recorta lo suyo", () => {
    assert.deepEqual(
      buildDetail(detailRun, { page: 1, pageSize: 50, ruleKey: "cors" }).findings.map((entry) => entry.severity),
      ["medium", "low"],
    );
    const byEndpoint = buildDetail(detailRun, { page: 1, pageSize: 50, endpointId: "b" });
    assert.equal(byEndpoint.findingsTotal, 2);
    assert.deepEqual(
      byEndpoint.probes.data.map((entry) => entry.id),
      ["3", "4"],
    );
    assert.deepEqual(
      buildDetail(detailRun, { page: 1, pageSize: 50, method: "POST" }).probes.data.map((entry) => entry.id),
      ["2"],
    );
    assert.deepEqual(
      buildDetail(detailRun, { page: 1, pageSize: 50, testType: "injection" }).probes.data.map((entry) => entry.id),
      ["2", "3"],
    );
    assert.deepEqual(
      buildDetail(detailRun, { page: 1, pageSize: 50, statusFamily: 2 }).probes.data.map((entry) => entry.id),
      ["1", "4"],
    );
    assert.equal(buildDetail(detailRun, { page: 1, pageSize: 50, severity: "high" }).findingsTotal, 0);
  });

  test("la página y su tamaño se acotan: nunca por debajo de 1, nunca más de 200", () => {
    const low = buildDetail(detailRun, { page: -3, pageSize: 0 });
    assert.equal(low.probes.page, 1);
    assert.equal(low.probes.pageSize, 1);
    assert.deepEqual(
      low.probes.data.map((entry) => entry.id),
      ["1"],
    );
    const second = buildDetail(detailRun, { page: 2, pageSize: 3 });
    assert.deepEqual(
      second.probes.data.map((entry) => entry.id),
      ["4"],
    );
    assert.equal(buildDetail(detailRun, { page: 1, pageSize: 5000 }).probes.pageSize, 200);
  });
});

describe("el análisis determinista", () => {
  test("sin hallazgos lo dice, con puntuación 100 y riesgo low por omisión", () => {
    const analysis = deterministicAnalysis(run({ findings: [], summary: null, score: null, risk: null }));
    assert.match(analysis.executiveSummary, /no encontró hallazgos/);
    assert.match(analysis.scoreJustification, /Puntuación 100\/100/);
    assert.match(analysis.scoreJustification, /Riesgo low/);
    assert.deepEqual(analysis.top, []);
    assert.deepEqual(analysis.groups, []);
  });

  test("cuenta críticos, altos y medios; si solo hay bajos lo dice", () => {
    const serious = deterministicAnalysis(
      run({
        summary: summary({ bySeverity: { critical: 1, high: 2, medium: 3, low: 0, info: 0 } }),
        findings: [finding({ severity: "medium" }), finding({ severity: "critical" })],
      }),
    );
    assert.match(serious.executiveSummary, /2 hallazgo\(s\): 1 crítico\(s\), 2 alto\(s\), 3 medio\(s\)/);
    assert.equal(serious.top[0].severity, "critical");

    const mild = deterministicAnalysis(
      run({
        summary: summary({ bySeverity: { critical: 0, high: 0, medium: 0, low: 1, info: 0 } }),
        findings: [finding({ severity: "low" })],
      }),
    );
    assert.match(mild.executiveSummary, /de severidad baja/);
  });

  test("un grupo por regla, con la primera corrección como la común; el top se corta en cinco", () => {
    const findings = [
      finding({ ruleKey: "cors", remediation: "Cierra CORS" }),
      finding({ ruleKey: "cors", remediation: "otra" }),
      finding({ ruleKey: "auth_jwt", remediation: "Exige token" }),
    ];
    assert.deepEqual(groupsFrom(findings), [
      { ruleKey: "cors", solution: "Cierra CORS", commonFix: "Cierra CORS", codeExample: null },
      { ruleKey: "auth_jwt", solution: "Exige token", commonFix: "Exige token", codeExample: null },
    ]);
    const many = deterministicAnalysis(run({ findings: Array.from({ length: 8 }, () => finding()) }));
    assert.equal(many.top.length, 5);
  });

  test("el estado de la corrida: falla con un crítico o un alto, pasa con medios", () => {
    assert.equal(statusFromFindings([finding({ severity: "high" })]), "failed");
    assert.equal(statusFromFindings([finding({ severity: "critical" })]), "failed");
    assert.equal(statusFromFindings([finding({ severity: "medium" }), finding({ severity: "low" })]), "passed");
    assert.equal(statusFromFindings([]), "passed");
  });
});

describe("los adaptadores de IA", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const withFindings = run({
    findings: [
      finding({ ruleKey: "cors", remediation: "Cierra CORS" }),
      finding({ ruleKey: "auth_jwt", remediation: "Exige token" }),
    ],
    probes: [probe({ bodyText: "SECRETO-DEL-CUERPO" })],
  });
  const base = deterministicAnalysis(withFindings);

  const ai = (env: NodeJS.ProcessEnv) => new AnthropicSecurityAi(loadEnv({ ...TEST_ENV, ...env }));
  const keyed = () => ai({ SECURITY_AI_DRIVER: "anthropic", ANTHROPIC_API_KEY: "sk-test", SECURITY_AI_MODEL: "modelo-x" });

  /** Replaces `fetch` with one that answers `reply` and records what it was sent. */
  function answer(reply: () => Response | Promise<Response>) {
    const sent: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return reply();
    }) as typeof fetch;
    return sent;
  }
  const modelSays = (text: string) =>
    new Response(JSON.stringify({ content: [{ text }] }), { status: 200, headers: { "content-type": "application/json" } });

  test("el de respaldo devuelve el análisis determinista", async () => {
    assert.deepEqual(await new FallbackSecurityAi().analyze(withFindings), base);
  });

  test("sin driver anthropic o sin clave no llama a nadie", async () => {
    const sent = answer(() => modelSays("{}"));
    assert.deepEqual(await ai({}).analyze(withFindings), base);
    assert.deepEqual(await ai({ SECURITY_AI_DRIVER: "anthropic" }).analyze(withFindings), base);
    assert.equal(sent.length, 0);
  });

  test("con clave: manda el resumen y los hallazgos, no los cuerpos, y funde la respuesta cercada", async () => {
    const sent = answer(() =>
      modelSays(
        [
          "Aquí va:",
          "```json",
          JSON.stringify({
            executiveSummary: "Del modelo",
            scoreJustification: 42,
            groups: [
              { ruleKey: "cors", solution: "Solución del modelo", codeExample: "app.use(cors())" },
              { ruleKey: "desconocida", solution: "no debe aparecer" },
              null,
              "texto suelto",
              { ruleKey: "auth_jwt", solution: 7 },
            ],
          }),
          "```",
        ].join("\n"),
      ),
    );
    const result = await keyed().analyze(withFindings);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://api.anthropic.com/v1/messages");
    const headers = sent[0].init.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "sk-test");
    const body = JSON.parse(String(sent[0].init.body));
    assert.equal(body.model, "modelo-x");
    assert.match(body.messages[0].content, /Puntuación: 50\. Riesgo: high\./);
    assert.doesNotMatch(body.messages[0].content, /SECRETO-DEL-CUERPO/);

    assert.equal(result.executiveSummary, "Del modelo");
    // Not a string: the deterministic one stays.
    assert.equal(result.scoreJustification, base.scoreJustification);
    assert.deepEqual(result.top, base.top);
    assert.deepEqual(result.groups, [
      { ruleKey: "cors", solution: "Solución del modelo", commonFix: "Cierra CORS", codeExample: "app.use(cors())" },
      { ruleKey: "auth_jwt", solution: "Exige token", commonFix: "Exige token", codeExample: null },
    ]);
  });

  test("un objeto sin cercar también vale; unos groups que no son lista dejan los deterministas", async () => {
    answer(() =>
      modelSays(`Claro. {"scoreJustification": "Justo", "groups": "nada"} Fin.`),
    );
    const result = await keyed().analyze(withFindings);
    assert.equal(result.executiveSummary, base.executiveSummary, "sin resumen del modelo, el determinista");
    assert.equal(result.scoreJustification, "Justo");
    assert.deepEqual(result.groups, base.groups);
  });

  test("toda respuesta inservible degrada al análisis determinista", async () => {
    const broken: (() => Response | Promise<Response>)[] = [
      () => new Response("límite", { status: 429 }),
      () => modelSays("no hay JSON aquí"),
      () => modelSays("```json\n\"una cadena\"\n```"),
      () => modelSays("```\nnull\n```"),
      () => new Response(JSON.stringify({}), { status: 200 }),
      () => new Response(JSON.stringify({ content: [{}] }), { status: 200 }),
      () => Promise.reject(new Error("sin red")),
      () => new Response("no es json", { status: 200 }),
    ];
    for (const reply of broken) {
      answer(reply);
      assert.deepEqual(await keyed().analyze(withFindings), base);
    }
  });
});
