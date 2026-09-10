/**
 * The same matrix, run through the product, driven the way an operator would drive it.
 *
 * Everything here goes through the public HTTP API with a real session: point an environment at
 * the target, store the three credentials, `POST /runs`, wait, read the cases. Nothing reaches
 * into the database. If this needed a shortcut the API does not offer, the parity it proves would
 * be parity of an internal function rather than of the product.
 */
import { ADMIN_TOKEN, API_KEY, READ_TOKEN } from "./credentials.ts";
import type { Verdict } from "./legacy-verdicts.ts";

export type ProductSession = { api: string; base: string; token: string };

async function call(session: ProductSession, method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${session.api}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const fields = parsed?.errors?.map((error: { field: string; detail: string }) => `\n    ${error.field}: ${error.detail}`).join("") ?? "";
    throw new Error(`${method} ${path} → ${response.status}: ${parsed?.detail ?? response.statusText}${fields}`);
  }
  return parsed;
}

export async function openSession(api: string, email: string, password: string, projectName: string): Promise<ProductSession> {
  const bootstrap: ProductSession = { api, base: "", token: "" };
  const login = await call(bootstrap, "POST", "/auth/login", { email, password });
  const session: ProductSession = { api, base: "", token: login.accessToken };
  const me = await call(session, "GET", "/auth/me");
  const organization = me.organizations[0];
  if (!organization) throw new Error("La cuenta no pertenece a ninguna organización");
  const projects: { id: string; name: string }[] = await call(session, "GET", `/orgs/${organization.id}/projects`);
  const project = projects.find((candidate) => candidate.name === projectName);
  if (!project) throw new Error(`No existe el proyecto ${projectName}: ejecuta tools/migrate-digital-catalog.ts primero`);
  session.base = `/orgs/${organization.id}/projects/${project.id}`;
  return session;
}

/**
 * The environment is rewritten on every pass rather than assumed.
 *
 * `authEnforced` is what decides whether the 97 credential cases are generated at all, and the
 * two passes disagree about it — so reusing whatever the last run left behind would silently
 * compare 311 cases against 214.
 */
export async function prepareEnvironment(session: ProductSession, name: string, baseUrl: string, authEnabled: boolean): Promise<string> {
  const environments: { id: string; name: string }[] = await call(session, "GET", `${session.base}/environments`);
  const existing = environments.find((environment) => environment.name === name);
  const settings = { baseUrl, writesAllowed: true, authEnforced: authEnabled };
  const environmentId = existing
    ? (await call(session, "PATCH", `${session.base}/environments/${existing.id}`, settings), existing.id)
    : (await call(session, "POST", `${session.base}/environments`, { name, ...settings })).environmentId;

  if (authEnabled) {
    await call(session, "PUT", `${session.base}/environments/${environmentId}/credentials`, { name: "catalog:admin", role: "primary", kind: "bearer", secret: ADMIN_TOKEN });
    await call(session, "PUT", `${session.base}/environments/${environmentId}/credentials`, { name: "catalog:read", role: "insufficient", kind: "bearer", secret: READ_TOKEN });
    await call(session, "PUT", `${session.base}/environments/${environmentId}/credentials`, { name: "X-API-Key de E2E", role: "alternate", kind: "api_key", headerName: "X-API-Key", secret: API_KEY });
  } else {
    // Deleted, not left in place: with the target running without `--auth` the dashboard sends
    // nothing, and a stored credential would make the two sides send different requests.
    for (const role of ["primary", "insufficient", "alternate"]) {
      await fetch(`${session.api}${session.base}/environments/${environmentId}/credentials/${role}`, { method: "DELETE", headers: { Authorization: `Bearer ${session.token}` } });
    }
  }
  return environmentId;
}

export async function productVerdicts(session: ProductSession, environmentId: string, onProgress?: (completed: number, total: number) => void): Promise<Verdict[]> {
  const started = await call(session, "POST", `${session.base}/runs`, {
    environmentId,
    // The legacy side runs `buildQueue(..., { mode: "safe" })` with no case selection and one
    // latency sample. Anything else here is comparing two different runs.
    order: "safe",
    samples: 1,
    delayMs: 0,
  });
  const runId = started.runId;

  let run: any;
  for (;;) {
    run = await call(session, "GET", `${session.base}/runs/${runId}`);
    onProgress?.(run.totals.completed, run.totals.cases);
    if (["passed", "failed", "cancelled", "error"].includes(run.status)) break;
    // 1.5s, not the 400ms this started at: 150 polls a minute is over the API's own
    // 120-per-minute limit, so a long run would throttle the very requests watching it. The
    // stream is the right way to follow a run live; a script that only wants the end can wait.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (run.status === "error") throw new Error(`La corrida terminó en error: ${run.error}`);

  // One request for the whole run. The per-case view carries every response body, and asking it
  // 311 times is both slow and, against a 120-per-minute limit, a 429 — which is what `/report`
  // was added for while building this cut.
  const report = await call(session, "GET", `${session.base}/runs/${runId}/report`);
  return report.cases.map((runCase: any): Verdict => ({
    key: `${runCase.operationId}:${runCase.scenarioId}`,
    operationId: runCase.operationId,
    scenarioId: runCase.scenarioId,
    ok: runCase.status === "passed",
    steps: runCase.steps.length,
    failedAssertions: runCase.steps.flatMap((step: any) => (step.assertions ?? []).filter((assertion: any) => !assertion.pass).map((assertion: any) => assertion.label)),
  }));
}
