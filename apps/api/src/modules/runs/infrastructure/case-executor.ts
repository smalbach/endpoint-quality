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
  holds,
  type ActualResponse,
  type Assertion,
  type FailureKind,
  type ProjectConfig,
  type HttpMethod,
  type ResolvedOperation,
  type StepOutcome,
  type StepRequest,
  type TestScenario,
  interpolateValue,
  type RuntimeVariables,
  unresolvedVariables,
} from "@eq/runner-core";

import { SAFE_FETCH, BlockedTargetError, type RequestTiming, type SafeFetchPort } from "@/shared/http/safe-fetch";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { credentialHeader, type Credential } from "@/modules/environments/domain/model";

export type ExecutionTarget = {
  baseUrl: string;
  writesAllowed: boolean;
  /** The dereferenced OpenAPI document of the run, or null when it could not be fetched. */
  spec: Record<string, unknown> | null;
  specError: string | null;
  credentials: Credential[];
  /**
   * Mutable only for the lifetime of one run; stored environment values are never changed by a test.
   *
   * The copy is made once per run in `RunOrchestrator.execute`, and the cases inside a run are
   * sequential — so a capture in one step is visible to the next, and two runs of the same flow
   * against the same environment cannot see each other's values. `CaseExecutor` is a singleton and
   * keeps no per-run state of its own: this map travels in the argument.
   */
  variables: RuntimeVariables;
  /**
   * The credential a step of this run obtained by logging in, if any.
   *
   * Mutable for the same reason and with the same lifetime as `variables`: a flow whose first step
   * authenticates and whose next eight spend the session is the ordinary shape of a real API, and
   * the alternative is storing somebody's token in the environment by hand and rotating it there.
   *
   * **It replaces `primary`, and only `primary`.** A case asking for `none`, `insufficient` or
   * `api-key` is testing what the target does with a credential that is wrong on purpose, and
   * handing it a working session would turn every one of those into a green 200 that proves
   * nothing.
   */
  session: { header: string; value: string } | null;
};

export type ExecutedStep = {
  request: StepRequest;
  ok: boolean;
  /** Whose problem it is, when it is one. `null` while the step holds. */
  failure: FailureKind | null;
  assertions: Assertion[];
  actual: ActualResponse | null;
  latency: {
    samples: number[];
    budgetMs: number | null;
    /** Where the milliseconds of the **first** request went. The extra samples exist to measure a
     * percentile of the total; splitting each of them would be four numbers about the same second
     * of the same endpoint, and the first one is the one the report shows. */
    timing?: RequestTiming;
  };
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
    // Interpolate before requestPathFor URL-encodes parameter values. Doing it after planning
    // would turn `{{userId}}` into `%7B%7BuserId%7D%7D`, which is no longer a token.
    //
    // Skipped entirely when the environment defines no variables, which is most of them: the
    // substitution walks the whole `ProjectConfig` — the text bundle, every sample, every budget
    // rule — and a 311-case matrix was deep-copying all of it 311 times to replace nothing.
    const substituting = Object.keys(input.target.variables).length > 0;
    const source = { operation: input.operation, scenario: input.scenario, config: input.config };
    const runtime = substituting ? interpolateValue(source, input.target.variables) : source;
    const flow = planFlow({
      operation: runtime.operation,
      scenario: runtime.scenario,
      config: runtime.config,
      operations: input.operations,
      samples: input.samples,
    });

    let cursor = flow.next();
    while (!cursor.done) {
      const step = substituting ? interpolateValue(cursor.value, input.target.variables) : cursor.value;
      const executed = await this.perform(step, { ...input, config: runtime.config, scenario: runtime.scenario });
      steps.push(executed);
      const outcome: StepOutcome = {
        request: executed.request,
        actual: executed.actual,
        ok: executed.ok,
        assertions: executed.assertions,
      };
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
    const headers = this.headersFor(step, input.target);
    const masked = maskHeaders(headers);
    const sent = { method: step.method, url, headers: masked, body: step.body ?? null };

    const missingVariables = unresolvedVariables({ requestPath: step.requestPath, body: step.body });
    if (missingVariables.length) {
      return blocked(step, sent, `Faltan variables: ${missingVariables.join(", ")}`, "Variables del entorno", "config");
    }

    if (!input.target.writesAllowed && !IDEMPOTENT.has(step.method)) {
      // Refused before anything leaves the process. The check lives here and not in the UI
      // because CI never sees the UI.
      return blocked(step, sent, "El entorno no permite escrituras: la operación no se ejecutó", "Ejecución", "config");
    }

    const samples: number[] = [];
    let timing: RequestTiming | undefined;
    let response: Awaited<ReturnType<SafeFetchPort["request"]>>;
    try {
      response = await this.http.request(url, {
        method: step.method,
        headers,
        ...(step.body === undefined ? {} : { body: JSON.stringify(step.body) }),
      });
      samples.push(response.durationMs);
      timing = response.timing;
    } catch (error) {
      const detail =
        error instanceof BlockedTargetError
          ? error.message
          : error instanceof Error
            ? error.message
            : "La petición falló";
      return blocked(step, sent, detail, "Conexión con la API", "network");
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
    const declared = input.target.spec
      ? responseSchema(input.target.spec, step.operationPath, step.method, step.expectedStatus, actual.contentType)
      : undefined;

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
      ok: verdict.ok && holds(assertions),
      // `persistence` is added after the verdict, so a step that only fails there has no kind of
      // its own yet: the write was accepted and the fields were not kept, which is the contract
      // being broken in the most expensive way there is to notice.
      failure: verdict.failure ?? (holds(assertions) ? null : "contract"),
      assertions,
      actual,
      latency: { samples, budgetMs: budget?.ms ?? null, ...(timing ? { timing } : {}) },
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
  private headersFor(step: StepRequest, target: ExecutionTarget): Record<string, string> {
    const base: Record<string, string> = { Accept: "application/json" };
    if (step.body !== undefined) base["Content-Type"] = "application/json";
    if (step.auth === "none") return base;

    const role = step.auth === "insufficient" ? "insufficient" : step.auth === "api-key" ? "alternate" : "primary";
    // A session obtained during this run stands in for the stored working credential, and for
    // nothing else. The three roles that exist to be rejected keep being rejected.
    if (role === "primary" && target.session) return { ...base, [target.session.header]: target.session.value };
    const credential = target.credentials.find((candidate) => candidate.role === role);
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

function blocked(
  step: StepRequest,
  sent: ExecutedStep["sent"],
  detail: string,
  label: string,
  failure: FailureKind,
): ExecutedStep {
  return {
    request: step,
    ok: false,
    failure,
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
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, SECRET_HEADER.test(key) ? "••••••••" : value]),
  );
}
