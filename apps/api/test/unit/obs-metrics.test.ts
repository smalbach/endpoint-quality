/**
 * Las métricas: el histograma, la puerta de `/metrics` y lo que cada pieza observa.
 *
 * Lo que se comprueba aquí es lo que decide si una gráfica sirve o miente: que una ruta que nadie
 * sirve no abre una serie por cada URL inventada, que lo que falla también se mide —si no, la ruta
 * que tarda cuatro segundos en romperse no aparece en ningún percentil— y que el endpoint no
 * existe mientras nadie ponga una credencial.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { of } from "rxjs";
import type { ArgumentsHost, CallHandler, ExecutionContext } from "@nestjs/common";
import type { Response } from "express";

import { FixedClock } from "@/shared/clock/clock.port";
import { loadEnv, type Env } from "@/shared/config/env";
import { DomainError } from "@/shared/errors/domain-error";
import { ProblemDetailsFilter } from "@/shared/errors/problem-details.filter";
import { NullLogger } from "@/shared/logging/logger.port";
import { OperationLogInterceptor } from "@/shared/logging/operation.interceptor";
import { operationFields } from "@/shared/logging/operation-fields";
import { runWithTrace } from "@/shared/logging/trace-context";
import { MetricsController } from "@/shared/metrics/metrics.controller";
import { NullMetrics, UNMATCHED_ROUTE, type HttpObservation, type MetricsPort } from "@/shared/metrics/metrics.port";
import { PromMetrics } from "@/shared/metrics/prom-metrics";

/** Lo observado, recogido, para poder afirmarlo sin montar un registro de Prometheus. */
class RecordingMetrics implements MetricsPort {
  readonly observed: HttpObservation[] = [];

  observeHttp(observation: HttpObservation): void {
    this.observed.push(observation);
  }

  render(): Promise<{ body: string; contentType: string }> {
    return Promise.resolve({ body: "# recogido", contentType: "text/plain" });
  }
}

const envWith = (extra: Record<string, string> = {}): Env =>
  loadEnv({
    DATABASE_URL: "postgres://unused/unused",
    JWT_ACCESS_SECRET: "a".repeat(48),
    JWT_REFRESH_SECRET: "b".repeat(48),
    ...extra,
  } as NodeJS.ProcessEnv);

const TOKEN = "t".repeat(40);

describe("el histograma", () => {
  test("una petición observada sale con sus etiquetas y en el cubo que le toca", async () => {
    const metrics = new PromMetrics();
    metrics.observeHttp({ method: "GET", route: "/orgs/:id/x", status: 200, outcome: "ok", ms: 30 });
    metrics.observeHttp({ method: "GET", route: "/orgs/:id/x", status: 500, outcome: "error", ms: 4_000 });
    const { body, contentType } = await metrics.render();

    assert.match(contentType, /text\/plain/);
    assert.match(
      body,
      /eq_http_server_duration_ms_bucket\{le="50",service="eq-api",method="GET",route="\/orgs\/:id\/x",status="200",outcome="ok"\} 1/,
    );
    assert.match(
      body,
      /eq_http_server_duration_ms_count\{service="eq-api",method="GET",route="\/orgs\/:id\/x",status="500",outcome="error"\} 1/,
    );
    // Y la máquina debajo, que es lo que separa «va lenta la API» de «va lenta la máquina».
    assert.match(body, /eq_process_resident_memory_bytes/);
  });

  test("dos instancias no chocan: cada una lleva su propio registro", async () => {
    const first = new PromMetrics();
    const second = new PromMetrics();
    first.observeHttp({ method: "GET", route: "/health", status: 200, outcome: "ok", ms: 1 });
    assert.equal((await second.render()).body.includes('route="/health"'), false);
  });

  test("las métricas apagadas cumplen el puerto y no dicen nada", async () => {
    const off = new NullMetrics();
    off.observeHttp({ method: "GET", route: "/x", status: 200, outcome: "ok", ms: 1 });
    assert.deepEqual(await off.render(), { body: "", contentType: "text/plain" });
  });
});

describe("la puerta de /metrics", () => {
  const response = () => {
    const seen: { type?: string } = {};
    return { seen, res: { type: (value: string) => void (seen.type = value) } as unknown as Response };
  };

  test("sin `METRICS_TOKEN` la ruta no existe, y no anuncia que podría", async () => {
    const controller = new MetricsController(new RecordingMetrics(), envWith());
    const { res } = response();
    const failed = await controller.scrape(`Bearer ${TOKEN}`, res).catch((error: unknown) => error);
    assert.ok(failed instanceof DomainError);
    assert.equal(failed.kind, "not-found");
  });

  test("con token, sin credencial o con otra, es un 401", async () => {
    const controller = new MetricsController(new RecordingMetrics(), envWith({ METRICS_TOKEN: TOKEN }));
    const { res } = response();
    for (const header of [undefined, "", "Bearer ", `Bearer ${"x".repeat(40)}`, TOKEN]) {
      const failed = await controller.scrape(header, res).catch((error: unknown) => error);
      assert.ok(failed instanceof DomainError, `aceptó «${String(header)}»`);
      assert.equal(failed.kind, "unauthenticated");
    }
  });

  test("con la credencial correcta sirve el texto con su tipo de contenido", async () => {
    const controller = new MetricsController(new RecordingMetrics(), envWith({ METRICS_TOKEN: TOKEN }));
    const { seen, res } = response();
    assert.equal(await controller.scrape(`Bearer ${TOKEN}`, res), "# recogido");
    assert.equal(seen.type, "text/plain");
  });

  test("un `METRICS_TOKEN` en blanco cuenta como ausente, y uno corto no arranca", () => {
    assert.equal(envWith({ METRICS_TOKEN: "   " }).METRICS_TOKEN, undefined);
    assert.equal(envWith({ METRICS_TOKEN: TOKEN }).METRICS_TOKEN, TOKEN);
    assert.throws(() => envWith({ METRICS_TOKEN: "corto" }), /METRICS_TOKEN/);
  });

  test("un `LOG_FORMAT=` vacío es «no lo he elegido», no un valor inválido que impida arrancar", () => {
    assert.equal(envWith({ LOG_FORMAT: "" }).LOG_FORMAT, undefined);
    assert.equal(envWith({ LOG_FORMAT: "text" }).LOG_FORMAT, "text");
    assert.throws(() => envWith({ LOG_FORMAT: "xml" }), /LOG_FORMAT/);
  });
});

describe("lo que cada pieza observa", () => {
  const httpContext = (request: unknown, statusCode?: number) =>
    ({
      getType: () => "http",
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode }) }),
    }) as unknown as ExecutionContext;
  const handler: CallHandler = { handle: () => of("ok") };

  test("una petición atendida se mide con el patrón de su ruta", () => {
    const metrics = new RecordingMetrics();
    runWithTrace("t-abcdefgh", 1_500, () => {
      new OperationLogInterceptor(new NullLogger(), new FixedClock(new Date(2_000)), metrics)
        .intercept(httpContext({ method: "GET", url: "/orgs/o1/x", route: { path: "/orgs/:id/x" } }, 200), handler)
        .subscribe();
    });
    assert.deepEqual(metrics.observed, [{ method: "GET", route: "/orgs/:id/x", status: 200, outcome: "ok", ms: 500 }]);
  });

  test("lo que no llegó a un manejador cuenta junto, para no abrir una serie por URL inventada", () => {
    const metrics = new RecordingMetrics();
    runWithTrace("t-abcdefgh", 1_900, () => {
      const interceptor = new OperationLogInterceptor(new NullLogger(), new FixedClock(new Date(2_000)), metrics);
      interceptor.intercept(httpContext({ method: "GET", url: "/inventada/1" }), handler).subscribe();
      // Y una petición sin método —la que llega por un transporte que no lo tiene— tampoco inventa uno.
      interceptor.intercept(httpContext({ url: "/inventada/1" }), handler).subscribe();
    });
    assert.deepEqual(metrics.observed, [
      { method: "GET", route: UNMATCHED_ROUTE, status: 200, outcome: "ok", ms: 100 },
      { method: "?", route: UNMATCHED_ROUTE, status: 200, outcome: "ok", ms: 100 },
    ]);
    assert.equal(operationFields({ method: "GET", url: "/inventada/1" }, 1).matched, false);
  });

  test("fuera de una petición no hay duración, y sin duración no se observa nada", () => {
    const metrics = new RecordingMetrics();
    new OperationLogInterceptor(new NullLogger(), new FixedClock(new Date(2_000)), metrics)
      .intercept(httpContext({ method: "GET", url: "/x", route: { path: "/x" } }, 200), handler)
      .subscribe();
    assert.deepEqual(metrics.observed, []);
  });

  test("lo que falla también se mide: un 500 lento tiene que salir en el percentil", () => {
    const metrics = new RecordingMetrics();
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status: () => ({ type: () => ({ json: () => undefined }) }) }),
        getRequest: () => ({ url: "/orgs/o1/x", method: "POST", route: { path: "/orgs/:id/x" } }),
      }),
    } as unknown as ArgumentsHost;
    const filter = new ProblemDetailsFilter(new NullLogger(), new FixedClock(new Date(2_000)), metrics);

    runWithTrace("t-abcdefgh", 1_000, () => filter.catch(new Error("se ha roto"), host));
    // Y fuera de una petición, sin duración, no se inventa una.
    filter.catch(new Error("se ha roto"), host);

    assert.deepEqual(metrics.observed, [
      { method: "POST", route: "/orgs/:id/x", status: 500, outcome: "error", ms: 1_000 },
    ]);
  });

  test("un 404 que falla sin ruta también cuenta en el saco común", () => {
    const metrics = new RecordingMetrics();
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status: () => ({ type: () => ({ json: () => undefined }) }) }),
        getRequest: () => ({ url: "/inventada/2?x=1", method: "GET" }),
      }),
    } as unknown as ArgumentsHost;
    runWithTrace("t-abcdefgh", 1_950, () =>
      new ProblemDetailsFilter(new NullLogger(), new FixedClock(new Date(2_000)), metrics).catch(
        Object.assign(new Error("no existe"), { status: 404 }),
        host,
      ),
    );
    assert.deepEqual(metrics.observed, [
      { method: "GET", route: UNMATCHED_ROUTE, status: 404, outcome: "error", ms: 50 },
    ]);
  });
});
