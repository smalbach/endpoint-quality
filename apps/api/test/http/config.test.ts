/**
 * The acceptance test of P3, and the one that says the decoupling actually landed.
 *
 * A project is created through the API, the real `bundled.yaml` is imported into it, and the
 * Digital Catalog configuration is written **one section at a time through `PUT /config/:section`
 * as an operator would**. Then `GET /scenarios` is asked for the matrix, and it is compared
 * against `runner-core/test/golden/matrix.json` — the file produced in P0 by the coupled
 * dashboard's own untouched code.
 *
 * If those agree, the chain holds end to end: contract read at runtime, fixtures stored as rows,
 * engine that knows about neither, same 311 cases the version with five modules of literals
 * produced.
 *
 * The rest of the file is the tenancy and the guard rails around that: an environment that
 * refuses writes, one that does not enforce authorization, a section that fails validation with
 * a field path, and a credential that never comes back out.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";
import sections from "../fixtures/digital-catalog-sections.json";

const SPEC_PATH = "/Users/smalbach/Documents/GiProjectos/geronimo-martings/digital-catalog-back-end/docs/openapi/bundled.yaml";
/**
 * Walks up to the workspace root instead of counting `../` segments.
 *
 * This file is compiled to `dist-test/test/http/`, so the depth from `__dirname` differs from the
 * depth from the source — and a path that is one level short does not fail: it makes `READY`
 * false and the parity block **skips**, which reads as a pass. Anchoring on a marker that only
 * the root has removes the chance of that.
 */
function fromWorkspaceRoot(relative: string): string {
  let directory = __dirname;
  while (!existsSync(resolve(directory, "pnpm-workspace.yaml"))) {
    const parent = resolve(directory, "..");
    if (parent === directory) throw new Error("no se encontró la raíz del workspace");
    directory = parent;
  }
  return resolve(directory, relative);
}

const GOLDEN_PATH = fromWorkspaceRoot("packages/runner-core/test/golden/matrix.json");
const READY = existsSync(SPEC_PATH) && existsSync(GOLDEN_PATH);
const REASON = "falta bundled.yaml o el golden de runner-core";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { userId: string; organizationId: string; token: string };
async function signUp(email: string): Promise<Actor> {
  const password = "una-contraseña-larga";
  const registered = await api().post("/auth/register").send({ email, password, name: email.split("@")[0] });
  const session = await api().post("/auth/login").send({ email, password });
  // Asserted rather than trusted. When login fails the token is `undefined`, every later request
  // goes out as `Bearer undefined`, and the suite reports a 401 on whatever line happens to be
  // next — which describes the symptom and hides the cause.
  assert.equal(session.status, 200, `no se pudo iniciar sesión como ${email}: ${JSON.stringify(session.body)}`);
  assert.ok(session.body.accessToken, `el login de ${email} no devolvió token`);
  return { userId: registered.body.userId, organizationId: registered.body.organizationId, token: session.body.accessToken };
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

let owner: Actor;
let projectId: string;
let base: string;

before(async () => {
  context = await createTestApp();
  owner = await signUp("config-owner@example.com");
  const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Ara" });
  projectId = project.body.projectId;
  base = `/orgs/${owner.organizationId}/projects/${projectId}`;

  if (READY) {
    await api().post(`${base}/spec-versions`).set(as(owner)).send({ source: { kind: "upload", filename: "bundled.yaml", raw: readFileSync(SPEC_PATH, "utf8") } });
    // Written through the public endpoint, section by section, exactly as an operator would.
    // Seeding the repository directly would test the engine and skip the half of the chain this
    // phase actually added.
    for (const [section, data] of Object.entries(sections)) {
      const response = await api().put(`${base}/config/${section}`).set(as(owner)).send(data as object);
      assert.equal(response.status, 204, `la sección ${section} no se aceptó: ${JSON.stringify(response.body)}`);
    }
  }
});
after(async () => {
  await context?.close();
});

describe("la matriz reconstruida desde filas", { skip: READY ? false : REASON }, () => {
  const golden = READY ? JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) : null;

  test("produce el mismo número de operaciones y de casos que el dashboard acoplado", async () => {
    const response = await api().get(`${base}/scenarios`).set(as(owner));
    assert.equal(response.status, 200);
    assert.equal(response.body.totals.operations, golden.totals.operations);
    assert.equal(response.body.totals.cases, golden.totals.cases);
    assert.equal(response.body.totals.cases, 311);
  });

  test("cada operación produce exactamente los mismos casos, en el mismo orden", async () => {
    const response = await api().get(`${base}/scenarios`).set(as(owner));
    const built = new Map(response.body.operations.map((operation: { id: string; scenarios: { id: string }[] }) => [operation.id, operation.scenarios.map((scenario) => scenario.id)]));
    for (const expected of golden.operations) {
      assert.deepEqual(
        built.get(expected.id),
        expected.scenarios.map((scenario: { id: string }) => scenario.id),
        `divergencia en ${expected.method} ${expected.path}`,
      );
    }
  });

  test("las descripciones, estados y rutas resueltas también coinciden", async () => {
    // Not just the case ids: a matrix with the right names and the wrong expected status would
    // pass the check above and assert the wrong thing on every run.
    const response = await api().get(`${base}/scenarios`).set(as(owner));
    const built = new Map(response.body.operations.map((operation: { id: string; scenarios: unknown[] }) => [operation.id, operation.scenarios]));
    for (const expected of golden.operations) {
      const actual = built.get(expected.id) as { id: string; name: string; description: string; expectedStatus: number; requestPath: string; budget: unknown }[];
      for (const [index, scenario] of expected.scenarios.entries()) {
        assert.deepEqual(
          {
            id: actual[index].id,
            name: actual[index].name,
            description: actual[index].description,
            expectedStatus: actual[index].expectedStatus,
            requestPath: actual[index].requestPath,
            budget: actual[index].budget,
          },
          { id: scenario.id, name: scenario.name, description: scenario.description, expectedStatus: scenario.expectedStatus, requestPath: scenario.requestPath, budget: scenario.budget },
          `divergencia en ${expected.id}:${scenario.id}`,
        );
      }
    }
  });

  test("la cola de ejecución en modo seguro es la misma, caso por caso", async () => {
    const response = await api().get(`${base}/scenarios?order=safe`).set(as(owner));
    const queue = response.body.queue.map((item: { operationId: string; scenarioId: string }) => `${item.operationId}:${item.scenarioId}`);
    assert.deepEqual(queue, golden.queues["safe:auth"]);
  });

  test("y en modo contrato también", async () => {
    const response = await api().get(`${base}/scenarios?order=contract`).set(as(owner));
    const queue = response.body.queue.map((item: { operationId: string; scenarioId: string }) => `${item.operationId}:${item.scenarioId}`);
    assert.deepEqual(queue, golden.queues["contract:auth"]);
  });

  test("las 18 operaciones implementadas se marcan como tales", async () => {
    // `implemented` is a fact about the code, not about the contract, and it is the one piece of
    // configuration no schema could ever derive.
    const response = await api().get(`${base}/scenarios`).set(as(owner));
    const implemented = response.body.operations.filter((operation: { implemented: boolean }) => operation.implemented);
    assert.equal(implemented.length, golden.totals.implemented);
  });
});

describe("el entorno decide qué se ejecuta esta noche", { skip: READY ? false : REASON }, () => {
  let readOnly: string;

  before(async () => {
    const created = await api().post(`${base}/environments`).set(as(owner)).send({ name: "produccion", baseUrl: "https://api.example.com/" });
    readOnly = created.body.environmentId;
  });

  test("un entorno nuevo no permite escrituras ni asume autorización", async () => {
    // Both closed by default. The first run against a production base URL must not be the one
    // that discovers the flag was on.
    const response = await api().get(`${base}/environments`).set(as(owner));
    const environment = response.body.find((item: { id: string }) => item.id === readOnly);
    assert.equal(environment.writesAllowed, false);
    assert.equal(environment.authEnforced, false);
    // The trailing slash is normalised once, at write time, so nothing downstream has to guess
    // whether joining a path will produce a double slash.
    assert.equal(environment.baseUrl, "https://api.example.com");
  });

  test("sin escrituras permitidas, los casos no idempotentes quedan bloqueados con motivo", async () => {
    const response = await api().get(`${base}/scenarios?environmentId=${readOnly}`).set(as(owner));
    const writes = response.body.operations.filter((operation: { method: string }) => !["GET", "HEAD", "OPTIONS"].includes(operation.method));
    assert.ok(writes.length > 0);
    for (const operation of writes) {
      for (const scenario of operation.scenarios) {
        assert.equal(scenario.runnable, false, `${operation.id}:${scenario.id} no debería poder ejecutarse`);
        assert.ok(scenario.blockedReason);
      }
    }
  });

  test("los casos siguen listándose: bloqueado no es lo mismo que inexistente", async () => {
    // Hiding them would make the matrix look smaller than the contract, which is the one thing a
    // coverage report must never do.
    const response = await api().get(`${base}/scenarios?environmentId=${readOnly}`).set(as(owner));
    assert.equal(response.body.totals.cases, 311);
    assert.ok(response.body.totals.blocked > 0);
    assert.equal(response.body.totals.runnable + response.body.totals.blocked, 311);
  });

  test("sin autorización aplicada, los casos 401 y 403 no se ejecutan", async () => {
    // Against a backend that grants every scope to everyone they would fail for a reason that
    // has nothing to do with the endpoint, which is worse than not running them.
    const response = await api().get(`${base}/scenarios?environmentId=${readOnly}`).set(as(owner));
    const authCases = response.body.operations.flatMap((operation: { scenarios: { id: string; runnable: boolean; blockedReason?: string }[] }) =>
      operation.scenarios.filter((scenario) => scenario.id.startsWith("auth-")),
    );
    assert.ok(authCases.length > 0);
    assert.ok(authCases.every((scenario: { runnable: boolean }) => !scenario.runnable));
    assert.match(authCases[0].blockedReason, /no aplica autorización/);
  });

  test("con ambos interruptores encendidos, todo el contrato es ejecutable", async () => {
    const created = await api().post(`${base}/environments`).set(as(owner)).send({ name: "e2e", baseUrl: "http://127.0.0.1:8100", writesAllowed: true, authEnforced: true });
    const response = await api().get(`${base}/scenarios?environmentId=${created.body.environmentId}`).set(as(owner));
    assert.equal(response.body.totals.blocked, 0);
    assert.equal(response.body.totals.runnable, 311);
  });
});

describe("configuración", () => {
  test("un proyecto sin configurar no da error: genera lo que el contrato permite", async () => {
    // The defaults are almost empty on purpose. A new project produces the cases that follow
    // from the contract alone and nothing that depends on knowing the domain — it never pretends
    // to know an EAN nobody told it about.
    const fresh = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Nuevo" });
    const freshBase = `/orgs/${owner.organizationId}/projects/${fresh.body.projectId}`;
    await api().post(`${freshBase}/spec-versions`).set(as(owner)).send({
      source: { kind: "inline", raw: 'openapi: 3.1.0\ninfo: { title: T, version: "1" }\npaths:\n  /things:\n    get:\n      operationId: listThings\n      responses: { "200": {}, "401": {} }\n' },
    });

    const response = await api().get(`${freshBase}/scenarios`).set(as(owner));
    assert.equal(response.status, 200);
    const ids = response.body.operations[0].scenarios.map((scenario: { id: string }) => scenario.id);
    // The unfiltered baseline, and the 401 the contract declares. No geography, no cursor, no
    // EANs — none of that was ever a fact about HTTP.
    assert.deepEqual(ids, ["default", "auth-none"]);
  });

  test("el proyecto sin contrato responde 409 y no una matriz vacía", async () => {
    // An empty matrix reads as full coverage of nothing; a 409 says what is missing.
    const bare = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Sin contrato" });
    const response = await api().get(`/orgs/${owner.organizationId}/projects/${bare.body.projectId}/scenarios`).set(as(owner));
    assert.equal(response.status, 409);
    assert.match(response.body.type, /no-active-spec$/);
  });

  test("la vista de configuración distingue lo configurado de lo heredado", async () => {
    const response = await api().get(`${base}/config`).set(as(owner));
    assert.equal(response.status, 200);
    // Without this flag the UI cannot tell "uses the defaults" from "somebody deliberately chose
    // the same values", and the first is a prompt while the second is a decision.
    assert.equal(response.body.sections.budgets.configured, READY);
    assert.equal(response.body.sections.text.configured, READY);
  });

  test("una sección inválida es 422 y nombra el campo", async () => {
    const response = await api().put(`${base}/config/budgets`).set(as(owner)).send({ budgets: [{ id: "x", thresholdMs: -1, label: "", source: "" }] });
    assert.equal(response.status, 422);
    assert.match(response.body.type, /config-invalid$/);
    assert.ok(response.body.errors.some((error: { field: string }) => error.field.startsWith("budgets.0")));
  });

  test("una expresión regular rota se rechaza al escribirla, no a mitad de una corrida", async () => {
    const response = await api()
      .put(`${base}/config/budgets`)
      .set(as(owner))
      .send({ budgets: [{ id: "x", queryMatches: "[sin-cerrar", thresholdMs: 50, label: "l", source: "s" }] });
    assert.equal(response.status, 422);
    assert.ok(response.body.errors.some((error: { detail: string }) => /expresión regular/.test(error.detail)));
  });

  test("una sección desconocida es 422 y no se guarda en silencio", async () => {
    const response = await api().put(`${base}/config/inventada`).set(as(owner)).send({ cualquiera: true });
    assert.equal(response.status, 422);
    assert.match(response.body.type, /config-section-unknown$/);
  });

  test("un viewer lee la configuración pero no la escribe", async () => {
    const viewer = await signUp("config-viewer@example.com");
    await context.repositories.memberships.save({ organizationId: owner.organizationId, userId: viewer.userId, role: "viewer", createdAt: new Date() });
    assert.equal((await api().get(`${base}/config`).set(as(viewer))).status, 200);
    assert.equal((await api().put(`${base}/config/budgets`).set(as(viewer)).send({ budgets: [] })).status, 403);
  });
});

describe("credenciales del destino", () => {
  let environmentId: string;

  before(async () => {
    const created = await api().post(`${base}/environments`).set(as(owner)).send({ name: "credenciales", baseUrl: "https://staging.example.com" });
    environmentId = created.body.environmentId;
  });

  test("se guardan y nunca vuelven a salir, ni en claro ni cifradas", async () => {
    const stored = await api()
      .put(`${base}/environments/${environmentId}/credentials`)
      .set(as(owner))
      .send({ name: "admin", role: "primary", kind: "bearer", secret: "token-super-secreto" });
    assert.equal(stored.status, 200);

    const listed = await api().get(`${base}/environments`).set(as(owner));
    const body = JSON.stringify(listed.body);
    assert.equal(body.includes("token-super-secreto"), false, "el secreto en claro no puede salir");
    // Nor the ciphertext: publishing it turns an offline guess into a free check.
    assert.equal(body.includes("secretCiphertext"), false);
    const environment = listed.body.find((item: { id: string }) => item.id === environmentId);
    assert.equal(environment.credentials[0].role, "primary");
  });

  test("está cifrado en reposo, no guardado tal cual", async () => {
    const credential = await context.repositories.environments.findCredential(environmentId, "primary");
    assert.ok(credential);
    assert.equal(credential!.secretCiphertext.includes("token-super-secreto"), false);
    assert.match(credential!.secretCiphertext, /^v1\./);
  });

  test("un segundo guardado con el mismo rol reemplaza, no duplica", async () => {
    // The generator asks for "the insufficient one"; two rows answering to that would make which
    // token a 403 case sends depend on row order.
    await api().put(`${base}/environments/${environmentId}/credentials`).set(as(owner)).send({ name: "admin", role: "primary", kind: "bearer", secret: "otro" });
    const listed = await api().get(`${base}/environments`).set(as(owner));
    const environment = listed.body.find((item: { id: string }) => item.id === environmentId);
    assert.equal(environment.credentials.filter((credential: { role: string }) => credential.role === "primary").length, 1);
  });

  test("una API key sin nombre de cabecera se rechaza", async () => {
    // Guessing `X-API-Key` against a target that expects something else produces a 401 that
    // reads as a finding about the endpoint.
    const response = await api()
      .put(`${base}/environments/${environmentId}/credentials`)
      .set(as(owner))
      .send({ name: "key", role: "alternate", kind: "api_key", secret: "abc" });
    assert.equal(response.status, 422);
    assert.ok(response.body.errors.some((error: { field: string }) => error.field === "headerName"));
  });

  test("un editor no puede guardar credenciales de destino", async () => {
    // One of the two acts in this product that can affect a system outside it.
    const editor = await signUp("cred-editor@example.com");
    await context.repositories.memberships.save({ organizationId: owner.organizationId, userId: editor.userId, role: "editor", createdAt: new Date() });
    const response = await api()
      .put(`${base}/environments/${environmentId}/credentials`)
      .set(as(editor))
      .send({ name: "x", role: "primary", kind: "bearer", secret: "y" });
    assert.equal(response.status, 403);
    // But the same editor curates the matrix all day.
    assert.equal((await api().post(`${base}/environments`).set(as(editor)).send({ name: "otra", baseUrl: "https://x.example.com" })).status, 201);
  });

  test("borrar el entorno se lleva sus credenciales", async () => {
    const created = await api().post(`${base}/environments`).set(as(owner)).send({ name: "efimero", baseUrl: "https://e.example.com" });
    await api().put(`${base}/environments/${created.body.environmentId}/credentials`).set(as(owner)).send({ name: "t", role: "primary", kind: "bearer", secret: "s" });
    assert.equal((await api().delete(`${base}/environments/${created.body.environmentId}`).set(as(owner))).status, 204);
    // Credentials left behind would be a set of secrets nothing can reach to revoke.
    assert.equal(await context.repositories.environments.findCredential(created.body.environmentId, "primary"), null);
  });

  test("una URL base que no es http(s) se rechaza al escribirla", async () => {
    const response = await api().post(`${base}/environments`).set(as(owner)).send({ name: "mala", baseUrl: "file:///etc/passwd" });
    assert.equal(response.status, 422);
    assert.ok(response.body.errors.some((error: { field: string }) => error.field === "baseUrl"));
  });
});
