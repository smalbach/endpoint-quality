/**
 * The execution engine, against a real HTTP target.
 *
 * These are the six scenarios §6.4 of the plan lists, and each one is a way an endpoint can look
 * correct and be broken. The target is a genuine server on loopback that can be told to
 * misbehave — a stubbed `fetch` would prove only that the stub behaves.
 *
 * The one to read first is "the API answers 200 with the wrong envelope": the status assertion
 * passes and the case fails, which is the whole thesis of the product in one test.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { CommandBus } from "@nestjs/cqrs";

import { PruneRunsCommand } from "@/modules/runs/application/commands/prune-runs";
import { createTestApp, type TestContext } from "../support/test-app";
import { StubTarget, STUB_SPEC_YAML, type StubFaults } from "../support/stub-target";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { userId: string; organizationId: string; token: string };
async function signUp(email: string): Promise<Actor> {
  const password = "una-contraseña-larga";
  const registered = await api()
    .post("/auth/register")
    .send({ email, password, name: email.split("@")[0] });
  const session = await api().post("/auth/login").send({ email, password });
  // Asserted rather than trusted. When login fails the token is `undefined`, every later request
  // goes out as `Bearer undefined`, and the suite reports a 401 on whatever line happens to be
  // next — which describes the symptom and hides the cause.
  assert.equal(session.status, 200, `no se pudo iniciar sesión como ${email}: ${JSON.stringify(session.body)}`);
  assert.ok(session.body.accessToken, `el login de ${email} no devolvió token`);
  return {
    userId: registered.body.userId,
    organizationId: registered.body.organizationId,
    token: session.body.accessToken,
  };
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

let owner: Actor;
let base: string;

/** A project pointed at a freshly configured target. Each test gets its own so one run's writes
 * cannot change what the next one measures. */
async function projectAgainst(
  faults: StubFaults,
  environment: Partial<{
    writesAllowed: boolean;
    authEnforced: boolean;
    baseUrl: string;
    variables: Record<string, string>;
  }> = {},
  /** Skips the `bodies` section, to exercise a project that was only ever pointed at a contract. */
  options: { withoutBodies?: boolean } = {},
) {
  const target = new StubTarget(faults);
  await target.start();

  // Every step is asserted. A helper that quietly produces an undefined project id turns every
  // later failure into a 404 with no explanation, which is how a five-minute bug becomes an hour.
  const project = await api()
    .post(`/orgs/${owner.organizationId}/projects`)
    .set(as(owner))
    .send({ name: `p-${Math.random().toString(36).slice(2, 8)}` });
  assert.equal(project.status, 201, `no se pudo crear el proyecto: ${JSON.stringify(project.body)}`);
  const projectBase = `/orgs/${owner.organizationId}/projects/${project.body.projectId}`;
  const imported = await api()
    .post(`${projectBase}/spec-versions`)
    .set(as(owner))
    .send({ source: { kind: "inline", raw: STUB_SPEC_YAML } });
  assert.equal(imported.status, 201, `no se pudo importar el contrato: ${JSON.stringify(imported.body)}`);
  if (!options.withoutBodies) {
    await api()
      .put(`${projectBase}/config/bodies`)
      .set(as(owner))
      .send({ bodyTemplates: { createThing: { body: { name: "creado", size: 7 } } } });
  }
  await api()
    .put(`${projectBase}/config/parameters`)
    .set(as(owner))
    .send({
      parameterSamples: {},
      fallbackSamples: ["test"],
      excludeFromSoloScenarios: [],
      pathDefaults: { id: "1" },
      fallbackPathValue: "1",
      missingIdValue: "no-existe",
    });

  const created = await api()
    .post(`${projectBase}/environments`)
    .set(as(owner))
    .send({
      name: "stub",
      baseUrl: environment.baseUrl ?? target.origin,
      specUrl: `${target.origin}/openapi.json`,
      writesAllowed: environment.writesAllowed ?? true,
      authEnforced: environment.authEnforced ?? false,
      variables: environment.variables ?? {},
    });

  assert.equal(created.status, 201, `no se pudo crear el entorno: ${JSON.stringify(created.body)}`);
  return { target, projectBase, environmentId: created.body.environmentId as string };
}

/** Starts a run and waits for the worker to finish it. The wait is on the queue rather than on a
 * poll loop, so a hang here is a hang and not a flaky timeout. */
async function runAndWait(projectBase: string, body: Record<string, unknown>) {
  const started = await api().post(`${projectBase}/runs`).set(as(owner)).send(body);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await context.queue.idle();
  const run = await api().get(`${projectBase}/runs/${started.body.runId}`).set(as(owner));
  return { runId: started.body.runId as string, run: run.body };
}

type RunCaseRow = { id: string; operationId: string; scenarioId: string; status: string };

const caseOf = (run: { cases: RunCaseRow[] }, operationId: string, scenarioId: string): RunCaseRow => {
  const found = run.cases.find((item) => item.operationId === operationId && item.scenarioId === scenarioId);
  // Named rather than `!`: a case that is absent means the matrix did not generate it, and the
  // failure should say which one instead of a null dereference three lines later.
  if (!found) throw new Error(`La corrida no contiene el caso ${operationId}:${scenarioId}`);
  return found;
};

before(async () => {
  context = await createTestApp();
  owner = await signUp("runs-owner@example.com");
  base = `/orgs/${owner.organizationId}`;
});

describe("flujos reutilizables y variables de entorno", () => {
  /** Two saved requests and the flow that chains them: create, capture the id, read it back. */
  async function flowAgainst(variables: Record<string, string> = {}) {
    const fixture = await projectAgainst({}, { variables });
    const create = await api()
      .post(`${fixture.projectBase}/request-templates`)
      .set(as(owner))
      .send({
        name: "Crear",
        operationId: "createThing",
        expectedStatus: 201,
        body: { name: "{{entityName}}", size: 7 },
      });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    const read = await api()
      .post(`${fixture.projectBase}/request-templates`)
      .set(as(owner))
      .send({ name: "Consultar", operationId: "getThing", expectedStatus: 200, parameters: { id: "{{thingId}}" } });
    assert.equal(read.status, 201, JSON.stringify(read.body));

    const workflow = await api()
      .post(`${fixture.projectBase}/workflows`)
      .set(as(owner))
      .send({
        name: "Crear y consultar",
        definition: {
          steps: [
            {
              id: "crear",
              requestTemplateId: create.body.requestTemplateId,
              captures: [{ variable: "thingId", from: "body", path: "data.id" }],
              position: { x: 40, y: 60 },
            },
            { id: "consultar", requestTemplateId: read.body.requestTemplateId, dependsOn: ["crear"] },
          ],
        },
      });
    assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
    return {
      ...fixture,
      createTemplateId: create.body.requestTemplateId as string,
      readTemplateId: read.body.requestTemplateId as string,
      workflowId: workflow.body.workflowId as string,
    };
  }

  test("captura una respuesta y la interpola en el endpoint siguiente", async () => {
    const flow = await flowAgainst({ entityName: "desde-el-entorno" });
    const { run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
    });
    assert.equal(run.status, "passed", JSON.stringify(run.totals));
    assert.equal(run.cases.length, 2);

    const first = await api().get(`${flow.projectBase}/runs/${run.id}/cases/${run.cases[0].id}`).set(as(owner));
    const second = await api().get(`${flow.projectBase}/runs/${run.id}/cases/${run.cases[1].id}`).set(as(owner));
    // The environment's own variable reached the payload, and the value the first response gave
    // reached the second request's URL. Those are the two halves of the feature.
    assert.deepEqual(first.body.steps[0].request.body, { name: "desde-el-entorno", size: 7 });
    assert.match(first.body.steps[0].assertions.at(-1).detail, /thingId/);
    assert.match(second.body.steps[0].request.url, /\/things\/100$/);
    await flow.target.stop();
  });

  test("una captura no se escapa de su corrida", async () => {
    // The variables are copied per run. Without that, a flow run twice would find the previous
    // run's id already there and pass without ever capturing anything.
    const flow = await flowAgainst({ entityName: "repetible" });
    const first = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
    });
    const second = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
    });
    assert.equal(first.run.status, "passed");
    assert.equal(second.run.status, "passed");

    // The captured `thingId` is nowhere near the stored environment: it lived in the copy the run
    // was given, which is what stops two concurrent runs of the same flow from reading each
    // other's ids.
    const environments = await api().get(`${flow.projectBase}/environments`).set(as(owner));
    assert.deepEqual(environments.body[0].variables, {
      entityName: { initial: "repetible", current: "repetible", sensitive: false },
    });
    await flow.target.stop();
  });

  test("el descendiente de un paso que falla no se ejecuta", async () => {
    const flow = await flowAgainst();
    // Nothing supplies `entityName`, so the create sends `{{entityName}}` — which the engine
    // refuses to send at all, blocking the step. The read depends on it and must not be attempted.
    const withoutId = await api()
      .put(`${flow.projectBase}/workflows/${flow.workflowId}`)
      .set(as(owner))
      .send({
        definition: {
          steps: [
            { id: "crear", requestTemplateId: flow.createTemplateId, captures: [] },
            { id: "consultar", requestTemplateId: flow.readTemplateId, dependsOn: ["crear"] },
          ],
        },
      });
    assert.equal(withoutId.status, 204, JSON.stringify(withoutId.body));

    const { run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
    });
    assert.equal(run.cases[1].status, "skipped");
    await flow.target.stop();
  });

  test("las posiciones del lienzo sobreviven a la ida y vuelta", async () => {
    const flow = await flowAgainst();
    const listed = await api().get(`${flow.projectBase}/workflows`).set(as(owner));
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.workflows[0].steps[0].position, { x: 40, y: 60 });
    await flow.target.stop();
  });

  test("un flujo con un paso que nombra una prueba inexistente es 422", async () => {
    const fixture = await projectAgainst({});
    const response = await api()
      .post(`${fixture.projectBase}/workflows`)
      .set(as(owner))
      .send({
        name: "Roto",
        definition: { steps: [{ id: "a", requestTemplateId: "00000000-0000-4000-8000-000000000000" }] },
      });
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.equal(response.body.errors[0].field, "definition.steps.0.requestTemplateId");
    await fixture.target.stop();
  });

  test("un flujo cíclico se rechaza al guardarlo, no al ejecutarlo", async () => {
    const flow = await flowAgainst();
    const response = await api()
      .put(`${flow.projectBase}/workflows/${flow.workflowId}`)
      .set(as(owner))
      .send({
        definition: {
          steps: [
            { id: "a", requestTemplateId: flow.createTemplateId, dependsOn: ["b"] },
            { id: "b", requestTemplateId: flow.readTemplateId, dependsOn: ["a"] },
          ],
        },
      });
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.ok(response.body.errors.some((issue: { detail: string }) => issue.detail.includes("cíclicas")));
    await flow.target.stop();
  });

  test("borrar una prueba que algún flujo usa es 409", async () => {
    const flow = await flowAgainst();
    // No foreign key can say this — the reference lives inside a jsonb document — so the refusal
    // is the command's, and it is the difference between a 409 now and a red case tonight.
    const refused = await api().delete(`${flow.projectBase}/request-templates/${flow.createTemplateId}`).set(as(owner));
    assert.equal(refused.status, 409, JSON.stringify(refused.body));

    await api().delete(`${flow.projectBase}/workflows/${flow.workflowId}`).set(as(owner));
    const allowed = await api().delete(`${flow.projectBase}/request-templates/${flow.createTemplateId}`).set(as(owner));
    assert.equal(allowed.status, 204);
    await flow.target.stop();
  });

  test("lanzar una corrida con un flujo de otro proyecto es 422, no una corrida en error", async () => {
    const mine = await flowAgainst();
    const other = await projectAgainst({});
    const response = await api()
      .post(`${other.projectBase}/runs`)
      .set(as(owner))
      .send({ environmentId: other.environmentId, workflowId: mine.workflowId });
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.equal(response.body.errors[0].field, "workflowId");
    await mine.target.stop();
    await other.target.stop();
  });

  test("dos pruebas del mismo proyecto no pueden llamarse igual", async () => {
    const fixture = await projectAgainst({});
    const body = { name: "Crear", operationId: "createThing", expectedStatus: 201 };
    assert.equal((await api().post(`${fixture.projectBase}/request-templates`).set(as(owner)).send(body)).status, 201);
    const repeated = await api().post(`${fixture.projectBase}/request-templates`).set(as(owner)).send(body);
    assert.equal(repeated.status, 409, JSON.stringify(repeated.body));
    await fixture.target.stop();
  });
});

after(async () => {
  await context?.close();
});

describe("una corrida completa contra un destino correcto", () => {
  let fixture: Awaited<ReturnType<typeof projectAgainst>>;
  before(async () => {
    fixture = await projectAgainst({});
  });
  after(async () => {
    await fixture.target.stop();
  });

  test("responde 202 con un id y ejecuta en segundo plano", async () => {
    // The request returns before anything has been requested of the target. That is what makes
    // closing the browser harmless, and it is the difference from a loop in a React component.
    const started = await api()
      .post(`${fixture.projectBase}/runs`)
      .set(as(owner))
      .send({ environmentId: fixture.environmentId });
    assert.equal(started.status, 202);
    assert.ok(started.body.runId);
    await context.queue.idle();
    const run = await api().get(`${fixture.projectBase}/runs/${started.body.runId}`).set(as(owner));
    assert.equal(run.body.status, "passed", JSON.stringify(run.body.totals));
  });

  test("todos los casos pasan y los totales cuadran", async () => {
    const { run } = await runAndWait(fixture.projectBase, { environmentId: fixture.environmentId });
    assert.equal(run.totals.failed, 0);
    assert.equal(run.totals.completed, run.totals.cases);
    assert.equal(run.totals.passed + run.totals.skipped, run.totals.cases);
  });

  test("el flujo create-read deja la base como estaba", async () => {
    // Without the cleanup the second run of this case is a conflict over the natural key, which
    // reports the previous run rather than the endpoint.
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["createThing"],
    });
    const runCase = caseOf(run, "createThing", "create-read");
    const detail = await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner));
    assert.deepEqual(
      detail.body.steps.map((step: { purpose: string; method?: string }) => step.purpose),
      ["act", "verify", "cleanup"],
    );
    assert.equal(
      detail.body.steps.every((step: { ok: boolean }) => step.ok),
      true,
    );
  });

  test("las credenciales no aparecen en lo que se guarda", async () => {
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["listThings"],
    });
    const runCase = caseOf(run, "listThings", "default");
    const detail = await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner));
    // Masked before the row is written. A redaction at read time is one query away from being
    // forgotten, and the value is a live credential for somebody's environment.
    assert.equal(JSON.stringify(detail.body).includes("Bearer "), false);
  });

  test("el informe trae todos los casos con sus aserciones en una sola petición", async () => {
    // The per-case view is the evidence view and carries whole response bodies; reading a whole
    // run through it is one request per case, which against the 120-per-minute limit turns a
    // 311-case matrix into three minutes of pacing. The report is what a CI job reads.
    const { run } = await runAndWait(fixture.projectBase, { environmentId: fixture.environmentId });
    const report = await api().get(`${fixture.projectBase}/runs/${run.id}/report`).set(as(owner));
    assert.equal(report.status, 200);
    assert.equal(report.body.cases.length, run.totals.cases);
    assert.equal(report.body.run.id, run.id);
    // Every executed case brings its assertions along, which is the point: a report whose cases
    // are empty is a list of green ticks again.
    const executed = report.body.cases.filter((runCase: { status: string }) => runCase.status !== "skipped");
    assert.ok(executed.length > 0);
    assert.equal(
      executed.every(
        (runCase: { steps: { assertions: unknown[] }[] }) =>
          runCase.steps.length > 0 && runCase.steps.every((step) => step.assertions.length > 0),
      ),
      true,
    );
  });

  test("el informe no lleva ningún cuerpo de respuesta", async () => {
    // That is the whole reason it can be one request. If `actual` ever creeps back in, a 311-case
    // run goes from a few hundred kilobytes to tens of megabytes and this stops being usable.
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["listThings"],
    });
    const report = await api().get(`${fixture.projectBase}/runs/${run.id}/report`).set(as(owner));
    const step = report.body.cases[0].steps[0];
    for (const field of ["request", "expected", "actual"])
      assert.equal(field in step, false, `el informe no debe llevar ${field}`);
    assert.deepEqual(Object.keys(step).sort(), ["assertions", "durationMs", "index", "label", "ok", "purpose"]);
  });

  test("una corrida queda en el historial del proyecto", async () => {
    // The capability the coupled dashboard did not have: there the result lived in useState and
    // died on refresh.
    const history = await api().get(`${fixture.projectBase}/runs`).set(as(owner));
    assert.ok(history.body.length >= 1);
    assert.ok(history.body[0].finishedAt);
  });
});

/**
 * The case for "point it at a project" rather than "configure a project".
 *
 * A contract that declares a `requestBody` has already said what the operation accepts. Before
 * this, the engine ignored that and sent nothing unless somebody wrote a `bodies` section, so a
 * project on its first day came back with every POST, PUT and PATCH red on a 422 — which reads as
 * a finding about the API and was a gap in this tool.
 */
describe("un proyecto sin configurar todavía puede escribir", () => {
  test("el cuerpo sale del contrato cuando el proyecto no lo define", async () => {
    const fixture = await projectAgainst({}, {}, { withoutBodies: true });
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["createThing"],
    });

    const runCase = caseOf(run, "createThing", "create-read");
    assert.equal(runCase.status, "passed", "sin sección bodies el POST debería seguir siendo verde");

    const detail = await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner));
    const sent = detail.body.steps[0].request.body as Record<string, unknown>;
    // Los obligatorios, con el mínimo declarado respetado…
    assert.deepEqual(sent, { name: "ejemplo", size: 2 });
    // …y **sin** `id`, que es readOnly: mandarlo es lo que un API estricto responde con 422, o
    // sea que seríamos nosotros provocando el fallo que luego reportamos.
    assert.equal("id" in sent, false);
    await fixture.target.stop();
  });

  test("y la configuración sigue mandando cuando existe", async () => {
    // A schema says what is structurally valid; a project knows what is acceptable. The derived
    // body fills a silence, it does not overrule anybody.
    const fixture = await projectAgainst({});
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["createThing"],
    });
    const runCase = caseOf(run, "createThing", "create-read");
    const detail = await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner));
    assert.deepEqual(detail.body.steps[0].request.body, { name: "creado", size: 7 });
    await fixture.target.stop();
  });

  test("el caso invalid-body sigue mandando un objeto vacío", async () => {
    // Si el cuerpo derivado se colara aquí, el caso que comprueba el 422 mandaría un payload
    // válido y esperaría que lo rechazaran.
    const fixture = await projectAgainst({}, {}, { withoutBodies: true });
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["createThing"],
    });
    const runCase = caseOf(run, "createThing", "invalid-body");
    assert.equal(runCase.status, "passed");
    const detail = await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner));
    assert.deepEqual(detail.body.steps[0].request.body, {});
    await fixture.target.stop();
  });
});

describe("un 200 no es un test que pasa", () => {
  test("envelope roto: el status pasa y el caso falla", async () => {
    // The thesis of the whole product. The API answers 200 with `{ items: [] }` where the
    // contract declares `{ data: [...] }`, and only the schema assertion sees it.
    const fixture = await projectAgainst({ brokenEnvelope: true });
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["listThings"],
    });

    const runCase = caseOf(run, "listThings", "default");
    assert.equal(runCase.status, "failed");

    const detail = await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner));
    const assertions = detail.body.steps[0].assertions as { label: string; pass: boolean; detail: string }[];
    assert.equal(assertions.find((assertion) => assertion.label.startsWith("Status"))!.pass, true);
    assert.equal(assertions.find((assertion) => assertion.label === "Schema OpenAPI")!.pass, false);
    assert.match(assertions.find((assertion) => assertion.label === "Schema OpenAPI")!.detail, /campo requerido/);
    await fixture.target.stop();
  });

  test("campos que no persisten: el POST responde 201 y el caso falla en la relectura", async () => {
    const fixture = await projectAgainst({ dropsFields: true });
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["createThing"],
    });

    const runCase = caseOf(run, "createThing", "create-read");
    assert.equal(runCase.status, "failed");

    const detail = await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner));
    // The create step itself is fine — that is the point.
    assert.equal(detail.body.steps[0].ok, true);
    const persistence = (detail.body.steps[1].assertions as { label: string; pass: boolean; detail: string }[]).find(
      (assertion) => assertion.label === "Persistencia de campos",
    );
    assert.equal(persistence!.pass, false);
    assert.match(persistence!.detail, /name|size/);
    await fixture.target.stop();
  });

  test("borrado blando: el DELETE responde 204 y el recurso sigue ahí", async () => {
    const fixture = await projectAgainst({ softDelete: true });
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["deleteThing"],
    });

    // **Both.** This assertion used to say `delete-read` passed, on the grounds that the API did
    // answer 204 — which made the name of the case a promise it did not keep and left it checking
    // exactly the thing a soft delete gets right. A `204` says the request was accepted; only a
    // read afterwards says the row is gone, and that is what `delete-read` is for.
    assert.equal(caseOf(run, "deleteThing", "delete-read").status, "failed");
    assert.equal(caseOf(run, "deleteThing", "deleted-read").status, "failed");

    // And the failure is in the read-back, not in the DELETE: pointing at the wrong step would
    // send somebody to fix an endpoint that is answering correctly.
    const detail = await api()
      .get(`${fixture.projectBase}/runs/${run.id}/cases/${caseOf(run, "deleteThing", "delete-read").id}`)
      .set(as(owner));
    const steps = detail.body.steps as { purpose: string; request: { method: string }; ok: boolean }[];
    assert.deepEqual(
      steps.map((step) => `${step.purpose}:${step.request.method}:${step.ok}`),
      ["prepare:POST:true", "act:DELETE:true", "verify:GET:false"],
    );
    await fixture.target.stop();
  });

  test("un destino lento incumple el presupuesto y solo el presupuesto", async () => {
    const fixture = await projectAgainst({ slowMs: 120 });
    await api()
      .put(`${fixture.projectBase}/config/budgets`)
      .set(as(owner))
      .send({
        budgets: [{ id: "get", methods: ["GET"], thresholdMs: 50, label: "GET p95 < 50 ms", source: "prueba" }],
      });
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["listThings"],
    });

    const runCase = caseOf(run, "listThings", "default");
    assert.equal(runCase.status, "failed");
    const detail = await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner));
    const assertions = detail.body.steps[0].assertions as { label: string; pass: boolean }[];
    assert.equal(assertions.find((assertion) => assertion.label === "Schema OpenAPI")!.pass, true);
    assert.equal(assertions.at(-1)!.label, "GET p95 < 50 ms");
    assert.equal(assertions.at(-1)!.pass, false);
    await fixture.target.stop();
  });

  test("un 405 es su propio diagnóstico y silencia el resto", async () => {
    const fixture = await projectAgainst({ notImplemented: true });
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["createThing"],
    });

    const runCase = caseOf(run, "createThing", "create-read");
    const detail = await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner));
    const assertions = detail.body.steps[0].assertions as { label: string; pass: boolean; detail: string }[];
    assert.match(assertions[0].detail, /no está implementado/);
    // Nothing downstream says anything useful about a response the API never produced.
    assert.match(assertions.find((assertion) => assertion.label === "Schema OpenAPI")!.detail, /No evaluado/);
    // The flow stops there: chasing a read-back for a create that never happened is a second red
    // line that says nothing new.
    assert.equal(detail.body.steps.length, 1);
    await fixture.target.stop();
  });

  test("errores sin Problem Details se detectan", async () => {
    const fixture = await projectAgainst({ plainErrors: true });
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["getThing"],
    });
    // `{ "error": "..." }` is the shape the error-envelope assertion exists to reject.
    assert.equal(caseOf(run, "getThing", "not-found").status, "failed");
    // The 200 of the same endpoint is unaffected, so the failure names the right case.
    assert.equal(caseOf(run, "getThing", "found").status, "passed");
    await fixture.target.stop();
  });
});

describe("guardas del entorno", () => {
  test("sin escrituras permitidas nada sale a la red y el caso queda saltado", async () => {
    const fixture = await projectAgainst({}, { writesAllowed: false });
    const before = fixture.target.requests.length;
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["createThing", "deleteThing"],
    });

    for (const runCase of run.cases) assert.notEqual(runCase.status, "passed");
    // Refused before anything leaves the process: the check is in the engine, not in the UI,
    // because CI never sees the UI.
    const writes = fixture.target.requests.slice(before).filter((entry) => entry.method !== "GET");
    assert.deepEqual(writes, []);
    await fixture.target.stop();
  });

  test("una corrida con casos saltados y ningún fallo pasa", async () => {
    // A case the environment refused is not a finding about the API, and reporting it as one
    // would train people to ignore red.
    const fixture = await projectAgainst({}, { writesAllowed: false });
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["listThings"],
    });
    assert.equal(run.status, "passed");
    await fixture.target.stop();
  });

  test("con autorización aplicada, la matriz 401/403 se ejecuta de verdad", async () => {
    const fixture = await projectAgainst({ enforcesAuth: true }, { authEnforced: true });
    await api().put(`${fixture.projectBase}/environments/${fixture.environmentId}/credentials`).set(as(owner)).send({
      name: "admin",
      role: "primary",
      kind: "bearer",
      secret: "token-completo",
    });
    await api().put(`${fixture.projectBase}/environments/${fixture.environmentId}/credentials`).set(as(owner)).send({
      name: "lectura",
      role: "insufficient",
      kind: "bearer",
      secret: "solo-lectura",
    });

    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["listThings", "createThing"],
    });
    // `auth-none` sends nothing and expects 401; the insufficient token authenticates and does
    // not reach the write, which is the 403. Neither is testable with one credential.
    assert.equal(caseOf(run, "listThings", "auth-none").status, "passed");
    assert.equal(caseOf(run, "createThing", "auth-none").status, "passed");
    await fixture.target.stop();
  });

  test("una URL base inalcanzable falla como conexión, no como schema", async () => {
    const fixture = await projectAgainst({}, { baseUrl: "http://127.0.0.1:1" });
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["listThings"],
    });
    const runCase = caseOf(run, "listThings", "default");
    assert.equal(runCase.status, "failed");
    const detail = await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner));
    assert.equal(detail.body.steps[0].assertions[0].label, "Conexión con la API");
    await fixture.target.stop();
  });
});

describe("permisos y aislamiento", () => {
  let fixture: Awaited<ReturnType<typeof projectAgainst>>;
  before(async () => {
    fixture = await projectAgainst({});
  });
  after(async () => {
    await fixture.target.stop();
  });

  test("un viewer ve las corridas pero no las lanza", async () => {
    const viewer = await signUp("runs-viewer@example.com");
    await context.repositories.memberships.save({
      organizationId: owner.organizationId,
      userId: viewer.userId,
      role: "viewer",
      createdAt: new Date(),
    });
    assert.equal((await api().get(`${fixture.projectBase}/runs`).set(as(viewer))).status, 200);
    assert.equal(
      (await api().post(`${fixture.projectBase}/runs`).set(as(viewer)).send({ environmentId: fixture.environmentId }))
        .status,
      403,
    );
  });

  test("un viewer lee las pruebas y los flujos pero no los escribe", async () => {
    const viewer = await signUp("workflows-viewer@example.com");
    await context.repositories.memberships.save({
      organizationId: owner.organizationId,
      userId: viewer.userId,
      role: "viewer",
      createdAt: new Date(),
    });
    assert.equal((await api().get(`${fixture.projectBase}/workflows`).set(as(viewer))).status, 200);
    assert.equal(
      (
        await api()
          .post(`${fixture.projectBase}/request-templates`)
          .set(as(viewer))
          .send({ name: "Crear", operationId: "createThing", expectedStatus: 201 })
      ).status,
      403,
    );
    assert.equal(
      (await api().post(`${fixture.projectBase}/workflows`).set(as(viewer)).send({ name: "Flujo" })).status,
      403,
    );
  });

  test("un token de CI sí puede lanzar una corrida", async () => {
    // That is the point of a service credential: a pipeline keeps the matrix running without a
    // person logging in.
    const created = await api().post(`${base}/tokens`).set(as(owner)).send({ name: "CI" });
    const started = await api()
      .post(`${fixture.projectBase}/runs`)
      .set({ Authorization: `Bearer ${created.body.token}` })
      .send({ environmentId: fixture.environmentId });
    assert.equal(started.status, 202);
    await context.queue.idle();
  });

  test("un entorno de otro proyecto es 404", async () => {
    const other = await projectAgainst({});
    const response = await api()
      .post(`${fixture.projectBase}/runs`)
      .set(as(owner))
      .send({ environmentId: other.environmentId });
    assert.equal(response.status, 404);
    await other.target.stop();
  });

  test("un proyecto sin contrato no puede lanzar corridas", async () => {
    // 409 and not 404: the project exists and the caller may see it — what is missing is the
    // contract, and saying so is more useful than pretending the project is not there.
    const bare = await api().post(`${base}/projects`).set(as(owner)).send({ name: "sin contrato" });
    const response = await api()
      .post(`${base}/projects/${bare.body.projectId}/runs`)
      .set(as(owner))
      .send({ environmentId: fixture.environmentId });
    assert.equal(response.status, 409);
    assert.match(response.body.type, /no-active-spec$/);
  });
});

/**
 * Retention: what a run is still worth once its bodies are gone.
 *
 * `run_steps` is the one table here with no ceiling — a nightly 311-case matrix writes hundreds of
 * rows a day, each holding a whole response body. The policy keeps the verdict and drops the
 * payload, so a run from March still answers «was this green, and what failed» for a few hundred
 * bytes instead of a few hundred kilobytes.
 */
describe("retención de corridas", () => {
  let fixture: Awaited<ReturnType<typeof projectAgainst>>;
  before(async () => {
    fixture = await projectAgainst({});
  });
  after(async () => {
    await fixture.target.stop();
  });

  /** Backdates a finished run so the sweep reaches it. Measured against the suite's fixed clock,
   * which is what the handler reads: `new Date()` here would put the run in a different year to
   * the policy comparing against it. */
  const age = async (runId: string, days: number) => {
    const run = await context.repositories.runs.findById(runId);
    if (!run) throw new Error(`No existe la corrida ${runId}`);
    await context.repositories.runs.save({
      ...run,
      finishedAt: new Date(context.clock.now().getTime() - days * 24 * 60 * 60 * 1000),
    });
  };
  const prune = (bodiesDays?: number, runsDays?: number) =>
    context.app.get(CommandBus).execute(new PruneRunsCommand(bodiesDays, runsDays));

  test("los cuerpos se retiran y el veredicto se queda", async () => {
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["createThing"],
    });
    const runCase = caseOf(run, "createThing", "create-read");
    const before = (await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner))).body;
    assert.ok(before.steps[0].request, "el caso recién corrido sí trae la petición");

    await age(run.id, 40);
    const report = await prune(30, 0);
    assert.ok(report.bodiesPruned > 0);
    assert.equal(report.runsDeleted, 0, "la política de borrado estaba en 0, que es «nunca»");

    const after = (await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner))).body;
    for (const step of after.steps) {
      assert.equal(step.request, null);
      assert.equal(step.expected, null);
      assert.equal(step.actual, null);
      assert.ok(step.prunedAt, "sin esta marca, un paso viejo se lee como un timeout");
      // Lo que hace que la fila siga valiendo algo.
      assert.ok(step.assertions.length > 0);
      assert.equal(typeof step.ok, "boolean");
      assert.equal(typeof step.durationMs, "number");
    }
    // Y el informe, que es lo que lee una pipeline, no dependía de los cuerpos.
    const stillReadable = await api().get(`${fixture.projectBase}/runs/${run.id}/report`).set(as(owner));
    assert.equal(stillReadable.status, 200);
    assert.ok(stillReadable.body.cases.length > 0);
  });

  test("una segunda pasada no vuelve a hacer el trabajo de la primera", async () => {
    // `prunedAt IS NULL` es lo que hace converger el barrido. Sin eso, una pasada nocturna
    // reescribiría cada noche todo lo que ya vació, y el número que reporta no diría nada.
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["createThing"],
    });
    await age(run.id, 40);
    assert.ok((await prune(30, 0)).bodiesPruned > 0);
    assert.equal((await prune(30, 0)).bodiesPruned, 0);
  });

  test("una corrida reciente no se toca", async () => {
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["createThing"],
    });
    const runCase = caseOf(run, "createThing", "create-read");
    await prune(30, 365);
    const detail = (await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner))).body;
    assert.ok(detail.steps[0].request, "una corrida de hace un segundo tiene sus cuerpos");
  });

  test("`0` es «nunca», y es una decisión que alguien toma a propósito", async () => {
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["createThing"],
    });
    const runCase = caseOf(run, "createThing", "create-read");
    await age(run.id, 4000);
    const report = await prune(0, 0);
    assert.deepEqual(report, { bodiesPruned: 0, runsDeleted: 0 });
    assert.ok(
      (await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner))).body.steps[0]
        .request,
    );
  });

  test("pasado el plazo largo, la corrida entera se va con sus casos y sus pasos", async () => {
    const { run } = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      operationIds: ["createThing"],
    });
    const runCase = caseOf(run, "createThing", "create-read");
    await age(run.id, 400);
    assert.equal((await prune(0, 365)).runsDeleted >= 1, true);

    assert.equal((await api().get(`${fixture.projectBase}/runs/${run.id}`).set(as(owner))).status, 404);
    // Los pasos se van con ella: filas que nadie puede ya alcanzar para leer ni para borrar.
    assert.deepEqual(await context.repositories.runs.listSteps(runCase.id), []);
    assert.equal(await context.repositories.runs.findCase(runCase.id), null);
  });
});
