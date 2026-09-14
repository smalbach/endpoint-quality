import { Inject, Injectable, Logger } from "@nestjs/common";
import { interpolate, valueAtPath } from "@eq/runner-core";

import { SAFE_FETCH, BlockedTargetError, type SafeFetchPort } from "@/shared/http/safe-fetch";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import { resolveVariables } from "@/modules/environments/domain/model";
import type { PerformanceCheck, PerformanceRequest, PerformanceRun, PerformanceScenario } from "../domain/model";
import { verdictFrom } from "../domain/model";
import { activeVusAt, pickScenario, totalDurationS } from "../domain/load";
import { byEndpoint, evaluateThresholds, summarize, toWindows, type Sample } from "../domain/stats";
import {
  PERFORMANCE_RUN_QUEUE,
  PERFORMANCE_RUN_REPOSITORY,
  type PerformanceRunQueuePort,
  type PerformanceRunRepositoryPort,
} from "../domain/ports";
import { PerformanceProgressStream } from "./performance-progress.stream";

/** A run that fired more requests than this stops early with what it has. The percentiles over
 * 200k samples are already stable, and an unbounded array is how a load test kills its own host. */
const MAX_SAMPLES = 200_000;
const MAX_BODY = 200_000;

/**
 * The load generator: a closed-model pool of virtual users, all behind the SSRF guard.
 *
 * Closed model — a fixed number of users, each finishing one scenario iteration before starting the
 * next — because that is what «50 users» means to the person who wrote the plan, and it is the model
 * whose numbers do not lie when the target slows down: a slow target simply completes fewer
 * iterations, rather than the generator queuing an ever-growing backlog it never admits to. The
 * target count at any moment comes from {@link activeVusAt}, so a ramp or a spike is just the pool
 * growing and shrinking.
 *
 * Every request goes through SAFE_FETCH, the same guard the security probes use: a load test aimed
 * by a `{{base}}` somebody typed is exactly the shape of request that must not be allowed to reach
 * the metadata endpoint of the host it runs on.
 */
@Injectable()
export class PerformanceExecutor {
  private readonly logger = new Logger(PerformanceExecutor.name);

  constructor(
    @Inject(PERFORMANCE_RUN_REPOSITORY) private readonly runs: PerformanceRunRepositoryPort,
    @Inject(PERFORMANCE_RUN_QUEUE) private readonly queue: PerformanceRunQueuePort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
    @Inject(SAFE_FETCH) private readonly http: SafeFetchPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly progress: PerformanceProgressStream,
  ) {}

  /** Wired once at boot. */
  listen(): void {
    this.queue.process((runId) => this.execute(runId));
  }

  async execute(runId: string): Promise<void> {
    const run = await this.runs.findById(runId);
    if (!run) return;
    try {
      await this.walk(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Performance run ${runId} failed: ${message}`);
      await this.runs.save({ ...run, status: "error", error: message, finishedAt: this.clock.now() });
      this.publish({ ...run, status: "error" });
    }
  }

  private async walk(run: PerformanceRun): Promise<void> {
    const started = { ...run, status: "running" as const, startedAt: this.clock.now() };
    await this.runs.save(started);

    const environment = run.environmentId ? await this.environments.findById(run.environmentId) : null;
    if (!environment) throw new Error("El entorno ya no existe");
    const baseUrl = environment.baseUrl;
    const envVars = resolveVariables(environment.variables, (payload) => this.cipher.decrypt(payload));

    const { profile, scenarios } = run.definition;
    const totalS = totalDurationS(profile);
    const samples: Sample[] = [];
    const startMs = Date.now();
    const elapsedS = () => (Date.now() - startMs) / 1000;

    const running = new Set<Promise<void>>();
    let cancelled = false;
    let lastTick = 0;

    // One iteration of one virtual user: pick a scenario by weight and walk its requests, carrying
    // the values one request extracts into the next. A fresh variable scope per iteration, so two
    // users never read each other's captured token.
    const iteration = async () => {
      const scenario = pickScenario(scenarios, Math.random());
      if (!scenario) return;
      await this.runScenario(scenario, baseUrl, envVars, samples, startMs);
    };

    while (elapsedS() < totalS && samples.length < MAX_SAMPLES) {
      if (this.queue.isCancelled(run.id)) {
        cancelled = true;
        break;
      }
      const target = activeVusAt(profile, elapsedS());
      while (running.size < target && samples.length < MAX_SAMPLES) {
        const task = iteration().finally(() => running.delete(task));
        running.add(task);
      }
      // A tick a second: grow the chart and let the pool refill as iterations finish.
      const now = elapsedS();
      if (now - lastTick >= 1) {
        lastTick = now;
        this.publish({ ...started, progress: progressOf(now, totalS, samples.length, target) });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Let the in-flight iterations finish so their samples are not lost; a cancel still waits for
    // the requests already sent rather than reporting a number it did not measure.
    await Promise.allSettled([...running]);

    const durationS = Math.max(elapsedS(), 0.001);
    const summary = summarize(samples, durationS);
    const windows = toWindows(samples, totalS, (atS) => activeVusAt(profile, atS));
    const endpoints = byEndpoint(samples);
    const thresholds = evaluateThresholds(summary, run.definition.thresholds);
    const status = cancelled ? "cancelled" : verdictFrom(thresholds);

    const finished: PerformanceRun = {
      ...started,
      status,
      summary,
      windows,
      endpoints,
      thresholds,
      progress: progressOf(durationS, totalS, samples.length, 0),
      finishedAt: this.clock.now(),
    };
    await this.runs.save(finished);
    this.publish(finished, "finished");
  }

  /** Walk one scenario's requests in order, threading extracted values through them. */
  private async runScenario(
    scenario: PerformanceScenario,
    baseUrl: string,
    envVars: Record<string, string>,
    samples: Sample[],
    startMs: number,
  ): Promise<void> {
    const vars: Record<string, string> = { ...envVars };
    for (const request of scenario.requests) {
      if (samples.length >= MAX_SAMPLES) return;
      const sample = await this.sendRequest(request, baseUrl, vars, startMs);
      samples.push(sample);
      if (scenario.thinkMs > 0) await new Promise((resolve) => setTimeout(resolve, scenario.thinkMs));
    }
  }

  /** Send one request and judge it. A blocked or unreachable target is a failed request with a
   * duration of zero, not a dead run: throughput under a firewall is still a number worth having. */
  private async sendRequest(
    request: PerformanceRequest,
    baseUrl: string,
    vars: Record<string, string>,
    startMs: number,
  ): Promise<Sample> {
    const path = interpolate(request.path, vars);
    const url = `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
    const headers = Object.fromEntries(
      Object.entries(request.headers ?? {}).map(([key, value]) => [key, interpolate(value, vars)]),
    );
    const body =
      request.body === undefined || request.body === null
        ? undefined
        : interpolate(typeof request.body === "string" ? request.body : JSON.stringify(request.body), vars);
    const atMs = Date.now() - startMs;
    try {
      const response = await this.http.request(url, { method: request.method, headers, ...(body ? { body } : {}) });
      const parsed = safeJson(response.body);
      applyExtracts(request, parsed, vars);
      const ok = defaultOk(response.status) && (request.checks ?? []).every((check) => passes(check, response, parsed));
      return { atMs, durationMs: response.durationMs, ok, method: request.method, path };
    } catch (error) {
      if (!(error instanceof BlockedTargetError) && !(error instanceof Error)) throw error;
      return { atMs, durationMs: 0, ok: false, method: request.method, path };
    }
  }

  private publish(run: PerformanceRun, type: "progress" | "finished" = "progress"): void {
    this.progress.publish({ runId: run.id, type, status: run.status, progress: run.progress });
  }
}

const progressOf = (elapsedS: number, totalS: number, requests: number, vus: number) => ({
  elapsedS: Math.round(Math.min(elapsedS, totalS)),
  totalS,
  requests,
  vus,
});

const defaultOk = (status: number) => status >= 200 && status < 400;

function applyExtracts(request: PerformanceRequest, body: unknown, vars: Record<string, string>): void {
  for (const extract of request.extract ?? []) {
    const value = valueAtPath(body, extract.path);
    if (value !== undefined && value !== null) vars[extract.variable] = String(value);
  }
}

function passes(check: PerformanceCheck, response: { status: number; durationMs: number }, body: unknown): boolean {
  const actual =
    check.source === "status"
      ? response.status
      : check.source === "durationMs"
        ? response.durationMs
        : valueAtPath(body, check.path ?? "");
  switch (check.operator) {
    case "equals":
      return String(actual) === String(check.value);
    case "not_equals":
      return String(actual) !== String(check.value);
    case "less_than":
      return Number(actual) < Number(check.value);
    case "greater_than":
      return Number(actual) > Number(check.value);
    case "contains":
      return String(actual).includes(String(check.value));
    case "exists":
      return actual !== undefined && actual !== null;
  }
}

function safeJson(text: string): unknown {
  if (!text || text.length > MAX_BODY) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
