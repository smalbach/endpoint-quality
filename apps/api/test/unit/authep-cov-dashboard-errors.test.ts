/**
 * El tablero, el historial y el filtro de Problem Details, con dobles mínimos.
 *
 * El tablero y el historial leen de cinco repositorios a la vez; aquí cada uno es una lista fija,
 * y lo que se comprueba son las cuentas: qué corrida cuenta como la última, qué tasa sale de qué
 * totales, qué pasa cuando no hay nada. El filtro se prueba con un `ArgumentsHost` hecho a mano,
 * que es todo lo que necesita.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BadRequestException, HttpException, Logger, type ArgumentsHost } from "@nestjs/common";

import { GetDashboardHandler, GetDashboardQuery } from "@/modules/dashboard/application/queries/get-dashboard";
import { GetHistoryHandler, GetHistoryQuery, type HistoryFilters } from "@/modules/dashboard/application/queries/get-history";
import { ProblemDetailsFilter } from "@/shared/errors/problem-details.filter";
import { ConflictError, NotFoundError } from "@/shared/errors/domain-error";

Logger.overrideLogger(false);

const at = (minute: number) => new Date(Date.UTC(2026, 2, 1, 10, minute));

type Row = Record<string, unknown>;
function repos(data: {
  projects: { id: string; name: string; archivedAt: Date | null }[];
  security?: Record<string, Row[]>;
  contract?: Record<string, Row[]>;
  performance?: Record<string, Row[]>;
  scans?: Record<string, Row[]>;
  counts?: Record<string, Record<string, number>>;
  flows?: Record<string, Row[]>;
}) {
  return {
    projects: { listForOrganization: async () => data.projects },
    endpoints: { counts: async (id: string) => data.counts?.[id] ?? {} },
    runs: { listForProject: async (id: string) => data.contract?.[id] ?? [] },
    securityRuns: { listForProject: async (id: string) => data.security?.[id] ?? [] },
    performanceRuns: { list: async (id: string) => data.performance?.[id] ?? [] },
    workflows: { listWorkflows: async (id: string) => data.flows?.[id] ?? [] },
    scans: { list: async (id: string) => data.scans?.[id] ?? [] },
  };
}

const dashboard = (r: ReturnType<typeof repos>) =>
  new GetDashboardHandler(
    r.projects as never,
    r.endpoints as never,
    r.runs as never,
    r.securityRuns as never,
    r.performanceRuns as never,
    r.workflows as never,
  );
const history = (r: ReturnType<typeof repos>) =>
  new GetHistoryHandler(r.projects as never, r.runs as never, r.securityRuns as never, r.performanceRuns as never, r.scans as never);

describe("el tablero", () => {
  test("un proyecto sin nada: todo en null o cero, y sin puntuación media", async () => {
    const view = await dashboard(repos({ projects: [{ id: "p1", name: "Vacío", archivedAt: null }] })).execute(new GetDashboardQuery("o1"));
    assert.deepEqual(view.totals, { projects: 1, endpoints: 0, avgSecurityScore: null });
    assert.deepEqual(view.projects[0], {
      id: "p1",
      name: "Vacío",
      archived: false,
      endpoints: 0,
      flows: 0,
      securityScore: null,
      passRate: null,
      perfP95Ms: null,
      lastActivityAt: null,
      trends: { securityScores: [], passRates: [], perfP95Ms: [] },
    });
  });

  test("la última corrida terminada manda; las en curso cuentan para la actividad y no para las cifras", async () => {
    const view = await dashboard(
      repos({
        projects: [
          { id: "p1", name: "Tienda", archivedAt: null },
          { id: "p2", name: "Viejo", archivedAt: at(0) },
        ],
        counts: { p1: { active: 7, archived: 2 } },
        flows: { p1: [{ id: "f1" }, { id: "f2" }] },
        security: {
          p1: [
            { id: "s3", status: "running", score: null, startedAt: at(30) },
            { id: "s2", status: "passed", score: 80, startedAt: at(20) },
            { id: "s1", status: "failed", score: null, startedAt: at(10) },
          ],
          p2: [{ id: "s4", status: "passed", score: 61, startedAt: at(5) }],
        },
        contract: {
          p1: [
            { id: "r3", status: "running", totals: { passed: 0, failed: 0 }, startedAt: at(25) },
            { id: "r2", status: "passed", totals: { passed: 3, failed: 1 }, startedAt: at(15) },
            { id: "r1", status: "error", totals: { passed: 0, failed: 0 }, startedAt: at(5) },
          ],
        },
        performance: {
          p1: [
            { id: "x2", status: "running", summary: null, startedAt: at(40) },
            { id: "x1", status: "passed", summary: { p95Ms: 120 }, startedAt: at(1) },
          ],
        },
      }),
    ).execute(new GetDashboardQuery("o1"));

    assert.deepEqual(view.totals, { projects: 1, endpoints: 7, avgSecurityScore: 71 });
    const [tienda, viejo] = view.projects;
    assert.equal(tienda.endpoints, 7);
    assert.equal(tienda.flows, 2);
    assert.equal(tienda.securityScore, 80);
    assert.equal(tienda.passRate, 0.75);
    assert.equal(tienda.perfP95Ms, 120);
    assert.equal(tienda.lastActivityAt, at(40).toISOString());
    assert.deepEqual(tienda.trends, { securityScores: [80], passRates: [0.75], perfP95Ms: [120] });
    assert.equal(viejo.archived, true);
    assert.equal(viejo.securityScore, 61);
  });

  test("una corrida de contrato terminada sin casos no da tasa", async () => {
    const view = await dashboard(
      repos({
        projects: [{ id: "p1", name: "T", archivedAt: null }],
        contract: { p1: [{ id: "r1", status: "cancelled", totals: { passed: 0, failed: 0 }, startedAt: at(3) }] },
      }),
    ).execute(new GetDashboardQuery("o1"));
    assert.equal(view.projects[0].passRate, null);
    assert.equal(view.projects[0].lastActivityAt, at(3).toISOString());
  });
});

describe("el historial", () => {
  const data = () =>
    repos({
      projects: [{ id: "p1", name: "Tienda", archivedAt: null }],
      security: {
        p1: [
          { id: "s1", status: "passed", score: 90, label: "", startedAt: at(10) },
          { id: "s2", status: "running", score: null, label: "Nocturna", startedAt: at(11) },
        ],
      },
      contract: {
        p1: [
          { id: "r1", status: "passed", totals: { passed: 1, failed: 2 }, startedAt: at(20) },
          { id: "r2", status: "error", totals: { passed: 0, failed: 0 }, startedAt: at(21) },
        ],
      },
      performance: {
        p1: [
          { id: "x1", status: "passed", planName: "Pico", summary: { p95Ms: 99.6 }, startedAt: at(30) },
          { id: "x2", status: "running", planName: "Valle", summary: null, startedAt: at(31) },
        ],
      },
      scans: {
        p1: [
          { id: "c1", source: "github", ref: "main", status: "done", diff: { added: [1], changed: [], removed: [1, 2] }, createdAt: at(40) },
          { id: "c2", source: "upload", ref: "", status: "done", diff: { added: [], changed: [1], removed: [] }, createdAt: at(41) },
        ],
      },
    });
  const filters = (patch: Partial<HistoryFilters> = {}): HistoryFilters => ({ search: "", kind: "all", page: 1, pageSize: 50, ...patch });

  test("todo junto, lo último primero, con la cifra de cada tipo", async () => {
    const view = await history(data()).execute(new GetHistoryQuery("o1", filters()));
    assert.equal(view.total, 8);
    assert.deepEqual(
      view.entries.map((entry) => [entry.id, entry.kind, entry.title, entry.metric, entry.href]),
      [
        ["c2", "scan", "Escaneo (subida)", "+0 ~1 −0", "/p/p1/code-scan"],
        ["c1", "scan", "Escaneo (main)", "+1 ~0 −2", "/p/p1/code-scan"],
        ["x2", "performance", "Carga: Valle", null, "/p/p1/performance/x2"],
        ["x1", "performance", "Carga: Pico", "p95 100 ms", "/p/p1/performance/x1"],
        ["r2", "contract", "Corrida de contrato", null, "/p/p1/runs/r2"],
        ["r1", "contract", "Corrida de contrato", "33%", "/p/p1/runs/r1"],
        ["s2", "security", "Nocturna", null, "/p/p1/security/s2"],
        ["s1", "security", "Corrida de seguridad", "90/100", "/p/p1/security/s1"],
      ],
    );
  });

  test("por tipo, por texto y paginado, con la página y el tamaño acotados", async () => {
    const byKind = await history(data()).execute(new GetHistoryQuery("o1", filters({ kind: "security" })));
    assert.deepEqual(byKind.entries.map((entry) => entry.id), ["s2", "s1"]);

    const bySearch = await history(data()).execute(new GetHistoryQuery("o1", filters({ search: "  NOCTURNA " })));
    assert.deepEqual(bySearch.entries.map((entry) => entry.id), ["s2"]);

    const paged = await history(data()).execute(new GetHistoryQuery("o1", filters({ page: 0, pageSize: 0 })));
    assert.equal(paged.page, 1);
    assert.equal(paged.pageSize, 1);
    assert.deepEqual(paged.entries.map((entry) => entry.id), ["c2"]);

    const second = await history(data()).execute(new GetHistoryQuery("o1", filters({ page: 2, pageSize: 500 })));
    assert.equal(second.pageSize, 100);
    assert.deepEqual(second.entries, []);
    assert.equal(second.total, 8);
  });
});

describe("Problem Details", () => {
  function run(exception: unknown, url = "/orgs/o1/x") {
    const sent: { status?: number; type?: string; body?: Record<string, unknown> } = {};
    const response = {
      status(code: number) {
        sent.status = code;
        return response;
      },
      type(value: string) {
        sent.type = value;
        return response;
      },
      json(body: Record<string, unknown>) {
        sent.body = body;
        return response;
      },
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ url, method: "POST" }) }),
    } as unknown as ArgumentsHost;
    new ProblemDetailsFilter().catch(exception, host);
    return sent;
  }

  test("un error de dominio sin código usa su tipo, y sin campos no lleva `errors`", () => {
    const sent = run(new NotFoundError("No está"));
    assert.equal(sent.status, 404);
    assert.equal(sent.type, "application/problem+json");
    assert.deepEqual(sent.body, {
      type: "https://endpoint-quality.dev/problems/not-found",
      title: "Recurso no encontrado",
      status: 404,
      detail: "No está",
      instance: "/orgs/o1/x",
    });
    assert.equal(run(new ConflictError("Choca", "dup")).body?.type, "https://endpoint-quality.dev/problems/dup");
  });

  test("una HttpException con mensajes de validación los nombra por campo", () => {
    const sent = run(new BadRequestException({ message: ["email debe ser un correo", ""] }));
    assert.equal(sent.status, 400);
    assert.equal(sent.body?.detail, "La solicitud no supera la validación");
    assert.deepEqual(sent.body?.errors, [
      { field: "email", detail: "email debe ser un correo" },
      { field: "", detail: "" },
    ]);
  });

  test("una HttpException de un estado sin título propio usa su nombre y su mensaje", () => {
    const sent = run(new HttpException("Soy una tetera", 418));
    assert.equal(sent.status, 418);
    assert.equal(sent.body?.title, "HttpException");
    assert.equal(sent.body?.detail, "Soy una tetera");
    assert.equal("errors" in (sent.body ?? {}), false);
  });

  test("un error de Express con `status`: 413 con su frase, otro 4xx con su mensaje y título genérico si no lo hay", () => {
    const tooLarge = run(Object.assign(new Error("request entity too large"), { status: 413 }));
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.body?.title, "Cuerpo demasiado grande");
    assert.equal(tooLarge.body?.detail, "El cuerpo de la solicitud supera el tamaño máximo");

    const odd = run(Object.assign(new Error("rango"), { status: 416 }));
    assert.equal(odd.status, 416);
    assert.equal(odd.body?.title, "Error");
    assert.equal(odd.body?.detail, "rango");

    // Un `status` fuera de 4xx no es de Express: es un 500 como cualquier otro.
    assert.equal(run(Object.assign(new Error("x"), { status: 503 })).status, 500);
    assert.equal(run(Object.assign(new Error("x"), { status: "400" })).status, 500);
  });

  test("lo que no es un Error es un 500 sin nada dentro, y la URL de un webhook no repite su token", () => {
    const sent = run("una cadena", "/hooks/flows/tok-secreto?x=1");
    assert.equal(sent.status, 500);
    assert.deepEqual(sent.body, {
      type: "https://endpoint-quality.dev/problems/internal",
      title: "Error interno",
      status: 500,
      detail: "La solicitud no pudo completarse",
      instance: "/hooks/flows/[token-redactado]?x=1",
    });
  });
});
