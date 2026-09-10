/**
 * Turning a planned case into real requests.
 *
 * `runner-core` decides *what* to send and *what it must satisfy*; this decides nothing. It
 * performs the HTTP through the SSRF guard, decrypts the credential the step asked for, and
 * hands the outcome back to the flow. The split is what lets every rule be tested without a
 * server and every network concern be tested without a rule.
 *
 * Three things it enforces that the pure engine cannot:
 *
 * - **the environment's `writesAllowed`**, checked here rather than in the UI, because a run can
 *   be launched from CI with no UI in sight;
 * - **credential masking before the row is written**, never on the way out — a redaction applied
 *   at read time is one query away from being forgotten;
 * - **the live document is fetched once per run**, not once per case. Re-fetching it mid-run
 *   would mean asserting the last case against a contract the first one never saw.
 */
import { Inject, Injectable } from "@nestjs/common";
import {
  evaluateResponse,
  persistenceAssertion,
  planFlow,
  responseSchema,
  budgetFor,
  type ActualResponse,
  type Assertion,
  type ProjectConfig,
  type HttpMethod,
  type ResolvedOperation,
  type StepOutcome,
  type StepRequest,
  type TestScenario,
} from "@eq/runner-core";

import { SAFE_FETCH, BlockedTargetError, type SafeFetchPort } from "@/shared/http/safe-fetch";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { credentialHeader, type Credential } from "@/modules/environments/domain/model";

export type ExecutionTarget = {
  baseUrl: string;
  writesAllowed: boolean;
  /** The dereferenced OpenAPI document of the run, or null when it could not be fetched. */
  spec: Record<string, unknown> | null;
  specError: string | null;
  credentials: Credential[];
};

export type ExecutedStep = {
  request: StepRequest;
  ok: boolean;
  assertions: Assertion[];
  actual: ActualResponse | null;
  latency: { samples: number[]; budgetMs: number | null };
  durationMs: number;
  /** What was actually sent, credentials masked. This is what gets stored. */
  sent: { method: string; url: string; headers: Record<string, string>; body: unknown };
};

export type ExecutedCase = { ok: boolean; steps: ExecutedStep[]; durationMs: number };

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"]);
/** Header names whose value is a credential. Matched loosely on purpose: a target that calls its
 * key `X-Tenant-Token` must be masked too, and an allowlist of exact names would miss it. */
const SECRET_HEADER = /authorization|api[-_]?key|token|secret|cookie/i;

@Injectable()
export class CaseExecutor {
  constructor(
    @Inject(SAFE_FETCH) private readonly http: SafeFetchPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
  ) {}

  async run(input: {
    operation: ResolvedOperation;
    scenario: TestScenario;
    operations: ResolvedOperation[];
    config: ProjectConfig;
    target: ExecutionTarget;
    samples: number;
  }): Promise<ExecutedCase> {
    const started = Date.now();
    const steps: ExecutedStep[] = [];
    const flow = planFlow({
      operation: input.operation,
      scenario: input.scenario,
      config: input.config,
      operations: input.operations,
      samples: input.samples,
    });

    let cursor = flow.next();
    while (!cursor.done) {
      const executed = await this.perform(cursor.value, input);
      steps.push(executed);
      const outcome: StepOutcome = { request: executed.request, actual: executed.actual, ok: executed.ok, assertions: executed.assertions };
      cursor = flow.next(outcome);
    }

    return {
      // A case passes only when every step does — the cleanup included. A cleanup that fails
      // leaves a row behind that turns the next run of this case into a conflict, so hiding it
      // would trade one honest red today for a confusing red tomorrow.
      ok: steps.length > 0 && steps.every((step) => step.ok),
      steps,
      durationMs: Date.now() - started,
    };
  }

  private async perform(
    step: StepRequest,
    input: { config: ProjectConfig; target: ExecutionTarget; operation: ResolvedOperation; scenario: TestScenario },
  ): Promise<ExecutedStep> {
    const url = `${input.target.baseUrl}${step.requestPath}`;
    const headers = this.headersFor(step, input.target.credentials);
    const masked = maskHeaders(headers);
    const sent = { method: step.method, url, headers: masked, body: step.body ?? null };

    if (!input.target.writesAllowed && !IDEMPOTENT.has(step.method)) {
      // Refused before anything leaves the process. The check lives here and not in the UI
      // because CI never sees the UI.
      return blocked(step, sent, "El entorno no permite escrituras: la operación no se ejecutó");
    }

    const samples: number[] = [];
    let response: Awaited<ReturnType<SafeFetchPort["request"]>>;
    try {
      response = await this.http.request(url, {
        method: step.method,
        headers,
        ...(step.body === undefined ? {} : { body: JSON.stringify(step.body) }),
      });
      samples.push(response.durationMs);
    } catch (error) {
      const detail = error instanceof BlockedTargetError ? error.message : error instanceof Error ? error.message : "La petición falló";
      return blocked(step, sent, detail, "Conexión con la API");
    }

    // Extra samples only on a safe method, and only of the request that was already made: a p95
    // over a POST would create N resources and the measurement would change what it measures.
    for (let taken = 1; taken < step.samples && IDEMPOTENT.has(step.method); taken += 1) {
      try {
        samples.push((await this.http.request(url, { method: step.method, headers })).durationMs);
      } catch {
        break;
      }
    }

    const actual = toActualResponse(response);
    // `step.method` is a string on the request because a flow can add a step for an operation
    // the contract types differently; the budget matcher wants the narrowed union.
    const budget = budgetFor(input.config, step.method as HttpMethod, step.operationPath, step.requestPath);
    const declared = input.target.spec ? responseSchema(input.target.spec, step.operationPath, step.method, step.expectedStatus, actual.contentType) : undefined;

    const verdict = evaluateResponse({
      method: step.method,
      operationPath: step.operationPath,
      expectedStatus: step.expectedStatus,
      expectedShape: step.expectedShape,
      errorShape: input.config.envelope.errorShape,
      actual,
      schema: declared ?? null,
      schemaDiagnostic: input.target.specError,
      budget,
      latencySamples: samples,
    });

    const assertions = [...verdict.assertions];
    // The assertion that separates "accepted my write" from "stored what I sent". Only on the
    // read-back of a mutation, and only for the fields that mutation actually sent.
    const persistence = persistenceAssertion(step, actual, input.scenario.body ?? {}, step.expectedShape);
    if (persistence) assertions.push(persistence);

    return {
      request: step,
      ok: verdict.ok && assertions.every((assertion) => assertion.pass),
      assertions,
      actual,
      latency: { samples, budgetMs: budget?.ms ?? null },
      durationMs: samples[0] ?? 0,
      sent,
    };
  }

  /**
   * The credential a step presents, which is the thing the case is testing.
   *
   * `none` sends nothing on purpose — that is the 401. `insufficient` sends a token that
   * authenticates without reaching the required scope — that is the 403. `api-key` sends a
   * scheme the operation does not declare, which is a 401 and not a 403.
   */
  private headersFor(step: StepRequest, credentials: Credential[]): Record<string, string> {
    const base: Record<string, string> = { Accept: "application/json" };
    if (step.body !== undefined) base["Content-Type"] = "application/json";
    if (step.auth === "none") return base;

    const role = step.auth === "insufficient" ? "insufficient" : step.auth === "api-key" ? "alternate" : "primary";
    const credential = credentials.find((candidate) => candidate.role === role);
    // A missing credential is not silently the working one: sending `primary` where the case
    // asked for `insufficient` would turn a 403 case into a green 200 that proves nothing.
    if (!credential) return base;
    return { ...base, ...credentialHeader(credential, this.cipher.decrypt(credential.secretCiphertext)) };
  }
}

function toActualResponse(response: { status: number; headers: Record<string, string>; body: string }): ActualResponse {
  const contentType = response.headers["content-type"] ?? "";
  let body: unknown = response.body;
  if (contentType.includes("json") && response.body) {
    try {
      body = JSON.parse(response.body);
    } catch {
      // Left as the raw string. A malformed body under a JSON content type is a finding the
      // schema assertion will report, not a reason to fail the whole step here.
      body = response.body;
    }
  }
  return { status: response.status, statusText: "", contentType, headers: response.headers, body, raw: response.body };
}

function blocked(step: StepRequest, sent: ExecutedStep["sent"], detail: string, label = "Ejecución"): ExecutedStep {
  return {
    request: step,
    ok: false,
    assertions: [{ label, pass: false, detail }],
    actual: null,
    latency: { samples: [], budgetMs: null },
    durationMs: 0,
    sent,
  };
}

/** Masked before the row is written. A redaction applied at read time is one query away from
 * being forgotten, and the value is a live credential for somebody's staging environment. */
export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, SECRET_HEADER.test(key) ? "••••••••" : value]));
}
