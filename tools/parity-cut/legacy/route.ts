import { NextResponse } from "./next-server-shim.ts";
import { responseSchema, validateJson } from "../../../packages/runner-core/test/legacy/contract.mjs";
import { budgetFor, latencyAssertion, percentile } from "../../../packages/runner-core/test/legacy/budgets.mjs";

type RunRequest = { baseUrl: string; method: string; path: string; operationPath: string; expectedStatus: number; body?: unknown; headers?: Record<string, string>; responseShape?: string; samples?: number };

export async function POST(request: Request) {
  const input = (await request.json()) as RunRequest;
  const started = performance.now();
  try {
    const base = new URL(input.baseUrl);
    if (!["http:", "https:"].includes(base.protocol)) throw new Error("Solo se permiten URLs HTTP o HTTPS.");
    const target = new URL(input.path, base.toString().replace(/\/?$/, "/"));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const method = input.method.toUpperCase();
    const supportsBody = !["GET", "HEAD"].includes(method);
    const headers = { Accept: "application/json", ...(input.headers ?? {}) } as Record<string, string>;
    if (supportsBody && input.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(target, { method, headers, body: supportsBody && input.body !== undefined ? JSON.stringify(input.body) : undefined, signal: controller.signal });
    clearTimeout(timeout);
    // Extra samples are taken **only on safe methods**. Repeating a POST would create N
    // resources and repeating a DELETE would 404 on the second one: the measurement would
    // change the thing being measured. The first sample is the response that gets asserted;
    // the rest only feed the percentile.
    const latencies: number[] = [Math.round(performance.now() - started)];
    const wanted = Math.min(50, Math.max(1, Math.round(input.samples ?? 1)));
    if (wanted > 1 && !supportsBody) {
      for (let i = 1; i < wanted; i += 1) {
        const sampleStarted = performance.now();
        try {
          const extra = await fetch(target, { method, headers });
          await extra.arrayBuffer();
          latencies.push(Math.round(performance.now() - sampleStarted));
        } catch {
          break;
        }
      }
    }
    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();
    let body: unknown = raw;
    if (contentType.includes("json") && raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
    const statusMatches = response.status === input.expectedStatus;
    const isObject = typeof body === "object" && body !== null;
    const envelopeMatches = input.responseShape === "No body" ? raw.length === 0 : input.responseShape === "HealthStatus" ? isObject && "status" in (body as Record<string, unknown>) && "checks" in (body as Record<string, unknown>) : input.responseShape === "ProblemDetails" ? isObject && "status" in (body as Record<string, unknown>) && "title" in (body as Record<string, unknown>) && "type" in (body as Record<string, unknown>) : isObject && "data" in (body as Record<string, unknown>);
    // The 405 of an operation that has no router yet is its own diagnosis, and it is the one
    // that matters: nothing downstream — envelope, schema, content type — says anything useful
    // about a response the API never produced. Reporting `Fallback: envelope verificado (null)`
    // next to it buries the only actionable line under noise.
    const notImplemented = response.status === 405;
    let expectedSchema: unknown = null;
    let schemaValid: boolean | null = null;
    let schemaErrors: string[] | null = null;
    let specError: string | null = null;
    try {
      const specResponse = await fetch(new URL("/openapi.json", base));
      const spec = await specResponse.json() as Record<string, unknown>;
      const declaredSchema = responseSchema(spec, input.operationPath, input.method, input.expectedStatus, contentType);
      if (declaredSchema) {
        expectedSchema = declaredSchema;
        schemaErrors = validateJson(body, expectedSchema);
        schemaValid = schemaErrors.length === 0;
      } else if (input.responseShape === "No body") {
        schemaValid = raw.length === 0;
      }
    } catch (error) {
      specError = error instanceof Error ? error.message : "No se pudo cargar /openapi.json";
    }
    const contentTypeMatches = input.responseShape === "No body" || contentType.includes("json");
    const durationMs = latencies[0];
    const budget = budgetFor(input.method, input.operationPath, input.path);
    // No published budget means no assertion — a write has no target in the RFP, and a green
    // tick that asserts nothing is exactly what this replaced.
    const latency = notImplemented ? null : latencyAssertion(budget, latencies);
    const schemaPass = notImplemented ? false : schemaValid ?? envelopeMatches;
    const schemaDetail = notImplemented
      ? "No evaluado: la API respondió 405"
      : specError
        ? `No se pudo cargar el schema: ${specError}. Se verificó el envelope ${input.responseShape}`
        : schemaValid === null
          ? `OpenAPI no declara ${input.expectedStatus} para esta operación; se verificó el envelope ${input.responseShape}`
          : schemaValid
            ? "JSON válido contra el schema"
            : (schemaErrors ?? []).join(" · ");
    return NextResponse.json({ ok: statusMatches && envelopeMatches && contentTypeMatches && schemaPass && (latency?.pass ?? true), durationMs, request: { method: input.method, url: target.toString(), headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, /authorization|api-key/i.test(key) ? "••••••••" : value])), body: input.body ?? null }, expected: { status: input.expectedStatus, responseShape: input.responseShape, contentType: input.responseShape === "No body" ? null : input.responseShape === "ProblemDetails" ? "application/problem+json" : "application/json", schema: expectedSchema, schemaDiagnostic: specError ?? (notImplemented ? "La API respondió 405: la operación no tiene router" : schemaValid === null ? `OpenAPI no declara ${input.expectedStatus} para esta operación` : null) }, actual: { status: response.status, statusText: response.statusText, contentType, headers: Object.fromEntries(response.headers.entries()), body }, assertions: [{ label: `Status ${input.expectedStatus}`, pass: statusMatches, detail: notImplemented ? `Recibido 405: ${method} ${input.operationPath} no está implementado en la API` : `Recibido ${response.status}` }, { label: "Schema OpenAPI", pass: schemaPass, detail: schemaDetail }, { label: "Content-Type", pass: contentTypeMatches, detail: contentType || "Sin Content-Type" }, ...(latency ? [latency] : [])], latency: { samples: latencies, p50: percentile(latencies, 50), p95: percentile(latencies, 95), budgetMs: budget?.ms ?? null } });
  } catch (error) {
    return NextResponse.json({ ok: false, durationMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : "No se pudo ejecutar la solicitud", request: { method: input.method, url: `${input.baseUrl}${input.path}`, body: input.body ?? null }, expected: { status: input.expectedStatus, responseShape: input.responseShape }, actual: null, assertions: [{ label: "Conexión con la API", pass: false, detail: "La API no respondió" }] });
  }
}
