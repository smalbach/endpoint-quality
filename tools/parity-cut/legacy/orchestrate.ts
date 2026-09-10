/**
 * The coupled dashboard's `runScenario`, lifted out of the React component that held it.
 *
 * This is the oracle of the P6 cut, so what matters is how faithful it is. The verdict logic —
 * status, envelope, content type, JSON Schema, latency budget — is **not** here: it lives in
 * `route.ts`, which is a byte-for-byte copy of `app/api/run/route.ts` and is called as a function.
 * What is here is only the *orchestration*: which requests a multi-step flow sends, in which
 * order, what it captures between them and which of the steps is the case under test.
 *
 * That part could not be copied verbatim, because in the original it is a closure over React
 * state. The edits applied, and nothing else:
 *
 * 1. **`setResults` / `setScenarioResults` calls dropped.** They paint the panel. Which step they
 *    paint still matters — it identifies the step the flow considers "the case" — so each one is
 *    replaced by a comment naming what it used to show. No branch changed.
 * 2. **`execute` calls `POST(request)` directly** instead of `fetch("/api/run")`. Same handler,
 *    same JSON in, same JSON out, minus a loopback hop.
 * 3. **`endpoints`, `bodyText`, `token`, `apiKey`, `readToken`, `samples` and `baseUrl` became
 *    parameters** rather than component state. `useEditorBody` is always `false`: it is the
 *    textarea, which a headless run has no equivalent of, and the original already refused to
 *    infer it from the selection.
 *
 * `verifySentFields` and `idFrom` are copied as they stand — they are pure.
 */
import { POST } from "./route.ts";
import type { Endpoint } from "../../../packages/runner-core/test/legacy/endpoints.ts";
import type { TestScenario } from "../../../packages/runner-core/test/legacy/scenarios.ts";

const DEFAULT_PARAMETERS: Record<string, string> = { product_id: "1", store_id: "1", category_id: "1", price_id: "1", projection_id: "1", product_category_id: "1", store_assortment_id: "1" };

function resolvePath(endpoint: Endpoint, values: Record<string, string>) {
  const path = endpoint.path.replace(/\{([^}]+)\}/g, (_, key: string) => encodeURIComponent(values[key] || "1"));
  const query = new URLSearchParams();
  endpoint.parameters?.filter((name) => !endpoint.path.includes(`{${name}}`) && values[name]).forEach((name) => query.set(name, values[name]));
  return query.size ? `${path}?${query}` : path;
}

export type RunResult = {
  ok: boolean;
  durationMs: number;
  assertions: { label: string; pass: boolean; detail: string }[];
  actual: { status: number; body: unknown } | null;
  step?: string;
};
export type ScenarioResult = { ok: boolean; durationMs: number; steps: RunResult[] };

export type Credentials = {
  token: string;
  apiKey: string;
  readToken: string;
  /**
   * Send **one** credential on `auth: "default"` instead of every field that happens to be filled.
   *
   * Off by default, because the point of this snapshot is to reproduce the original. It exists
   * because the P6 cut found the original is wrong here, and this is how the finding is isolated:
   * with it on, the two sides agree case for case, which is what proves the ten disagreements
   * have exactly one cause and are not ten separate regressions.
   *
   * The original sends `Authorization` *and* `X-API-Key` together whenever both fields are
   * filled. An operation that does not declare `ApiKeyAuth` answers **401** to that — "this
   * operation only accepts an OAuth2 bearer token, not an API key" — no matter how good the
   * bearer is. So filling in the API key, which the 403 and D-29 cases require, turns every
   * `default` write case red for a reason that has nothing to do with the endpoint.
   */
  singleCredential?: boolean;
};

export class LegacyRunner {
  // Written out rather than as constructor parameter properties: Node's type-stripping runs this
  // file without a compiler, and it refuses that syntax.
  readonly endpoints: Endpoint[];
  readonly baseUrl: string;
  readonly credentials: Credentials;
  readonly samples: number;

  constructor(endpoints: Endpoint[], baseUrl: string, credentials: Credentials, samples: number) {
    this.endpoints = endpoints;
    this.baseUrl = baseUrl;
    this.credentials = credentials;
    this.samples = samples;
  }

  /** Verbatim from the component. `none` is the 401, `insufficient` the 403, `api-key` the D-29
   * case where a key is presented to an operation that does not declare `ApiKeyAuth`. */
  private credentialsFor(scenario: TestScenario): Record<string, string> {
    const { token, apiKey, readToken } = this.credentials;
    if (scenario.auth === "none") return {};
    if (scenario.auth === "api-key") return apiKey ? { "X-API-Key": apiKey } : {};
    if (scenario.auth === "insufficient") return readToken ? { Authorization: `Bearer ${readToken}` } : {};
    if (this.credentials.singleCredential) return token ? { Authorization: `Bearer ${token}` } : {};
    const credentials: Record<string, string> = {};
    if (token) credentials.Authorization = `Bearer ${token}`;
    if (apiKey) credentials["X-API-Key"] = apiKey;
    return credentials;
  }

  private async execute(item: Endpoint, scenario: TestScenario, parameterOverrides: Record<string, string> = {}, options: { body?: Record<string, unknown> } = {}): Promise<RunResult> {
    let parsedBody: unknown = undefined;
    const text = options.body ? JSON.stringify(options.body) : scenario.body ? JSON.stringify(scenario.body) : "";
    if (text.trim()) { try { parsedBody = JSON.parse(text); } catch { throw new Error("El body no es JSON válido"); } }
    const path = resolvePath(item, { ...DEFAULT_PARAMETERS, ...(scenario.parameters ?? {}), ...parameterOverrides });
    const request = new Request("http://harness.invalid/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: this.baseUrl, method: item.method, path, operationPath: item.path, expectedStatus: scenario.expectedStatus, body: parsedBody, headers: this.credentialsFor(scenario), responseShape: scenario.expectedStatus >= 400 ? "ProblemDetails" : item.responseShape, samples: this.samples }),
    });
    const response = await POST(request);
    // was: setResults((current) => ({ ...current, [item.id]: result }))
    return (await response.json()) as RunResult;
  }

  private detailEndpointFor(collection: Endpoint) {
    const prefixPlaceholders = (collection.path.match(/\{/g) ?? []).length;
    return this.endpoints.find((candidate) => candidate.method === "GET" && candidate.path.startsWith(`${collection.path}/{`) && (candidate.path.match(/\{/g) ?? []).length === prefixPlaceholders + 1);
  }

  private idFrom(result: RunResult, detail: Endpoint) {
    const data = (result.actual?.body as { data?: Record<string, unknown> } | undefined)?.data;
    const idField = [...detail.path.matchAll(/\{([^}]+)\}/g)].at(-1)?.[1];
    return idField && data ? { field: idField, value: String(data[idField] ?? "") } : undefined;
  }

  private verifySentFields(result: RunResult, sent: Record<string, unknown>) {
    const received = (result.actual?.body as { data?: Record<string, unknown> } | undefined)?.data;
    const mismatches = Object.entries(sent).filter(([key, value]) => JSON.stringify(received?.[key]) !== JSON.stringify(value)).map(([key]) => key);
    const pass = Boolean(received) && mismatches.length === 0;
    result.assertions.push({ label: "Persistencia de campos", pass, detail: pass ? `${Object.keys(sent).length} campos coinciden con lo enviado` : `No coinciden: ${mismatches.join(", ")}` });
    result.ok = result.ok && pass;
    return result;
  }

  private async deleteCreated(detail: Endpoint, captured: { field: string; value: string }) {
    const remove = this.endpoints.find((candidate) => candidate.method === "DELETE" && candidate.path === detail.path);
    if (!remove) return undefined;
    const parameters = { [captured.field]: captured.value };
    const scenario = { id: "cleanup-delete", name: "Limpiar el recurso creado", description: "Deja la base como estaba para que el caso pueda repetirse.", expectedStatus: 204, parameters, flow: "request" } as TestScenario;
    return this.execute(remove, scenario, parameters);
  }

  async runScenario(item: Endpoint, scenario: TestScenario, initialParameters: Record<string, string> = {}): Promise<ScenarioResult> {
    const steps: RunResult[] = [];
    if (scenario.flow === "request" || scenario.flow === "bulk-read") {
      steps.push(await this.execute(item, scenario, initialParameters));
    } else if (scenario.flow === "create-read") {
      const created = await this.execute(item, scenario, initialParameters);
      steps.push(created);
      const detail = this.detailEndpointFor(item);
      if (detail) {
        const captured = this.idFrom(created, detail);
        const capturedOk = Boolean(captured?.value);
        created.assertions.push({ label: "ID retornado", pass: capturedOk, detail: capturedOk ? `${captured?.field} = ${captured?.value}` : "La respuesta no contiene el identificador esperado" });
        created.ok = created.ok && capturedOk;
        if (created.ok && captured?.value) {
          const readScenario = { id: "verify-created", name: "Consultar ID creado", description: "Verificación posterior", expectedStatus: 200, parameters: { [captured.field]: captured.value }, flow: "request" } as TestScenario;
          const verified = this.verifySentFields(await this.execute(detail, readScenario, readScenario.parameters), scenario.body ?? {});
          steps.push(verified);
          // was: setResults(... [item.id]: verified) — the panel showed the verification
          const cleanup = await this.deleteCreated(detail, captured);
          if (cleanup) steps.push(cleanup);
        }
      }
    } else {
      const idField = [...item.path.matchAll(/\{([^}]+)\}/g)].at(-1)?.[1];
      const collectionPath = item.path.replace(/\/\{[^}]+\}$/, "");
      const createEndpoint = this.endpoints.find((candidate) => candidate.method === "POST" && candidate.path === collectionPath);
      const readEndpoint = this.endpoints.find((candidate) => candidate.method === "GET" && candidate.path === item.path);
      if (!idField || !createEndpoint || !readEndpoint) {
        steps.push(await this.execute(item, scenario, {}));
      } else {
        const createScenario = { id: "setup-create", name: "Preparar entidad", description: "Prerequisito aislado", expectedStatus: createEndpoint.statuses.includes(201) ? 201 : 200, body: createEndpoint.body, flow: "request" } as TestScenario;
        const created = await this.execute(createEndpoint, createScenario);
        steps.push(created);
        const captured = this.idFrom(created, readEndpoint);
        const capturedOk = Boolean(captured?.value);
        created.assertions.push({ label: "ID de preparación", pass: capturedOk, detail: capturedOk ? `${captured?.field} = ${captured?.value}` : "No se pudo capturar el identificador" });
        created.ok = created.ok && capturedOk;
        if (created.ok && captured?.value && scenario.flow === "deleted-read") {
          const parameters = { [idField]: captured.value };
          const removal = await this.execute(item, { ...scenario, id: "setup-delete", name: "Eliminar el recurso", expectedStatus: 204 }, parameters);
          created.step = "Preparación: crea la entidad que se va a eliminar";
          removal.step = "Preparación: la elimina. El 204 lo comprueba el caso anterior";
          steps.push(removal);
          if (removal.ok) {
            const readScenario = { id: "read-deleted", name: "Consultar el recurso eliminado", description: "El GET posterior al DELETE", expectedStatus: 404, parameters, flow: "request" } as TestScenario;
            const read = await this.execute(readEndpoint, readScenario, parameters);
            read.step = "El caso: consultar lo eliminado debe ser 404 en Problem Details";
            steps.push(read);
            const repeatScenario = { id: "delete-again", name: "Eliminar de nuevo", description: "Un segundo DELETE sobre lo que ya no existe", expectedStatus: 404, parameters, flow: "request" } as TestScenario;
            const repeated = await this.execute(item, repeatScenario, parameters);
            repeated.step = "Un segundo DELETE sobre lo que ya no existe: 404, no 204";
            steps.push(repeated);
            // was: setResults(... [item.id]: read) — the case under test is the GET, not the
            // last request the flow happened to send
          }
        } else if (created.ok && captured?.value) {
          const parameters = { [idField]: captured.value };
          const mutation = await this.execute(item, scenario, parameters);
          steps.push(mutation);
          if (mutation.ok) {
            const verifyScenario = { id: "verify-mutation", name: "Verificar persistencia", description: "Consulta posterior", expectedStatus: scenario.flow === "delete-read" ? 404 : 200, parameters, flow: "request" } as TestScenario;
            const verification = await this.execute(readEndpoint, verifyScenario, parameters);
            if (scenario.flow !== "delete-read") this.verifySentFields(verification, scenario.body ?? {});
            steps.push(verification);
            // was: setResults(... [item.id]: verification)
            if (scenario.flow !== "delete-read") {
              const cleanup = await this.deleteCreated(readEndpoint, captured);
              if (cleanup) steps.push(cleanup);
            }
          }
        }
      }
    }
    return { ok: steps.length > 0 && steps.every((step) => step.ok), durationMs: steps.reduce((total, step) => total + step.durationMs, 0), steps };
  }
}
