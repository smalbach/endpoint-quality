#!/usr/bin/env node
/**
 * Runs a project's matrix from a pipeline and exits with the verdict.
 *
 * This is the whole point of moving the execution loop off the browser: a run is a resource on a
 * server, so a CI job can start one, wait for it and fail the build. The coupled dashboard could
 * not do this at all — its results lived in `useState` and died with the tab.
 *
 *     EQ_API=https://eq.example.com EQ_TOKEN=eqt_… \
 *       node eq-run.mjs --project "Digital Catalog" --environment staging
 *
 * Exit codes, chosen so a pipeline can tell the three apart:
 *
 *   0  the run passed
 *   1  the run failed — some case is red, and the failing cases are printed
 *   2  it could not be run at all: bad arguments, no token, API unreachable, unknown project
 *
 * **Deliberately dependency-free.** A verification tool that needs `npm install` to tell you
 * whether your API is healthy has added a supply chain to your pipeline; this is one file that
 * any Node 22 runs. It is also what `docker compose` uses to fire the demo run, so the path a
 * newcomer sees on day one is the same one their pipeline uses.
 */
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const has = (name) => args.includes(`--${name}`);

const API = (process.env.EQ_API ?? flag("api") ?? "http://localhost:3001").replace(/\/+$/, "");
const TOKEN = process.env.EQ_TOKEN ?? flag("token");
const PROJECT = flag("project");
const ENVIRONMENT = flag("environment");
const ORDER = flag("order") ?? "safe";
/**
 * The project's own labels to select by, comma-separated.
 *
 * The reason the labels exist at all: a pipeline says «corre lo crítico» once and keeps saying it,
 * instead of carrying a list of operation ids that goes stale the next time somebody adds one. Any
 * of them, never all — that is what somebody writing two of them means.
 */
const LABELS = (flag("labels") ?? "")
  .split(",")
  .map((label) => label.trim())
  .filter(Boolean);
/**
 * Where to write the JUnit XML, when a job wants one.
 *
 * Every runner on the market reads it and draws the red cases in its own UI, with the failure text
 * next to the test that produced it. Written to a file rather than to stdout because that is what
 * a runner collects — `--json` already owns stdout, and a job that asked for both would get an XML
 * document with a JSON report in the middle of it.
 */
const JUNIT = flag("junit");
const SAMPLES = Number(flag("samples") ?? 1);
const DELAY = Number(flag("delay") ?? 0);
/** A skipped case is one the environment refused to run — a write against a read-only target. It
 * is not a finding about the API, so it does not fail the build unless somebody says it should:
 * a pipeline that meant to exercise the writes and silently did not is worth catching too. */
const FAIL_ON_SKIP = has("fail-on-skip");
const TIMEOUT_MS = Number(flag("timeout") ?? 1_800) * 1000;
const QUIET = has("quiet");

function usage(message) {
  console.error(`${message}\n
  eq-run --project <nombre|id> --environment <nombre|id> [opciones]

    --api <url>          o EQ_API           (por defecto http://localhost:3001)
    --token <token>      o EQ_TOKEN         token de servicio de la organización
    --order safe|contract                   por defecto safe: lecturas primero, DELETE al final
    --labels <a,b>                          solo las operaciones con alguna de esas etiquetas
    --junit <fichero>                       escribe el informe en JUnit XML para que el CI lo pinte
    --samples <n>                           muestras de latencia por caso (1 = sin p95)
    --delay <ms>                            pausa entre casos, para destinos con rate limit
    --timeout <segundos>                    por defecto 1800
    --fail-on-skip                          los casos saltados también rompen la build
    --quiet                                 solo el resumen y los fallos
    --json                                  el informe completo por stdout, para otro paso`);
  process.exit(2);
}

if (!TOKEN) usage("Falta el token: EQ_TOKEN o --token.");
if (!PROJECT) usage("Falta --project.");
if (!ENVIRONMENT) usage("Falta --environment.");

/**
 * `as` is `"json"` for everything but the JUnit report, which is XML.
 *
 * Named rather than inferred from the path, because the failure it prevents is silent: parsing an
 * XML document as JSON throws inside this helper, and the message would be about a syntax error
 * rather than about the report the job asked for.
 */
async function call(method, path, body, as = "json") {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    // Distinguished from an API that answered: "connection refused" is a pipeline configuration
    // problem and a 403 is a permissions one, and they are fixed by different people.
    fail(2, `No se pudo contactar con ${API}: ${error instanceof Error ? error.message : error}`);
  }
  const text = await response.text();
  // Parsed even when the caller asked for text, but only to report an error: this API answers a
  // problem document in JSON whatever the request wanted, so the failure message stays useful.
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    if (as === "json") fail(2, `${method} ${path} → respuesta ilegible`);
  }
  if (!response.ok) {
    const fields = parsed?.errors?.map((error) => `\n    ${error.field}: ${error.detail}`).join("") ?? "";
    fail(2, `${method} ${path} → ${response.status}: ${parsed?.detail ?? response.statusText}${fields}`);
  }
  return as === "text" ? text : parsed;
}

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

const log = (message) => {
  if (!QUIET) console.log(message);
};

/** Matched by id first and by name second, so a name with a space works and an id is unambiguous. */
const pick = (items, wanted, what) => {
  const found = items.find((item) => item.id === wanted) ?? items.find((item) => item.name === wanted);
  if (!found) fail(2, `No existe ${what} "${wanted}". Hay: ${items.map((item) => item.name).join(", ") || "ninguno"}`);
  return found;
};

// `/auth/context` and not `/auth/me`: the latter is about a person and refuses a service token,
// correctly. A token belongs to exactly one organization, so there is nothing here to choose and
// nothing to get wrong by choosing — which is why this tool does not ask for an org id.
const context = await call("GET", "/auth/context");
const organization = context.organizations[0];
if (!organization) fail(2, "El token no pertenece a ninguna organización");

const projects = await call("GET", `/orgs/${organization.id}/projects`);
const project = pick(projects, PROJECT, "el proyecto");
const base = `/orgs/${organization.id}/projects/${project.id}`;

const environments = await call("GET", `${base}/environments`);
const environment = pick(environments, ENVIRONMENT, "el entorno");

log(`${organization.name} · ${project.name} · ${environment.name} → ${environment.baseUrl}`);

const { runId } = await call("POST", `${base}/runs`, {
  environmentId: environment.id,
  order: ORDER,
  samples: SAMPLES,
  delayMs: DELAY,
  ...(LABELS.length ? { labels: LABELS } : {}),
});
log(`corrida ${runId}${LABELS.length ? ` · etiquetas ${LABELS.join(", ")}` : ""}`);

const deadline = Date.now() + TIMEOUT_MS;
let run;
let lastCompleted = -1;
for (;;) {
  run = await call("GET", `${base}/runs/${runId}`);
  if (!QUIET && run.totals.completed !== lastCompleted) {
    lastCompleted = run.totals.completed;
    process.stdout.write(`\r  ${run.totals.completed}/${run.totals.cases} casos`);
  }
  if (["passed", "failed", "cancelled", "error"].includes(run.status)) break;
  if (Date.now() > deadline) {
    // Cancelled rather than abandoned: leaving a run going after the job that started it has
    // given up keeps writing to somebody's API for no reader.
    await call("POST", `${base}/runs/${runId}/cancel`).catch(() => {});
    fail(2, `\nLa corrida superó el tiempo límite de ${TIMEOUT_MS / 1000}s y se canceló.`);
  }
  // Well under the API's own rate limit: a poll that gets throttled is a poll that reports a
  // failure the run did not have.
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
if (!QUIET) process.stdout.write("\n");

// One request for the whole run, assertions included and no response bodies. Reading it case by
// case would be one request per case against a rate limit built for humans.
const report = await call("GET", `${base}/runs/${runId}/report`);

if (has("json")) {
  console.log(JSON.stringify(report, null, 2));
}

if (JUNIT) {
  // Asked for as XML rather than rendered here: the same run in two shapes must not be two pieces
  // of code that can disagree, and the one the API already writes is the one the report tests pin.
  const xml = await call("GET", `${base}/runs/${runId}/report?format=junit`, undefined, "text");
  await writeFile(JUNIT, xml, "utf8");
  log(`informe JUnit en ${JUNIT}`);
}

const failed = report.cases.filter((runCase) => runCase.status === "failed");
const skipped = report.cases.filter((runCase) => runCase.status === "skipped");

if (failed.length && !has("json")) {
  console.error(`\n${failed.length} casos en rojo:\n`);
  for (const runCase of failed) {
    console.error(`  ${runCase.method} ${runCase.path}  ${runCase.operationId}:${runCase.scenarioId}`);
    for (const step of runCase.steps) {
      for (const assertion of step.assertions ?? []) {
        // Only the failed ones, and with the detail: "Schema OpenAPI" is a label, "data must be
        // an array" is the thing somebody fixes.
        if (!assertion.pass) console.error(`      ${step.purpose}: ${assertion.label} — ${assertion.detail}`);
      }
    }
  }
}

const { cases, passed, failed: failedCount, skipped: skippedCount } = run.totals;
console.log(
  `\n${cases} casos · ${passed} en verde · ${failedCount} en rojo · ${skippedCount} saltados · ${run.status}`,
);
if (skippedCount && !FAIL_ON_SKIP) {
  console.log(
    `  Los saltados no rompen la build: son casos que este entorno no ejecuta. Usa --fail-on-skip si esperabas que corrieran.`,
  );
}

process.exit(failedCount > 0 || (FAIL_ON_SKIP && skipped.length) ? 1 : 0);
