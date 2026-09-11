/**
 * The steps a case walks, and what each one proves.
 *
 * In the coupled dashboard this lived inside `api-dashboard.tsx`, tangled with React state: the
 * flow decided which request to send next by reading the component's variables, so which body a
 * case sent depended on whether React had re-rendered between two awaits. A suite whose payload
 * depends on render timing cannot be evidence, and that bug was fixed there by hand.
 *
 * Here the flow is a **state machine with no I/O**. It is handed the outcome of each request and
 * says what to do next; something else performs the HTTP. That is what lets the same flow run in
 * a queue worker, be replayed from stored results, and be tested without a server.
 *
 * The flows themselves are the interesting part, and each exists because of a specific way an
 * endpoint can look correct and be broken:
 *
 * - `create-read` — a POST that answers 201 and silently drops half the payload passes every
 *   check on its own response. Reading the resource back is the only way to see it.
 * - `delete-read` / `deleted-read` — a 204 says the DELETE was accepted, not that the row is
 *   gone. A soft delete that hides nothing, a cache that keeps serving it, and a second DELETE
 *   that answers 204 over a row that no longer exists all pass the first and fail the second.
 * - `replace-read` / `patch-read` — a PUT over a seed row would mutate a fixture every later
 *   case reads, so the flow creates its own resource first and works on that.
 *
 * Every flow that creates something also deletes it. Without the cleanup the second run of a
 * POST over a natural key is a 409: correct behaviour, and a useless test case, because it
 * reports the state the previous run left behind rather than whether the endpoint works.
 */
import type { Assertion, ResolvedOperation, TestScenario } from "./types.ts";
import type { RequestBody } from "./request-body.ts";
import type { ProjectConfig } from "./config.ts";
import { capturedId, verifyPersistedFields, type ActualResponse } from "./assertions.ts";
import { expectedShapeFor } from "./envelope.ts";
import { requestPathFor } from "./request-path.ts";

/** One HTTP request the runner has to make. Everything needed to send it and to judge it. */
export type StepRequest = {
  /** Stable within a case, so a stored run can be read back step by step. */
  index: number;
  /** What this step is for, in the operator's words. A failing `verify` step means something
   * different from a failing `act` step. */
  purpose: "act" | "verify" | "prepare" | "cleanup";
  label: string;
  operationId: string;
  method: string;
  /** The templated path, for looking the schema and the budget up. */
  operationPath: string;
  /** The resolved path with its query string, which is what actually gets requested. */
  requestPath: string;
  body?: Record<string, unknown>;
  /** The payload a saved request describes when it is not a JSON object. Never both this and
   * `body`; see {@link TestScenario.payload}. */
  payload?: RequestBody;
  /** What the scenario adds on top of the headers the executor builds. Absent on every step of
   * the generated matrix; only a saved request has any. */
  headers?: Record<string, string>;
  expectedStatus: number;
  /** Statuses that also pass. Only a denial case has any; see {@link TestScenario.alsoAccepted}. */
  alsoAccepted?: number[];
  expectedShape: string;
  /** Which credential to present. `default` is the working one. */
  auth: TestScenario["auth"];
  /** How many times to measure. Only ever more than one on a safe method — repeating a POST
   * would create N resources and the measurement would change the thing being measured. */
  samples: number;
};

export type StepOutcome = {
  request: StepRequest;
  actual: ActualResponse | null;
  ok: boolean;
  /** Extra assertions the flow itself adds on top of the response-level ones. */
  assertions: Assertion[];
};

export type FlowContext = {
  operation: ResolvedOperation;
  scenario: TestScenario;
  config: ProjectConfig;
  /** Every operation of the contract, so a flow can find the detail GET that reads back what a
   * POST created, or the DELETE that cleans it up. */
  operations: ResolvedOperation[];
  samples: number;
};

/**
 * Finds the detail operation of a collection: `GET /things` → `GET /things/{id}`.
 *
 * By convention, deliberately, with an escape hatch. Most REST APIs nest the detail one
 * placeholder deeper than the collection, and requiring every project to declare that by hand
 * would be a form to fill in for the ninety per cent of cases the convention already covers.
 * `flowOverrides` is how the other ten per cent say so — that is P5's editor; the convention is
 * what makes the tool useful before anybody opens it.
 */
export function detailOperationFor(
  collection: ResolvedOperation,
  operations: ResolvedOperation[],
): ResolvedOperation | undefined {
  const placeholders = (collection.path.match(/\{/g) ?? []).length;
  return operations.find(
    (candidate) =>
      candidate.method === "GET" &&
      candidate.path.startsWith(`${collection.path}/{`) &&
      (candidate.path.match(/\{/g) ?? []).length === placeholders + 1,
  );
}

/** The last placeholder of a path is the resource's own identifier: in
 * `/v1/stores/{store_id}/assortment/{assortment_id}` that is `assortment_id`. */
export function idFieldOf(operation: ResolvedOperation): string | undefined {
  return [...operation.path.matchAll(/\{([^}]+)\}/g)].at(-1)?.[1];
}

function step(
  context: FlowContext,
  partial: Omit<StepRequest, "index" | "expectedShape" | "auth" | "samples" | "requestPath"> & {
    parameters?: Record<string, string>;
    auth?: TestScenario["auth"];
    samples?: number;
  },
  index: number,
): StepRequest {
  const operation = context.operations.find((candidate) => candidate.id === partial.operationId) ?? context.operation;
  const requestPath = requestPathFor(operation, context.config, partial.parameters);
  return {
    index,
    purpose: partial.purpose,
    label: partial.label,
    operationId: partial.operationId,
    method: partial.method,
    operationPath: partial.operationPath,
    requestPath,
    ...(partial.body ? { body: partial.body } : {}),
    ...(partial.payload ? { payload: partial.payload } : {}),
    ...(partial.headers ? { headers: partial.headers } : {}),
    ...(partial.alsoAccepted?.length ? { alsoAccepted: partial.alsoAccepted } : {}),
    expectedStatus: partial.expectedStatus,
    expectedShape: expectedShapeFor(operation, partial.expectedStatus, context.config),
    auth: partial.auth ?? context.scenario.auth ?? "default",
    // Only safe methods are sampled more than once. Everything else measures once, and the
    // latency assertion says so rather than presenting one measurement as a percentile.
    samples: partial.samples ?? (["GET", "HEAD", "OPTIONS"].includes(partial.method) ? context.samples : 1),
  };
}

/**
 * The flow, as a generator.
 *
 * It yields a request, receives the outcome, and decides. Written this way rather than as a list
 * of steps because the later steps depend on the earlier ones — the read-back needs the id the
 * create returned — and a list would have to encode that dependency as indices into itself.
 *
 * It stops as soon as a step it depends on fails: chasing a read-back for a create that returned
 * 500 produces a second red line that says nothing new.
 */
export function* planFlow(context: FlowContext): Generator<StepRequest, void, StepOutcome> {
  const { operation, scenario, config, operations } = context;
  let index = 0;
  const next = (partial: Parameters<typeof step>[1]) => step(context, partial, index++);

  const primary = next({
    purpose: "act",
    label: scenario.name,
    operationId: operation.id,
    method: operation.method,
    operationPath: operation.path,
    ...(scenario.parameters ? { parameters: scenario.parameters } : {}),
    ...(scenario.body ? { body: scenario.body } : {}),
    ...(scenario.payload ? { payload: scenario.payload } : {}),
    ...(scenario.alsoAccepted?.length ? { alsoAccepted: scenario.alsoAccepted } : {}),
    // On the step the scenario is *about*, and on no other. The prepare and cleanup steps are
    // operations this flow invented to make the case runnable, and a `Content-Type` somebody wrote
    // next to an XML payload is wrong on the JSON create that precedes it. A saved request plans
    // exactly one step anyway — `flow: "request"` — so this is the only step that ever has any.
    ...(scenario.headers ? { headers: scenario.headers } : {}),
    expectedStatus: scenario.expectedStatus,
  });

  // A single request is the whole flow for most cases, the bulk write included: it has no id to
  // read back and no cleanup step, because it is one request over a natural key.
  if (scenario.flow === "request" || scenario.flow === "bulk-read") {
    yield primary;
    return;
  }

  if (scenario.flow === "create-read") {
    const created = yield primary;
    if (!created.ok || !created.actual) return;

    const detail = detailOperationFor(operation, operations);
    const field = detail ? idFieldOf(detail) : undefined;
    if (!detail || !field) return;

    const id = capturedId(created.actual.body, operation.responseShape, field);
    if (!id) return;

    const read = yield next({
      purpose: "verify",
      label: "Consultar el recurso creado",
      operationId: detail.id,
      method: "GET",
      operationPath: detail.path,
      parameters: { [field]: id },
      expectedStatus: 200,
    });

    // Deleted whether or not the read-back passed. The row exists either way, and leaving it
    // turns the next run of this case into a 409 that reports the previous run rather than the
    // endpoint.
    const remove = operations.find((candidate) => candidate.method === "DELETE" && candidate.path === detail.path);
    if (remove) {
      yield next({
        purpose: "cleanup",
        label: "Eliminar el recurso creado",
        operationId: remove.id,
        method: "DELETE",
        operationPath: remove.path,
        parameters: { [field]: id },
        expectedStatus: 204,
        auth: "default",
      });
    }
    void read;
    return;
  }

  // The mutating flows work on a resource they create, never on a seed row: a PUT over fixture
  // id 1 changes what every later case in the matrix reads.
  const field = idFieldOf(operation);
  const collectionPath = operation.path.replace(/\/\{[^}]+\}$/, "");
  const create = operations.find((candidate) => candidate.method === "POST" && candidate.path === collectionPath);
  const read = operations.find((candidate) => candidate.method === "GET" && candidate.path === operation.path);
  const remove = operations.find((candidate) => candidate.method === "DELETE" && candidate.path === operation.path);

  if (!field || !create || !read) {
    // No prerequisite to build. Running the mutation over a seed id anyway would be the very
    // fixture damage the flow exists to avoid, so the case reports that it could not be set up.
    yield primary;
    return;
  }

  const prepared = yield next({
    purpose: "prepare",
    label: "Crear la entidad de trabajo",
    operationId: create.id,
    method: "POST",
    operationPath: create.path,
    ...(create.body ? { body: create.body } : {}),
    expectedStatus: create.statuses.includes(201) ? 201 : 200,
    auth: "default",
  });
  if (!prepared.ok || !prepared.actual) return;

  const id = capturedId(prepared.actual.body, create.responseShape, field);
  if (!id) return;
  const target = { [field]: id };

  if (scenario.flow === "delete-read" || scenario.flow === "deleted-read") {
    const deleted = yield next({
      purpose: "act",
      label: scenario.name,
      operationId: operation.id,
      method: operation.method,
      operationPath: operation.path,
      parameters: target,
      expectedStatus: scenario.flow === "delete-read" ? scenario.expectedStatus : 204,
    });
    if (!deleted.ok) return;

    // **Both flows read back.** `delete-read` used to stop at the 204, which made its own name a
    // promise it did not keep — and left the case asserting the exact thing the flow exists to
    // distrust. A soft delete whose read path forgot the flag answers a perfectly correct 204 and
    // keeps serving the row; only this GET sees it.
    //
    // A verdict-level parity check could not catch that: against a target that really does delete,
    // the two-step and the three-step versions are both green. It took a target that misbehaves.
    yield next({
      purpose: "verify",
      label: "Consultar el recurso eliminado",
      operationId: read.id,
      method: "GET",
      operationPath: read.path,
      parameters: target,
      expectedStatus: 404,
    });
    // `deleted-read` goes one further. The two are not duplicates: this one asks what the resource
    // *is* afterwards, the second DELETE below asks whether the endpoint admits the row is gone.
    if (scenario.flow === "delete-read") return;
    if (remove) {
      // A second DELETE must also be 404: an endpoint that answers 204 over a row that no longer
      // exists is reporting success for work it did not do.
      yield next({
        purpose: "verify",
        label: "Eliminar dos veces",
        operationId: remove.id,
        method: "DELETE",
        operationPath: remove.path,
        parameters: target,
        expectedStatus: 404,
      });
    }
    return;
  }

  // replace-read and patch-read: mutate, read back, compare, clean up.
  const sent = scenario.body ?? {};
  const mutated = yield next({
    purpose: "act",
    label: scenario.name,
    operationId: operation.id,
    method: operation.method,
    operationPath: operation.path,
    parameters: target,
    body: sent,
    expectedStatus: scenario.expectedStatus,
  });

  if (mutated.ok && mutated.actual) {
    yield next({
      purpose: "verify",
      label: "Comprobar el estado persistido",
      operationId: read.id,
      method: "GET",
      operationPath: read.path,
      parameters: target,
      expectedStatus: 200,
    });
  }

  if (remove) {
    yield next({
      purpose: "cleanup",
      label: "Eliminar la entidad de trabajo",
      operationId: remove.id,
      method: "DELETE",
      operationPath: remove.path,
      parameters: target,
      expectedStatus: 204,
      auth: "default",
    });
  }
  void config;
}

/**
 * The extra assertion a `verify` step carries, when the flow knows what should have persisted.
 *
 * Kept out of `planFlow` because it needs the response of the step it judges, and a generator
 * that both plans and judges would have to carry the comparison across a yield.
 */
export function persistenceAssertion(
  step: StepRequest,
  actual: ActualResponse | null,
  sent: Record<string, unknown>,
  envelopeShape: string,
): Assertion | null {
  if (step.purpose !== "verify" || step.method !== "GET" || Object.keys(sent).length === 0) return null;
  const key = envelopeShape;
  const container =
    actual && typeof actual.body === "object" && actual.body !== null
      ? (actual.body as Record<string, unknown>)
      : undefined;
  const envelope = /^\{\s*([A-Za-z_$][\w$]*)/.exec(key.trim())?.[1];
  const resource = envelope ? (container?.[envelope] as Record<string, unknown> | undefined) : container;
  return verifyPersistedFields(resource, sent);
}
