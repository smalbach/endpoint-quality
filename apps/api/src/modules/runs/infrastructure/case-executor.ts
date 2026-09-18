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
import { createHmac, randomUUID } from "node:crypto";
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
  type StepFetch,
  type StepGraphql,
  graphqlAssertion,
  graphqlBody,
  parseGraphqlVariables,
  type StepOutcome,
  type StepRequest,
  type TestScenario,
  interpolateValue,
  payloadFor,
  type ComputedSeed,
  roleOf,
  type RuntimeVariables,
  type SerializedBody,
  unresolvedVariables,
} from "@eq/runner-core";

import { cookiesFrom, signAuth, withCookies, type Cookie } from "@eq/runner-core";
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
  /**
   * El tarro de cookies de **esta corrida**.
   *
   * Mutable con la misma vida que `variables` y `session`, y por lo mismo: un flujo cuyo primer
   * paso entra y los ocho siguientes gastan la sesión es la forma normal de una API real, y si la
   * cookie del login no llega al paso siguiente ninguno de esos ocho puede pasar.
   *
   * De la corrida y no del proyecto: dos corridas del mismo flujo no deben ver la sesión de la
   * otra, igual que no ven sus variables.
   */
  cookies: Cookie[];
  /**
   * Values that must never be shown: the environment's sensitive variables, decrypted. A flow's
   * script node can `console.log` any variable, so its output is redacted against this list before
   * it is stored in the report.
   */
  secrets?: string[];
};

/** The values `{{$uuid}}`, `{{$now}}`… resolve to. One per case, so the same token means the same
 * value everywhere it appears in that case. */
export function computedSeed(): ComputedSeed {
  return {
    uuid: randomUUID(),
    now: new Date(),
    random: Math.random(),
    hmacSha256: (key, text) => createHmac("sha256", key).update(text).digest("hex"),
  };
}

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

/** Las credenciales que un caso presenta para que fallen. Ninguna sesión las rescata. */
const WRONG_ON_PURPOSE = new Set<string>(["none", "insufficient"]);
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
    // It used to be skipped when the environment defined no variables — the walk covers the whole
    // `ProjectConfig`, and a 311-case matrix was deep-copying all of it 311 times to replace
    // nothing. Computed values took that shortcut away: `{{$uuid}}` needs no environment, so a
    // project with no variables is exactly the one the skip would have broken.
    // One seed for the whole case, so `{{$uuid}}` in an idempotency header and in the payload is
    // the same value, and the read-back step of a flow sees that same value again. A fresh one per
    // occurrence would break exactly the flows computed values exist for.
    const seed = computedSeed();
    // The substitution pass now runs for every case and not only when the environment defines
    // variables: a project with no variables at all can still write `{{$uuid}}`, and skipping the
    // walk would send the token to the target as a literal.
    const source = { operation: input.operation, scenario: input.scenario, config: input.config };
    const runtime = interpolateValue(source, input.target.variables, seed);
    const flow = planFlow({
      operation: runtime.operation,
      scenario: runtime.scenario,
      config: runtime.config,
      operations: input.operations,
      samples: input.samples,
    });

    let cursor = flow.next();
    while (!cursor.done) {
      const step = interpolateValue(cursor.value, input.target.variables, seed);
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

  /**
   * A `fetch` node's call: written on the node, not planned from the contract.
   *
   * No operation, so no schema and no envelope to hold it to — the verdict is the status (the one
   * the author expects, or any 2xx) and whatever checks the step adds on top. The same guards as a
   * planned request apply: unresolved `{{variables}}` are refused before anything leaves, the call
   * goes through SAFE_FETCH, credentials are masked in what is stored, and an environment that
   * forbids writes forbids them here too when the URL points at that environment.
   */
  async fetch(input: { call: StepFetch; target: ExecutionTarget }): Promise<ExecutedCase> {
    const started = Date.now();
    const seed = computedSeed();
    const call = interpolateValue(input.call, input.target.variables, seed);
    let url = fetchUrl(call.url, input.target.baseUrl);
    const headers: Record<string, string> = { Accept: "application/json" };
    const own = call.headers ?? {};
    const hasContentType = Object.keys(own).some((name) => name.toLowerCase() === "content-type");
    if (call.body && !hasContentType) headers["Content-Type"] = looksLikeJson(call.body) ? "application/json" : "text/plain";
    // Only when asked: the session belongs to the API under test, and a fetch is often aimed at
    // somebody else's host.
    if (call.useSession && input.target.session) headers[input.target.session.header] = input.target.session.value;
    Object.assign(headers, own);

    // La firma va después de las cabeceras y del `Content-Type`: AWS y Hawk lo firman, y OAuth 1
    // mira si el cuerpo es un formulario para decidir si entra en la firma.
    const signedWith = await this.signFetch(call, url, headers);
    if (signedWith.query) url = signedWith.query;

    const expectedStatus = call.expectedStatus ?? 200;
    const request: StepRequest = {
      index: 0,
      purpose: "act",
      label: `${call.method} ${call.url}`,
      operationId: "",
      method: call.method,
      operationPath: call.url,
      requestPath: url,
      headers,
      expectedStatus,
      expectedShape: "",
      // `auth` de una caso dice *qué credencial del escenario* se usó, no de qué tipo era: un
      // `fetch` no usa ninguna de ellas, y poner aquí «awsv4» cambiaría lo que significa la columna.
      auth: "none",
      samples: 1,
    };
    const sent = {
      method: call.method,
      url,
      headers: maskHeaders(headers),
      body: call.body ? (looksLikeJson(call.body) ? JSON.parse(call.body) : call.body) : null,
    };
    const done = (step: ExecutedStep): ExecutedCase => ({ ok: step.ok, steps: [step], durationMs: Date.now() - started });

    if (signedWith.failed) {
      return done(blocked(request, sent, signedWith.failed, "Autenticación", "config"));
    }

    const missingVariables = unresolvedVariables({ url: call.url, headers: call.headers, body: call.body });
    if (missingVariables.length) {
      return done(blocked(request, sent, `Faltan variables: ${missingVariables.join(", ")}`, "Variables del entorno", "config"));
    }
    if (!input.target.writesAllowed && !IDEMPOTENT.has(call.method) && sameOrigin(url, input.target.baseUrl)) {
      return done(
        blocked(request, sent, "El entorno no permite escrituras: la operación no se ejecutó", "Ejecución", "config"),
      );
    }

    let response: Awaited<ReturnType<SafeFetchPort["request"]>>;
    try {
      response = await this.http.request(url, {
        method: call.method,
        headers,
        jar: input.target.cookies,
        ...(call.body && call.method !== "GET" && call.method !== "HEAD" ? { body: call.body } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "La petición falló";
      return done(blocked(request, sent, detail, "Conexión", "network"));
    }

    absorbCookies(input.target, url, response.setCookie, Date.now());

    const actual = toActualResponse(response);
    const pass = call.expectedStatus ? actual.status === call.expectedStatus : actual.status >= 200 && actual.status < 300;
    const assertions: Assertion[] = [
      {
        label: "Estado HTTP",
        pass,
        detail: call.expectedStatus
          ? `Esperado ${call.expectedStatus}, recibido ${actual.status}`
          : `Esperado 2xx, recibido ${actual.status}`,
      },
    ];
    return done({
      request,
      ok: pass,
      failure: pass ? null : "status",
      assertions,
      actual,
      latency: { samples: [response.durationMs], budgetMs: null, timing: response.timing },
      durationMs: response.durationMs,
      sent,
    });
  }

  /**
   * La autenticación de una llamada escrita a mano, firmada sobre ella.
   *
   * Digest necesita el `nonce` del servidor, que solo llega en su 401, así que ahí se pide ese 401
   * primero. Es una petición más y se hace únicamente cuando el nodo pide Digest: firmar sin reto no
   * es posible, y mandar una cabecera a medias cambia un 401 claro por un 400 raro.
   *
   * Lo que no se hace aquí es pedir un token de OAuth 2: una corrida no debe ir a un servidor de
   * identidad a por credenciales en medio de un flujo. El token se pone en una variable —que es
   * donde vive cifrado— y el nodo la nombra.
   */
  private async signFetch(
    call: StepFetch,
    url: string,
    headers: Record<string, string>,
  ): Promise<{ label: string; query: string | null; failed: string | null }> {
    const auth = call.auth;
    if (!auth || auth.type === "inherit" || auth.type === "none") {
      return { label: auth?.type === "none" ? "none" : "inherit", query: null, failed: null };
    }
    if (auth.type === "oauth2" && !auth.params.accessToken?.trim()) {
      return {
        label: auth.type,
        query: null,
        failed: "OAuth 2.0 sin token: ponlo en una variable del entorno y nómbrala aquí",
      };
    }

    const request = { method: call.method, url, headers, body: call.body ?? null };
    let signed = signAuth(auth, request);
    if (signed.needsChallenge) {
      let probe;
      try {
        probe = await this.http.request(url, { method: call.method, headers: { ...headers } });
      } catch {
        return { label: auth.type, query: null, failed: "No se pudo pedir el reto de Digest al servidor" };
      }
      const challenge = probe.headers["www-authenticate"] ?? probe.headers["WWW-Authenticate"] ?? "";
      if (!challenge) {
        return { label: auth.type, query: null, failed: "El servidor no pidió autenticación: no hay reto que firmar" };
      }
      signed = signAuth(auth, { ...request, challenge });
    }
    if (signed.unsupported) return { label: auth.type, query: null, failed: signed.unsupported };

    for (const pair of signed.headers) headers[pair.name] = pair.value;
    const query = signed.query.length
      ? `${url}${url.includes("?") ? "&" : "?"}${signed.query
          .map((pair: { name: string; value: string }) => `${encodeURIComponent(pair.name)}=${encodeURIComponent(pair.value)}`)
          .join("&")}`
      : null;
    return { label: auth.type, query, failed: null };
  }

  /**
   * A `graphql` node's operation: a fetch whose body is `{query, variables, operationName}`, judged
   * also on the `errors` array a GraphQL server answers with a 200.
   *
   * Everything is substituted here, once, and the call handed to {@link fetch} with nothing left to
   * substitute. So the fetch's guards all apply — SAFE_FETCH, masked credentials, the session only
   * when asked, writes refused against an environment that forbids them — and a captured value that
   * happens to hold `{{braces}}` is not substituted a second time, unescaped, into the JSON body.
   * The variables are text until then: substituted first, parsed second, and a text that stopped
   * being an object (a value with a quote in it) is refused before anything leaves.
   */
  async graphql(input: { call: StepGraphql; target: ExecutionTarget }): Promise<ExecutedCase> {
    const started = Date.now();
    const label = `GQL ${input.call.operationName || input.call.url}`;
    const call = interpolateValue(input.call, input.target.variables, computedSeed());
    const url = fetchUrl(call.url, input.target.baseUrl);
    const refuse = (detail: string, assertion: string): ExecutedCase => {
      const request: StepRequest = {
        index: 0,
        purpose: "act",
        label,
        operationId: "",
        method: "POST",
        operationPath: call.url,
        requestPath: url,
        headers: call.headers ?? {},
        expectedStatus: call.expectedStatus ?? 200,
        expectedShape: "",
        auth: "none",
        samples: 1,
      };
      const sent = {
        method: "POST",
        url,
        headers: maskHeaders(call.headers ?? {}),
        body: { query: call.query, variables: call.variables ?? null, operationName: call.operationName ?? null },
      };
      return { ok: false, steps: [blocked(request, sent, detail, assertion, "config")], durationMs: Date.now() - started };
    };

    const missingVariables = unresolvedVariables({
      url: call.url,
      query: call.query,
      variables: call.variables,
      headers: call.headers,
    });
    if (missingVariables.length) return refuse(`Faltan variables: ${missingVariables.join(", ")}`, "Variables del entorno");
    const variables = parseGraphqlVariables(call.variables);
    if (!variables.ok) return refuse(variables.problem, "Variables de GraphQL");

    const headers = { ...call.headers };
    if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
    const executed = await this.fetch({
      call: {
        method: "POST",
        url: call.url,
        headers,
        body: graphqlBody({ query: call.query, variables: variables.value, operationName: call.operationName }),
        ...(call.expectedStatus ? { expectedStatus: call.expectedStatus } : {}),
        ...(call.useSession ? { useSession: true } : {}),
        ...(call.auth ? { auth: call.auth } : {}),
      },
      // Already substituted: an empty map leaves the fetch nothing to replace a second time.
      target: { ...input.target, variables: {} },
    });

    const step = executed.steps[0];
    step.request = { ...step.request, label };
    // Refused or unanswered: the fetch already said why, and there is no body to read errors from.
    if (!step.actual) return executed;
    step.assertions.push(graphqlAssertion(step.actual.body, call.allowErrors));
    const ok = holds(step.assertions);
    // The status held and the body did not: the shape of the answer, not the verb, is what failed.
    if (!ok && step.ok) step.failure = "contract";
    step.ok = ok;
    return { ...executed, ok, durationMs: Date.now() - started };
  }

  private async perform(
    step: StepRequest,
    input: { config: ProjectConfig; target: ExecutionTarget; operation: ResolvedOperation; scenario: TestScenario },
  ): Promise<ExecutedStep> {
    const url = `${input.target.baseUrl}${step.requestPath}`;
    // Serialised here rather than where the template was converted, because the variables have
    // been substituted by now: a `{{nombre}}` encoded first and replaced second would put a raw
    // space or ampersand into a form payload, and the target would read one field where two were
    // meant.
    const payload = payloadFor(step);
    const headers = this.headersFor(step, input.target, payload);
    const masked = maskHeaders(headers);
    // The JSON object when there is one, so the panel and the stored step keep showing a payload
    // that can be read as a tree. Anything else is the text that crossed the wire, which is the
    // only honest representation of a form or of somebody's XML.
    const sent = { method: step.method, url, headers: masked, body: step.body ?? payload?.text ?? null };

    // The headers and the serialised payload are walked with the rest: a `{{tenant}}` nobody
    // defined would otherwise travel to the target verbatim, and the answer would be a 400 about a
    // value the report shows as if it had been sent on purpose. The payload is checked as the text
    // it became, so a variable left inside a form field somebody switched off is not a blocker.
    const missingVariables = unresolvedVariables({
      requestPath: step.requestPath,
      body: step.body,
      payload: payload?.text,
      headers: step.headers,
    });
    if (missingVariables.length) {
      return blocked(step, sent, `Faltan variables: ${missingVariables.join(", ")}`, "Variables del entorno", "config");
    }

    // Refused before anything leaves, and as `config` rather than as a failed case. A matrix cell
    // that asks «¿qué hace este endpoint ante un vendedor?» against an environment with no
    // vendedor credential has no answer — and sending nothing would produce a 401 that reads as
    // «el endpoint rechaza al vendedor», which is the wrong finding recorded as if it were right.
    const named = roleOf(step.auth);
    if (named && !input.target.credentials.some((candidate) => candidate.role === named)) {
      return blocked(
        step,
        sent,
        `El entorno no tiene credencial para el rol «${named}»`,
        "Credencial del rol",
        "config",
      );
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
        // El tarro solo cuando el caso presenta una credencial que debe funcionar. Un caso que
        // manda `none` o `insufficient` está comprobando qué hace el objetivo con una credencial
        // mala **a propósito**, y darle la cookie de la sesión convierte cada uno de esos en un 200
        // verde que no prueba nada. Es la misma regla que ya tenía la sesión del login.
        ...(WRONG_ON_PURPOSE.has(step.auth ?? "") ? {} : { jar: input.target.cookies }),
        ...(payload ? { body: payload.text } : {}),
      });
      samples.push(response.durationMs);
      timing = response.timing;
      // Lo que ponga el objetivo se guarda igual: el login de un caso es un login, y quien decide
      // si la cookie viaja es la petición siguiente, no esta.
      absorbCookies(input.target, url, response.setCookie, Date.now());
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
    // The schema is looked up for the status that actually came back **when that status was one
    // the case accepted**. A denial case that expects 403 and correctly receives 404 would
    // otherwise be validated against the 403 schema, and the shape assertion would fail over a
    // response that is exactly right.
    const forStatus = (step.alsoAccepted ?? []).includes(actual.status) ? actual.status : step.expectedStatus;
    const declared = input.target.spec
      ? responseSchema(input.target.spec, step.operationPath, step.method, forStatus, actual.contentType)
      : undefined;

    const verdict = evaluateResponse({
      method: step.method,
      operationPath: step.operationPath,
      expectedStatus: step.expectedStatus,
      ...(step.alsoAccepted?.length ? { alsoAccepted: step.alsoAccepted } : {}),
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
   *
   * The step's own headers are applied **last**, over everything this builds. A header somebody
   * typed into the editor is knowledge about the target that the contract does not carry, and the
   * three defaults it can collide with are all guesses next to it: `Accept` and `Content-Type` are
   * what the executor assumes of an API it has only read a JSON document about, and the credential
   * header is the one case worth spelling out — writing `Authorization` by hand in a request that
   * also asks for the working credential is a contradiction, and the honest resolution is the one
   * the person can see in the «Petición» panel afterwards. It is masked there either way, because
   * {@link maskHeaders} matches on the name and not on where the value came from.
   */
  private headersFor(
    step: StepRequest,
    target: ExecutionTarget,
    payload: SerializedBody | null,
  ): Record<string, string> {
    const own = step.headers ?? {};
    const base: Record<string, string> = { Accept: "application/json" };
    // From the payload and not from a guess: a form body carries the boundary its own serialisation
    // chose, and a `Content-Type` naming a different one is a request no target can parse.
    if (payload) base["Content-Type"] = payload.contentType;
    if (step.auth === "none") return { ...base, ...own };

    // A named role resolves to the credential stored under that name; the four fixed selectors
    // resolve to the three roles they always meant. One lookup either way, because that is what
    // `auth` has always been — a selector over this environment's credentials.
    const named = roleOf(step.auth);
    const role =
      named ?? (step.auth === "insufficient" ? "insufficient" : step.auth === "api-key" ? "alternate" : "primary");
    // A session obtained during this run stands in for the stored working credential, and for
    // nothing else. The three roles that exist to be rejected keep being rejected — and so does
    // every named one: a run that logged in as somebody must not turn «como vendedor» into «como
    // quien inició sesión», which would make an authorization matrix agree with itself.
    if (role === "primary" && !named && target.session) {
      return { ...base, [target.session.header]: target.session.value, ...own };
    }
    const credential = target.credentials.find((candidate) => candidate.role === role);
    // A missing credential is not silently the working one: sending `primary` where the case
    // asked for `insufficient` would turn a 403 case into a green 200 that proves nothing. For a
    // named role the case is refused outright further up, because «este entorno no tiene
    // credencial de vendedor» is a configuration answer and not a verdict about the endpoint.
    if (!credential) return { ...base, ...own };
    return { ...base, ...credentialHeader(credential, this.cipher.decrypt(credential.secretCiphertext)), ...own };
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

/** An absolute URL as it is; a path hangs off the environment's base URL. SAFE_FETCH refuses
 * whatever this leaves that is not http(s). */
/**
 * Las cookies de una respuesta, metidas en el tarro de la corrida **en el sitio**.
 *
 * Se muta el array en vez de devolver uno nuevo porque el objetivo de la corrida es lo que viaja
 * entre pasos: es el mismo mecanismo que `variables` y `session`, y cambiarlo por una copia haría
 * que la cookie del login se perdiera justo donde hace falta.
 *
 * Lo rechazado no se cuenta aquí. En una corrida no hay nadie mirando una pantalla, y el paso
 * siguiente fallará con su propio 401 y su propio motivo.
 */
export function absorbCookies(target: ExecutionTarget, url: string, lines: string[], now: number): void {
  if (!lines.length) return;
  const read = cookiesFrom(lines, url, now);
  if (!read.cookies.length) return;
  const merged = withCookies(target.cookies, read.cookies, now);
  target.cookies.splice(0, target.cookies.length, ...merged);
}

export function fetchUrl(url: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const base = baseUrl.replace(/\/+$/, "");
  return url.startsWith("/") ? `${base}${url}` : `${base}/${url}`;
}

function sameOrigin(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
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
