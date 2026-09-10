#!/usr/bin/env node
/**
 * Turns a freshly migrated install into something you can look at.
 *
 * `docker compose up` on an empty database gives a login screen and nothing to log into, which is
 * a working deployment and a useless first five minutes. This creates an account, a project whose
 * contract is read **from the sample API's live `/openapi.json`**, an environment pointing at it,
 * and a service token — then runs the matrix once through `eq-run.mjs`, the same path a pipeline
 * uses.
 *
 * Idempotent: run it twice and the second run reuses what the first created. The demo compose
 * file calls it on every `up`, and an `up` after a restart should not be a different experience
 * from the first one.
 *
 *     EQ_API=http://localhost:3001 EQ_TARGET=http://localhost:9000 node seed-demo.mjs
 *
 * The account it creates is a **demo account with a published password**. It is fine on a laptop
 * and it is not fine anywhere else, which is why nothing in the production compose file calls
 * this and why it refuses to run when the API says it is in production.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

const API = (process.env.EQ_API ?? "http://localhost:3001").replace(/\/+$/, "");
const TARGET = (process.env.EQ_TARGET ?? "http://localhost:9000").replace(/\/+$/, "");
const EMAIL = process.env.EQ_EMAIL ?? "demo@example.com";
const PASSWORD = process.env.EQ_PASSWORD ?? "una-contraseña-de-demo";
const PROJECT_NAME = process.env.EQ_PROJECT ?? "Sample API";
const ENVIRONMENT_NAME = "demo";
const RUN = process.env.EQ_SEED_RUN !== "false";

let token = "";

async function call(method, path, body, { auth = true } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(auth && token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const fields = parsed?.errors?.map((error) => `\n    ${error.field}: ${error.detail}`).join("") ?? "";
    const error = new Error(`${method} ${path} → ${response.status}: ${parsed?.detail ?? response.statusText}${fields}`);
    error.status = response.status;
    throw error;
  }
  return parsed;
}

/** The API and the sample target come up in their own time; a seed that assumes otherwise fails
 * on a cold `up` and works on every one after, which is the worst way for something to fail. */
async function waitFor(url, what, seconds = 60) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${what} no respondió en ${url} tras ${seconds}s`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function main() {
  await waitFor(`${API}/health`, "la API", 90);
  await waitFor(`${TARGET}/openapi.json`, "la API de muestra", 60);

  // Register, or log in if the account is already there. `register` answering 409 is the second
  // `up`, not an error.
  try {
    await call("POST", "/auth/register", { email: EMAIL, password: PASSWORD, name: "Demo", organizationName: "Demo" }, { auth: false });
    console.log(`cuenta        creada  ${EMAIL}`);
  } catch (error) {
    if (error.status !== 409) throw error;
    console.log(`cuenta        ya existía  ${EMAIL}`);
  }
  const session = await call("POST", "/auth/login", { email: EMAIL, password: PASSWORD }, { auth: false });
  token = session.accessToken;

  const me = await call("GET", "/auth/me");
  const organization = me.organizations[0];
  const projects = await call("GET", `/orgs/${organization.id}/projects`);
  const existing = projects.find((project) => project.name === PROJECT_NAME);
  const projectId = existing?.id ?? (await call("POST", `/orgs/${organization.id}/projects`, { name: PROJECT_NAME, description: "El servicio de muestra que viene con el compose." })).projectId;
  console.log(`proyecto      ${existing ? "reutilizado" : "creado"}  ${PROJECT_NAME}`);
  const base = `/orgs/${organization.id}/projects/${projectId}`;

  // Read from the live document, not from a file in this repo. That is the product's actual
  // workflow, and it is also the only version of this demo that keeps being true when the sample
  // API changes.
  const imported = await call("POST", `${base}/spec-versions`, { source: { kind: "url", url: `${TARGET}/openapi.json` } });
  console.log(`contrato      ${imported.operationCount} operaciones · ${imported.unchanged ? "sin cambios" : "importado"}`);

  // The configuration, section by section, through the same endpoint an operator uses. This is
  // the half of the demo worth reading: a contract says what each operation *answers*, and never
  // what payload is valid, which one collides with a unique key, or how fast it should be. That
  // is what a project adds — and it is why the same engine works on a contract it has never seen.
  const configuration = JSON.parse(readFileSync(join(HERE, "../examples/sample-api/config.json"), "utf8"));
  for (const [section, data] of Object.entries(configuration)) {
    if (section.startsWith("_")) continue;
    await call("PUT", `${base}/config/${section}`, data);
  }
  console.log(`configuración ${Object.keys(configuration).filter((key) => !key.startsWith("_")).join(", ")}`);

  const environments = await call("GET", `${base}/environments`);
  const environment = environments.find((candidate) => candidate.name === ENVIRONMENT_NAME);
  const environmentId = environment?.id ?? (await call("POST", `${base}/environments`, {
    name: ENVIRONMENT_NAME,
    baseUrl: TARGET,
    // Writes on, because the sample API is disposable and in memory — and because the case this
    // demo exists to show is a DELETE that lies. Neither flag is ever on by default.
    writesAllowed: true,
    authEnforced: false,
  })).environmentId;
  console.log(`entorno       ${ENVIRONMENT_NAME} → ${TARGET}`);

  const coverage = await call("GET", `${base}/coverage`);
  console.log(`cobertura     ${coverage.totals.covered}/${coverage.totals.declaredResponses} respuestas declaradas con caso · ${coverage.totals.cases} casos`);

  const tokens = await call("GET", `/orgs/${organization.id}/tokens`);
  let serviceToken = null;
  if (!tokens.some((candidate) => candidate.name === "demo-ci")) {
    // Returned once and never again — it is stored hashed. Printing it here is the whole point:
    // the next thing the reader does is paste it into `eq-run`.
    serviceToken = (await call("POST", `/orgs/${organization.id}/tokens`, { name: "demo-ci" })).token;
  }

  console.log(`\n  Interfaz    ${process.env.EQ_WEB ?? "http://localhost:8080"}`);
  console.log(`  Entrar con  ${EMAIL} / ${PASSWORD}`);
  if (serviceToken) {
    console.log(`\n  Token de servicio para CI (no se vuelve a mostrar):\n    ${serviceToken}`);
    console.log(`\n    EQ_API=${API} EQ_TOKEN=${serviceToken} \\`);
    console.log(`      node tools/eq-run.mjs --project "${PROJECT_NAME}" --environment ${ENVIRONMENT_NAME}`);
  }

  if (RUN && serviceToken) {
    console.log(`\n  Ejecutando la matriz una vez, por el mismo camino que usa una pipeline:\n`);
    const script = join(HERE, "eq-run.mjs");
    const child = spawn(process.execPath, [script, "--project", PROJECT_NAME, "--environment", ENVIRONMENT_NAME], {
      stdio: "inherit",
      env: { ...process.env, EQ_API: API, EQ_TOKEN: serviceToken },
    });
    const code = await new Promise((resolve) => child.on("close", resolve));
    // **Exit 0 even when the run comes back red.** The demo target has a `DELETE` that answers
    // 204 and does not delete; that case *should* be red, and it is what the demo is showing.
    // Failing the seed on it would make `docker compose up` look broken when it is working.
    console.log(
      code === 1
        ? "\n  Los dos rojos son a propósito. El borrado es blando y la lectura por id se olvidó\n  del flag: DELETE /widgets/{id} responde el 204 que su contrato declara y sigue\n  sirviendo la fila. Solo lo ve la relectura. Abre deleteWidget:delete-read."
        : "\n  Ningún caso en rojo — pero el destino de muestra tiene un fallo a propósito.\n  Si esto sale verde, algo no se está comprobando.",
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
