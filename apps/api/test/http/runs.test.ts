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
      .send({
        bodyTemplates: {
          createThing: { body: { name: "creado", size: 7 } },
          createSession: { body: { email: "quien@ejemplo.com", password: "una-contraseña" } },
        },
      });
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

/**
 * Lo que un paso afirma por su cuenta, y qué hace su fallo con el resto del flujo.
 *
 * La matriz generada comprueba lo que se le puede exigir a un contrato. Estas son la otra clase de
 * afirmación —«esta lista no está vacía», «responde en menos de 300 ms»— que ningún documento
 * OpenAPI expresa, más las dos decisiones que las acompañan: repetir un paso que falló, y decidir
 * si su fallo detiene lo que venía detrás.
 */
describe("comprobaciones, reintentos y política de error de un paso", () => {
  /** Un proyecto con dos peticiones guardadas y un flujo cuyos pasos los define cada prueba. */
  async function flowWith(
    steps: (templates: { create: string; list: string }) => Record<string, unknown>[],
    faults: StubFaults = {},
  ) {
    const fixture = await projectAgainst(faults);
    const create = await api()
      .post(`${fixture.projectBase}/request-templates`)
      .set(as(owner))
      .send({ name: "Crear", operationId: "createThing", expectedStatus: 201, body: { name: "x", size: 7 } });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    const list = await api()
      .post(`${fixture.projectBase}/request-templates`)
      .set(as(owner))
      .send({ name: "Listar", operationId: "listThings", expectedStatus: 200 });
    assert.equal(list.status, 201, JSON.stringify(list.body));

    const workflow = await api()
      .post(`${fixture.projectBase}/workflows`)
      .set(as(owner))
      .send({
        name: "Con comprobaciones",
        definition: { steps: steps({ create: create.body.requestTemplateId, list: list.body.requestTemplateId }) },
      });
    assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
    return { ...fixture, workflowId: workflow.body.workflowId as string };
  }

  const assertionsOf = async (projectBase: string, runId: string, caseId: string) => {
    const detail = await api().get(`${projectBase}/runs/${runId}/cases/${caseId}`).set(as(owner));
    return (
      detail.body.steps as { assertions: { label: string; pass: boolean; detail: string; severity?: string }[] }[]
    ).flatMap((step) => step.assertions);
  };

  test("una comprobación que pasa deja constancia, igual que una que falla", async () => {
    const flow = await flowWith(({ list }) => [
      {
        id: "listar",
        requestTemplateId: list,
        checks: [
          { source: "body", path: "data", operator: "is_array" },
          { label: "hay diez cosas", source: "body", path: "data", operator: "has_length", value: 10 },
        ],
      },
    ]);
    const { runId, run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
    });
    const assertions = await assertionsOf(flow.projectBase, runId, run.cases[0].id);
    // La que pasa también está: una comprobación que desaparece cuando acierta es una
    // comprobación que nadie puede decir que se ejecutó.
    assert.equal(assertions.find((entry) => entry.label === "body.data es una lista")?.pass, true);
    assert.equal(assertions.find((entry) => entry.label === "hay diez cosas")?.pass, false);
    assert.equal(run.cases[0].status, "failed");
    await flow.target.stop();
  });

  test("un aviso queda escrito y no pone el caso en rojo", async () => {
    const flow = await flowWith(({ list }) => [
      {
        id: "listar",
        requestTemplateId: list,
        checks: [
          {
            label: "cien cosas",
            source: "body",
            path: "data",
            operator: "has_length",
            value: 100,
            severity: "warning",
          },
        ],
      },
    ]);
    const { runId, run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
    });
    assert.equal(run.cases[0].status, "passed");
    const assertions = await assertionsOf(flow.projectBase, runId, run.cases[0].id);
    const warning = assertions.find((entry) => entry.label === "cien cosas");
    assert.equal(warning?.pass, false);
    assert.equal(warning?.severity, "warning");
    await flow.target.stop();
  });

  test("un destino que arranca frío se reintenta, y el informe dice que hizo falta", async () => {
    const flow = await flowWith(
      ({ create }) => [{ id: "crear", requestTemplateId: create, retry: { attempts: 2, delayMs: 0, onStatus: [503] } }],
      { flakyWrites: 2 },
    );
    const { runId, run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
    });
    assert.equal(run.cases[0].status, "passed");
    const assertions = await assertionsOf(flow.projectBase, runId, run.cases[0].id);
    // Que el endpoint funcione y que hicieran falta tres intentos son dos hechos distintos sobre
    // el destino. El segundo desaparecería dentro de un tic verde.
    const retried = assertions.find((entry) => entry.label === "Reintentado");
    assert.equal(retried?.severity, "warning");
    assert.match(retried?.detail ?? "", /intento 3 de 3/);
    await flow.target.stop();
  });

  test("onStatus impide reintentar lo que nunca va a cambiar", async () => {
    // El fallo es una comprobación, no un 503: con `onStatus` acotado a 503 no se repite, que es
    // justo lo que evita que una suite reintente un 422 tres veces y tarde el triple.
    const flow = await flowWith(({ list }) => [
      {
        id: "listar",
        requestTemplateId: list,
        checks: [{ label: "imposible", source: "body", path: "data", operator: "has_length", value: 99 }],
        retry: { attempts: 3, delayMs: 0, onStatus: [503] },
      },
    ]);
    const { runId, run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
    });
    assert.equal(run.cases[0].status, "failed");
    const assertions = await assertionsOf(flow.projectBase, runId, run.cases[0].id);
    assert.equal(
      assertions.filter((entry) => entry.label === "imposible").length,
      1,
      "se evaluó una sola vez: no se reintentó",
    );
    await flow.target.stop();
  });

  test("con «continuar», lo que dependía de un paso fallido se ejecuta igual", async () => {
    const flow = await flowWith(({ create, list }) => [
      {
        id: "crear",
        requestTemplateId: create,
        onError: "continue",
        checks: [{ label: "imposible", source: "status", operator: "equals", value: 999 }],
      },
      { id: "listar", requestTemplateId: list, dependsOn: ["crear"] },
    ]);
    const { run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
    });
    assert.equal(run.cases[0].status, "failed");
    // Sin `continue` esto sería «saltado»: «crear falló, luego listar falló» es un hallazgo
    // contado dos veces. Con él, el autor dice que el resto no dependía de verdad.
    assert.equal(run.cases[1].status, "passed");
    await flow.target.stop();
  });

  test("con «detener», lo que venía detrás queda saltado y no encolado", async () => {
    const flow = await flowWith(({ create, list }) => [
      {
        id: "crear",
        requestTemplateId: create,
        onError: "stop",
        checks: [{ label: "imposible", source: "status", operator: "equals", value: 999 }],
      },
      { id: "listar", requestTemplateId: list },
    ]);
    const { run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
    });
    assert.equal(run.cases[0].status, "failed");
    // Saltado y no encolado: un caso sin veredicto no es un resultado, y una corrida terminada
    // que deja filas en «queued» no cuadra con sus propios totales.
    assert.equal(run.cases[1].status, "skipped");
    await flow.target.stop();
  });

  test("cada caso rojo dice de quién es el fallo", async () => {
    const flow = await flowWith(({ list }) => [
      {
        id: "listar",
        requestTemplateId: list,
        checks: [{ label: "imposible", source: "body", path: "data", operator: "has_length", value: 99 }],
      },
    ]);
    const { run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
    });
    // La comprobación la escribió quien montó el flujo, y la respuesta estaba bien: el fallo es
    // suyo y no del destino.
    assert.equal(run.cases[0].failure, "check");
    await flow.target.stop();
  });

  test("un 405 es un desacuerdo sobre el estado, y una variable que falta ni sale de casa", async () => {
    const notImplemented = await flowWith(({ create }) => [{ id: "crear", requestTemplateId: create }], {
      notImplemented: true,
    });
    const first = await runAndWait(notImplemented.projectBase, {
      environmentId: notImplemented.environmentId,
      workflowId: notImplemented.workflowId,
    });
    assert.equal(first.run.cases[0].failure, "status");
    await notImplemented.target.stop();

    // Una variable sin resolver no es un hallazgo sobre la API: la corrida no llegó a llamarla.
    const fixture = await projectAgainst({});
    const template = await api()
      .post(`${fixture.projectBase}/request-templates`)
      .set(as(owner))
      .send({ name: "Leer", operationId: "getThing", expectedStatus: 200, parameters: { id: "{{noExiste}}" } });
    const workflow = await api()
      .post(`${fixture.projectBase}/workflows`)
      .set(as(owner))
      .send({
        name: "Sin variable",
        definition: { steps: [{ id: "leer", requestTemplateId: template.body.requestTemplateId }] },
      });
    const second = await runAndWait(fixture.projectBase, {
      environmentId: fixture.environmentId,
      workflowId: workflow.body.workflowId,
    });
    assert.equal(second.run.cases[0].failure, "config");
    await fixture.target.stop();
  });

  test("una comprobación mal escrita se rechaza al guardar el flujo, no a mitad de corrida", async () => {
    const fixture = await projectAgainst({});
    const list = await api()
      .post(`${fixture.projectBase}/request-templates`)
      .set(as(owner))
      .send({ name: "Listar", operationId: "listThings", expectedStatus: 200 });
    const response = await api()
      .post(`${fixture.projectBase}/workflows`)
      .set(as(owner))
      .send({
        name: "Rota",
        definition: {
          steps: [
            {
              id: "listar",
              requestTemplateId: list.body.requestTemplateId,
              checks: [{ source: "body", path: "data", operator: "matches", value: "(" }],
            },
          ],
        },
      });
    assert.equal(response.status, 422);
    assert.ok(
      response.body.errors.some((error: { detail: string }) => error.detail.includes("expresión regular")),
      JSON.stringify(response.body.errors),
    );
    await fixture.target.stop();
  });
});

/**
 * Un paso que no siempre se ejecuta, uno que se ejecuta muchas veces, y de dónde viene cada valor.
 *
 * Los tres nodos que faltaban —condición, espera y bucle— sin inventar un tipo de nodo nuevo: son
 * propiedades del paso, porque todo lo que una corrida registra (un caso, sus peticiones, su
 * veredicto) es sobre una petición que se hizo, y un nodo sin petición sería una fila que
 * significa otra cosa que el resto de la tabla.
 */
describe("condición, espera y bucle de un paso", () => {
  async function flowOf(
    steps: (ids: Record<string, string>) => Record<string, unknown>[],
    variables: Record<string, string> = {},
  ) {
    const fixture = await projectAgainst({}, { variables: { entityName: "creado", ...variables } });
    const send = async (body: Record<string, unknown>) => {
      const response = await api().post(`${fixture.projectBase}/request-templates`).set(as(owner)).send(body);
      assert.equal(response.status, 201, JSON.stringify(response.body));
      return response.body.requestTemplateId as string;
    };
    const ids = {
      create: await send({
        name: "Crear",
        operationId: "createThing",
        expectedStatus: 201,
        body: { name: "{{env.entityName}}", size: 7 },
      }),
      list: await send({ name: "Listar", operationId: "listThings", expectedStatus: 200 }),
      read: await send({
        name: "Leer",
        operationId: "getThing",
        expectedStatus: 200,
        parameters: { id: "{{item.id}}" },
      }),
      readCaptured: await send({
        name: "Leer capturado",
        operationId: "getThing",
        expectedStatus: 200,
        parameters: { id: "{{crear.thingId}}" },
      }),
    };
    const workflow = await api()
      .post(`${fixture.projectBase}/workflows`)
      .set(as(owner))
      .send({ name: "Flujo", definition: { steps: steps(ids) } });
    return { ...fixture, ids, workflow };
  }

  test("un bucle deja un caso por elemento, no uno que esconde cuarenta resultados", async () => {
    const flow = await flowOf((ids) => [
      { id: "crear", requestTemplateId: ids.create },
      { id: "listar", requestTemplateId: ids.list, dependsOn: ["crear"] },
      {
        id: "leer",
        requestTemplateId: ids.read,
        dependsOn: ["listar"],
        forEach: { from: "listar", path: "data", as: "item", max: 10 },
      },
    ]);
    assert.equal(flow.workflow.status, 201, JSON.stringify(flow.workflow.body));
    const { run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflow.body.workflowId,
    });
    // La semilla del destino más la que creó el flujo: dos elementos, dos casos, cada uno con su
    // petición y su veredicto.
    const iterations = (run.cases as { scenarioId: string; status: string }[]).filter((item) =>
      item.scenarioId.includes(":leer#"),
    );
    assert.equal(
      iterations.length,
      2,
      JSON.stringify(run.cases.map((item: { scenarioId: string }) => item.scenarioId)),
    );
    assert.deepEqual(new Set(iterations.map((item) => item.status)), new Set(["passed"]));
    await flow.target.stop();
  });

  test("un bucle sobre una lista vacía es un caso saltado, no silencio", async () => {
    const flow = await flowOf((ids) => [
      { id: "listar", requestTemplateId: ids.list },
      {
        id: "leer",
        requestTemplateId: ids.read,
        dependsOn: ["listar"],
        // Una ruta que no lleva a una lista: se camina cero veces y se dice.
        forEach: { from: "listar", path: "data.0.name", as: "item" },
      },
    ]);
    const { run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflow.body.workflowId,
    });
    assert.equal(run.cases[1].status, "skipped");
    await flow.target.stop();
  });

  test("una condición que no se cumple salta el paso y no lo pone en rojo", async () => {
    const flow = await flowOf((ids) => [
      { id: "listar", requestTemplateId: ids.list },
      {
        id: "crear",
        requestTemplateId: ids.create,
        dependsOn: ["listar"],
        runIf: { from: "listar", check: { source: "body", path: "data", operator: "has_length", value: 99 } },
      },
    ]);
    const { run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflow.body.workflowId,
    });
    // Saltado y no fallido: «no había nada que borrar» es un flujo comportándose bien, y un caso
    // rojo diría lo contrario.
    assert.equal(run.cases[1].status, "skipped");
    assert.equal(run.status, "passed");
    await flow.target.stop();
  });

  test("una condición solo puede leer un paso del que el suyo depende", async () => {
    const flow = await flowOf((ids) => [
      { id: "listar", requestTemplateId: ids.list },
      {
        id: "crear",
        requestTemplateId: ids.create,
        runIf: { from: "listar", check: { source: "status", operator: "equals", value: 200 } },
      },
    ]);
    // Sin la arista no hay garantía de que «listar» haya contestado, y la condición se leería
    // como falsa sin que nadie lo pueda ver.
    assert.equal(flow.workflow.status, 422, JSON.stringify(flow.workflow.body));
    await flow.target.stop();
  });

  test("una espera retrasa el paso lo que dice", async () => {
    const flow = await flowOf((ids) => [
      { id: "listar", requestTemplateId: ids.list },
      { id: "crear", requestTemplateId: ids.create, dependsOn: ["listar"], waitMs: 400 },
    ]);
    const started = Date.now();
    const { run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflow.body.workflowId,
    });
    assert.equal(run.status, "passed");
    assert.ok(Date.now() - started >= 350, "la corrida no esperó");
    await flow.target.stop();
  });

  test("una variable dice de dónde viene: del entorno o de un paso", async () => {
    const flow = await flowOf(
      (ids) => [
        {
          id: "crear",
          requestTemplateId: ids.create,
          captures: [{ variable: "thingId", from: "body", path: "data.id" }],
        },
        { id: "leer", requestTemplateId: ids.readCaptured, dependsOn: ["crear"] },
      ],
      { entityName: "del-entorno" },
    );
    const { run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflow.body.workflowId,
    });
    // `{{crear.thingId}}` no puede ser por accidente la variable del entorno ni la de otro paso,
    // que es justo lo que un mapa plano no podía decir.
    assert.equal(run.cases[1].status, "passed", JSON.stringify(run.totals));

    const detail = await api().get(`${flow.projectBase}/runs/${run.id}/cases/${run.cases[0].id}`).set(as(owner));
    assert.deepEqual(detail.body.steps[0].request.body, { name: "del-entorno", size: 7 });
    await flow.target.stop();
  });
});

/**
 * Un flujo por fila de datos, y varios flujos como una sola corrida.
 *
 * Las dos cosas que convierten un flujo en una suite: recorrerlo con cuarenta filas en vez de con
 * una, y encadenar los nueve que alguien ejecuta a mano antes de una entrega para que dejen un
 * solo veredicto en el historial.
 */
describe("conjuntos de datos y suites", () => {
  async function projectWithFlows() {
    const fixture = await projectAgainst({});
    const send = async (path: string, body: Record<string, unknown>) => {
      const response = await api().post(`${fixture.projectBase}/${path}`).set(as(owner)).send(body);
      return response;
    };
    const create = await send("request-templates", {
      name: "Crear",
      operationId: "createThing",
      expectedStatus: 201,
      body: { name: "{{dataset.nombre}}", size: 7 },
    });
    const list = await send("request-templates", { name: "Listar", operationId: "listThings", expectedStatus: 200 });
    const creates = await send("workflows", {
      name: "Crear cosas",
      definition: { steps: [{ id: "crear", requestTemplateId: create.body.requestTemplateId }] },
    });
    const lists = await send("workflows", {
      name: "Listar cosas",
      definition: { steps: [{ id: "listar", requestTemplateId: list.body.requestTemplateId }] },
    });
    assert.equal(creates.status, 201, JSON.stringify(creates.body));
    assert.equal(lists.status, 201, JSON.stringify(lists.body));
    return { ...fixture, send, creates: creates.body.workflowId as string, lists: lists.body.workflowId as string };
  }

  test("una fila de datos es un recorrido entero del flujo", async () => {
    const project = await projectWithFlows();
    const dataset = await project.send(`workflows/${project.creates}/datasets`, {
      name: "catálogo",
      rows: [{ nombre: "primera" }, { nombre: "segunda" }],
    });
    assert.equal(dataset.status, 201, JSON.stringify(dataset.body));

    const { run } = await runAndWait(project.projectBase, {
      environmentId: project.environmentId,
      workflowId: project.creates,
      datasetId: dataset.body.datasetId,
    });
    assert.equal(run.cases.length, 2);
    assert.deepEqual(
      (run.cases as { scenarioId: string }[]).map((item) => item.scenarioId.split(":").at(-1)),
      ["crear@0", "crear@1"],
    );

    // Cada fila gasta lo suyo: si no, un conjunto de datos sería cuarenta veces la misma petición.
    const first = await api().get(`${project.projectBase}/runs/${run.id}/cases/${run.cases[0].id}`).set(as(owner));
    const second = await api().get(`${project.projectBase}/runs/${run.id}/cases/${run.cases[1].id}`).set(as(owner));
    assert.equal(first.body.steps[0].request.body.name, "primera");
    assert.equal(second.body.steps[0].request.body.name, "segunda");
    await project.target.stop();
  });

  test("un conjunto de datos de otro flujo se rechaza al lanzar la corrida", async () => {
    const project = await projectWithFlows();
    const dataset = await project.send(`workflows/${project.lists}/datasets`, {
      name: "otro",
      rows: [{ nombre: "x" }],
    });
    const response = await api().post(`${project.projectBase}/runs`).set(as(owner)).send({
      environmentId: project.environmentId,
      workflowId: project.creates,
      datasetId: dataset.body.datasetId,
    });
    // Sus columnas las gastan los pasos de otro flujo: cada fila sustituiría nada.
    assert.equal(response.status, 422);
    assert.ok(response.body.errors.some((error: { field: string }) => error.field === "datasetId"));
    await project.target.stop();
  });

  test("un conjunto sin filas no llega a encolarse", async () => {
    const project = await projectWithFlows();
    const dataset = await project.send(`workflows/${project.creates}/datasets`, { name: "vacío", rows: [] });
    const response = await api()
      .post(`${project.projectBase}/runs`)
      .set(as(owner))
      .send({ environmentId: project.environmentId, workflowId: project.creates, datasetId: dataset.body.datasetId });
    assert.equal(response.status, 422);
    await project.target.stop();
  });

  test("una columna que no es un nombre de variable se rechaza al guardarla", async () => {
    const project = await projectWithFlows();
    const response = await project.send(`workflows/${project.creates}/datasets`, {
      name: "malo",
      rows: [{ "precio total": "9" }],
    });
    // `{{dataset.precio total}}` no es un token que el motor vaya a sustituir nunca, así que
    // aceptarlo solo movería el descubrimiento a mitad de corrida.
    assert.equal(response.status, 422, JSON.stringify(response.body));
    await project.target.stop();
  });

  test("una suite recorre sus flujos en orden y deja un solo veredicto", async () => {
    const project = await projectWithFlows();
    const suite = await project.send("suites", {
      name: "antes de entregar",
      workflowIds: [project.lists, project.creates],
    });
    assert.equal(suite.status, 201, JSON.stringify(suite.body));

    const { run } = await runAndWait(project.projectBase, {
      environmentId: project.environmentId,
      suiteId: suite.body.suiteId,
    });
    assert.equal(run.cases.length, 2);
    // El orden es el contenido: una suite existe porque esos flujos van en esa secuencia.
    assert.deepEqual(
      (run.cases as { scenarioId: string }[]).map((item) => item.scenarioId.split(":").at(-1)),
      ["listar", "crear"],
    );
    await project.target.stop();
  });

  test("una corrida ejecuta un flujo o una suite, no las dos cosas", async () => {
    const project = await projectWithFlows();
    const suite = await project.send("suites", { name: "s", workflowIds: [project.lists] });
    const response = await api()
      .post(`${project.projectBase}/runs`)
      .set(as(owner))
      .send({ environmentId: project.environmentId, workflowId: project.creates, suiteId: suite.body.suiteId });
    assert.equal(response.status, 422);
    await project.target.stop();
  });

  test("borrar un flujo que una suite nombra es 409", async () => {
    const project = await projectWithFlows();
    await project.send("suites", { name: "usa el flujo", workflowIds: [project.creates] });
    const response = await api().delete(`${project.projectBase}/workflows/${project.creates}`).set(as(owner));
    // Una referencia es una decisión de alguien, y quitarla en su nombre cambia lo que ejecuta la
    // suite sin decirlo.
    assert.equal(response.status, 409);
    await project.target.stop();
  });

  test("una suite no puede nombrar un flujo que no existe ni repetir uno", async () => {
    const project = await projectWithFlows();
    const missing = await project.send("suites", {
      name: "inexistente",
      workflowIds: ["11111111-1111-4111-8111-111111111111"],
    });
    assert.equal(missing.status, 422);
    const twice = await project.send("suites", {
      name: "repetida",
      workflowIds: [project.creates, project.creates],
    });
    assert.equal(twice.status, 422);
    await project.target.stop();
  });

  test("seguir una corrida que ya terminó la da por terminada, no deja la conexión esperando", async () => {
    const project = await projectWithFlows();
    const { runId } = await runAndWait(project.projectBase, { environmentId: project.environmentId });

    // Una corrida de treinta milisegundos termina antes de que el navegador llegue a abrir el
    // stream. Si eso abriera con una foto sin estado, el seguidor se quedaría con una conexión
    // que ya no va a emitir nada y una cabecera que dice «running» para siempre.
    const stream = await api()
      .get(`${project.projectBase}/runs/${runId}/stream`)
      .set(as(owner))
      .buffer(true)
      .parse((response, next) => {
        let text = "";
        response.on("data", (chunk: Buffer) => (text += chunk.toString()));
        response.on("end", () => next(null, text));
      });

    // El parser de arriba deja el texto crudo en `body`: un `text/event-stream` no es JSON y
    // supertest no tiene nada que poner en `.text` si nadie se lo dice.
    const raw = stream.body as unknown as string;
    assert.match(raw, /event: finished/);
    const data = JSON.parse(/data: (.*)/.exec(raw)![1]);
    assert.equal(data.status, "passed");
    assert.equal(data.totals.cases, data.totals.completed);
    await project.target.stop();
  });

  test("una corrida dice qué ejecutó, y lo dice con nombres", async () => {
    const project = await projectWithFlows();
    const dataset = await project.send(`workflows/${project.creates}/datasets`, {
      name: "catálogo",
      rows: [{ nombre: "primera" }],
    });
    const suite = await project.send("suites", { name: "antes de entregar", workflowIds: [project.lists] });

    await runAndWait(project.projectBase, { environmentId: project.environmentId });
    await runAndWait(project.projectBase, {
      environmentId: project.environmentId,
      workflowId: project.creates,
      datasetId: dataset.body.datasetId,
    });
    await runAndWait(project.projectBase, { environmentId: project.environmentId, suiteId: suite.body.suiteId });

    const listed = await api().get(`${project.projectBase}/runs`).set(as(owner));
    // Las tres formas de lanzar una corrida eran la misma fila en el historial, que es como
    // «¿esto estaba verde la semana pasada?» deja de tener respuesta.
    const kinds = listed.body.map((run: { source: { kind: string } }) => run.source.kind);
    assert.deepEqual(new Set(kinds), new Set(["matrix", "workflow", "suite"]));

    const flow = listed.body.find((run: { source: { kind: string } }) => run.source.kind === "workflow");
    assert.deepEqual(flow.source, {
      kind: "workflow",
      workflowId: project.creates,
      name: "Crear cosas",
      datasetId: dataset.body.datasetId,
      datasetName: "catálogo",
      rows: 1,
    });
    await project.target.stop();
  });

  test("el flujo que ya no existe se dice, no se calla", async () => {
    const project = await projectWithFlows();
    const { run } = await runAndWait(project.projectBase, {
      environmentId: project.environmentId,
      workflowId: project.creates,
    });
    assert.equal(
      (await api().delete(`${project.projectBase}/workflows/${project.creates}`).set(as(owner))).status,
      204,
    );

    const after = await api().get(`${project.projectBase}/runs/${run.id}`).set(as(owner));
    // El nombre se resuelve al leer y no se guarda con la corrida: renombrar un flujo cambia lo
    // que el historial lo llama, y borrarlo no convierte sus corridas en una mentira sobre un
    // flujo que sigue existiendo.
    assert.deepEqual(after.body.source, {
      kind: "workflow",
      workflowId: project.creates,
      name: null,
      datasetId: null,
      datasetName: null,
      rows: 1,
    });
    await project.target.stop();
  });

  test("una corrida que se pasaría del tope se rechaza en el clic", async () => {
    // Los topes de este producto son locales —500 filas, 50 flujos, 200 vueltas— y se
    // multiplican. Este es el único que mira el total, y mirarlo aquí es la diferencia entre un
    // 422 nombrando el campo y una corrida que hay que cancelar con sus efectos ya en el destino.
    //
    // Once pasos por quinientas filas son 5 500 casos, por encima del tope real de 5 000: la
    // prueba usa el valor de verdad en vez de bajarlo para la ocasión.
    const project = await projectWithFlows();
    const steps = [];
    for (let index = 0; index < 11; index += 1) {
      const template = await project.send("request-templates", {
        name: `Listar ${index}`,
        operationId: "listThings",
        expectedStatus: 200,
      });
      steps.push({ id: `paso-${index}`, requestTemplateId: template.body.requestTemplateId });
    }
    const workflow = await project.send("workflows", { name: "once pasos", definition: { steps } });
    assert.equal(workflow.status, 201, JSON.stringify(workflow.body));

    const dataset = await project.send(`workflows/${workflow.body.workflowId}/datasets`, {
      name: "quinientas",
      rows: Array.from({ length: 500 }, (_item, index) => ({ nombre: `fila-${index}` })),
    });
    assert.equal(dataset.status, 201, JSON.stringify(dataset.body));

    const response = await api().post(`${project.projectBase}/runs`).set(as(owner)).send({
      environmentId: project.environmentId,
      workflowId: workflow.body.workflowId,
      datasetId: dataset.body.datasetId,
    });
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.match(response.body.detail, /5500 casos y el tope es 5000/);
    assert.deepEqual(
      response.body.errors.map((error: { field: string }) => error.field),
      ["datasetId"],
    );
    await project.target.stop();
  });

  test("la lista no trae las filas, y el conjunto sí cuando se pide", async () => {
    const project = await projectWithFlows();
    const dataset = await project.send(`workflows/${project.creates}/datasets`, {
      name: "catálogo",
      rows: [{ nombre: "primera" }, { nombre: "segunda" }],
    });

    const listed = await api().get(`${project.projectBase}/workflows`).set(as(owner));
    // Quinientas filas de nueve columnas en la carga que dibuja una página es una descarga que
    // nadie pidió: la lista dice cuántas hay y cómo se llaman las columnas.
    assert.deepEqual(listed.body.datasets, [
      {
        id: dataset.body.datasetId,
        workflowId: project.creates,
        name: "catálogo",
        columns: ["nombre"],
        rowCount: 2,
        updatedAt: listed.body.datasets[0].updatedAt,
      },
    ]);

    const rows = await api().get(`${project.projectBase}/datasets/${dataset.body.datasetId}`).set(as(owner));
    assert.deepEqual(rows.body.rows, [{ nombre: "primera" }, { nombre: "segunda" }]);
    await project.target.stop();
  });
});

/**
 * Un paso inicia sesión y los siguientes gastan lo que contestó.
 *
 * Lo que sustituye: alguien pega un token en el entorno a mano y lo vuelve a pegar cuando caduca,
 * con lo que cada suite es algo que hay que vigilar. Un flujo que se autentica contra el destino
 * que está probando es la forma normal de una API de verdad.
 */
describe("la credencial que consigue la propia corrida", () => {
  async function loginFlow(steps: (ids: Record<string, string>) => Record<string, unknown>[]) {
    // El destino exige credencial y el entorno no guarda ninguna: sin iniciar sesión, todo es 401.
    const fixture = await projectAgainst({ enforcesAuth: true });
    const send = async (body: Record<string, unknown>) => {
      const response = await api().post(`${fixture.projectBase}/request-templates`).set(as(owner)).send(body);
      assert.equal(response.status, 201, JSON.stringify(response.body));
      return response.body.requestTemplateId as string;
    };
    const ids = {
      login: await send({
        name: "Iniciar sesión",
        operationId: "createSession",
        expectedStatus: 201,
        body: { email: "quien@ejemplo.com", password: "una-contraseña" },
        auth: "none",
      }),
      list: await send({ name: "Listar", operationId: "listThings", expectedStatus: 200 }),
      anonymous: await send({
        name: "Listar sin credencial",
        operationId: "listThings",
        expectedStatus: 401,
        auth: "none",
      }),
    };
    const workflow = await api()
      .post(`${fixture.projectBase}/workflows`)
      .set(as(owner))
      .send({ name: "Con sesión", definition: { steps: steps(ids) } });
    assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
    return { ...fixture, workflowId: workflow.body.workflowId as string };
  }

  test("los pasos siguientes presentan el token, sin que nadie lo pegue en el entorno", async () => {
    const flow = await loginFlow((ids) => [
      {
        id: "iniciar",
        requestTemplateId: ids.login,
        authorizes: { from: "body", path: "data.token" },
      },
      { id: "listar", requestTemplateId: ids.list, dependsOn: ["iniciar"] },
    ]);
    const { runId, run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
    });
    assert.equal(run.status, "passed", JSON.stringify(run.totals));

    const login = await api().get(`${flow.projectBase}/runs/${runId}/cases/${run.cases[0].id}`).set(as(owner));
    const obtained = login.body.steps[0].assertions.find(
      (entry: { label: string }) => entry.label === "Sesión obtenida",
    );
    assert.equal(obtained.pass, true);
    assert.match(obtained.detail, /Authorization/);
    await flow.target.stop();
  });

  test("la sesión sustituye la credencial que funciona, y solo esa", async () => {
    const flow = await loginFlow((ids) => [
      { id: "iniciar", requestTemplateId: ids.login, authorizes: { from: "body", path: "data.token" } },
      { id: "sin-credencial", requestTemplateId: ids.anonymous, dependsOn: ["iniciar"] },
    ]);
    const { run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
    });
    // El caso que presenta `none` existe para que lo rechacen. Darle una sesión que funciona lo
    // convertiría en un 200 verde que no demuestra nada.
    assert.equal(run.status, "passed", JSON.stringify(run.totals));
    assert.equal(run.cases[1].status, "passed");
    await flow.target.stop();
  });

  test("la sesión también puede venir en una cookie, que es donde viene la mitad de las veces", async () => {
    const flow = await loginFlow((ids) => [
      {
        id: "iniciar",
        requestTemplateId: ids.login,
        // La cabecera entera es `session=…; Path=/; Expires=Wed, 09 Jun …`. Sacar eso con una ruta
        // de puntos no es algo que se le pueda pedir a nadie, así que `cookie` la lee por su
        // nombre y se queda con el valor, sin atributos.
        authorizes: { from: "cookie", path: "session", header: "Cookie", scheme: "session=" },
        captures: [{ variable: "tema", from: "cookie", path: "theme" }],
      },
      { id: "listar", requestTemplateId: ids.list, dependsOn: ["iniciar"] },
    ]);
    const { runId, run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
    });
    assert.equal(run.status, "passed", JSON.stringify(run.totals));

    const login = await api().get(`${flow.projectBase}/runs/${runId}/cases/${run.cases[0].id}`).set(as(owner));
    const assertions = login.body.steps[0].assertions as { label: string; pass: boolean; detail: string }[];
    assert.equal(assertions.find((entry) => entry.label === "Sesión obtenida")?.pass, true);
    // Y la segunda cookie sale entera pese a la coma de la fecha de la primera.
    assert.match(assertions.find((entry) => entry.label === "Variables capturadas")?.detail ?? "", /tema/);
    await flow.target.stop();
  });

  test("un login que contesta otra cosa se dice en el paso que inició sesión", async () => {
    const flow = await loginFlow((ids) => [
      { id: "iniciar", requestTemplateId: ids.login, authorizes: { from: "body", path: "data.accessToken" } },
      { id: "listar", requestTemplateId: ids.list, dependsOn: ["iniciar"] },
    ]);
    const { runId, run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
    });
    // El hallazgo es del login, no de los ocho pasos siguientes contestando 401: eso es el mismo
    // hallazgo repetido ocho veces sin nombrarlo ni una.
    assert.equal(run.cases[0].status, "failed");
    const login = await api().get(`${flow.projectBase}/runs/${runId}/cases/${run.cases[0].id}`).set(as(owner));
    const obtained = login.body.steps[0].assertions.find(
      (entry: { label: string }) => entry.label === "Sesión obtenida",
    );
    assert.equal(obtained.pass, false);
    assert.match(obtained.detail, /data\.accessToken/);
    assert.equal(run.cases[1].status, "skipped");
    await flow.target.stop();
  });
});

/**
 * Dos pasos que no dependen el uno del otro pueden ir a la vez.
 *
 * Lo que decide qué puede empezar son las aristas, no el orden en el que alguien listó los pasos.
 * Con `concurrency: 1` —lo de siempre— se despacha uno cada vez; con más, los que no tienen camino
 * entre ellos salen juntos.
 *
 * Lo que hace que eso sea seguro **se comprueba al guardar el flujo, no al ejecutarlo**: las
 * variables de una corrida son un solo mapa, así que dos pasos que puedan coincidir no pueden
 * capturar el mismo nombre, y el que inicia sesión es una barrera. Comprobarlo al escribir es lo
 * que impide que subir un número en el panel convierta en una carrera un flujo guardado hace años.
 */
describe("pasos en paralelo", () => {
  async function twoIndependent(steps: (listId: string) => Record<string, unknown>[]) {
    // 250 ms por petición: con dos pasos en serie son 500, y dos llegadas más juntas que eso solo
    // pueden haber estado en vuelo a la vez.
    const fixture = await projectAgainst({ slowMs: 250 });
    const list = await api()
      .post(`${fixture.projectBase}/request-templates`)
      .set(as(owner))
      .send({ name: "Listar", operationId: "listThings", expectedStatus: 200 });
    const workflow = await api()
      .post(`${fixture.projectBase}/workflows`)
      .set(as(owner))
      .send({ name: "A la vez", definition: { steps: steps(list.body.requestTemplateId) } });
    assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
    return { ...fixture, workflowId: workflow.body.workflowId as string };
  }

  const independent = (list: string) => [
    { id: "uno", requestTemplateId: list },
    { id: "dos", requestTemplateId: list },
  ];

  const arrivals = (target: { requests: { path: string; at: number }[] }) =>
    target.requests.filter((request) => request.path === "/things").map((request) => request.at);

  test("por defecto van de uno en uno, como siempre", async () => {
    const flow = await twoIndependent(independent);
    const { run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
    });
    assert.equal(run.status, "passed");
    const [first, second] = arrivals(flow.target);
    assert.ok(second - first >= 200, `las dos peticiones se solaparon sin pedirlo: ${second - first} ms`);
    await flow.target.stop();
  });

  test("con concurrencia 2 salen juntos", async () => {
    const flow = await twoIndependent(independent);
    const { run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
      concurrency: 2,
    });
    assert.equal(run.status, "passed");
    const [first, second] = arrivals(flow.target);
    assert.ok(second - first < 200, `no se solaparon: ${second - first} ms entre las dos llegadas`);
    await flow.target.stop();
  });

  test("una arista sigue siendo una arista: lo que depende espera", async () => {
    const flow = await twoIndependent((list) => [
      { id: "uno", requestTemplateId: list },
      { id: "dos", requestTemplateId: list, dependsOn: ["uno"] },
    ]);
    await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
      concurrency: 4,
    });
    const [first, second] = arrivals(flow.target);
    assert.ok(second - first >= 200, `la dependencia no se respetó: ${second - first} ms`);
    await flow.target.stop();
  });

  test("con «any», el que junta dos caminos arranca con el primero que llegue", async () => {
    const flow = await twoIndependent((list) => [
      { id: "uno", requestTemplateId: list },
      { id: "dos", requestTemplateId: list },
      { id: "junta", requestTemplateId: list, dependsOn: ["uno", "dos"], waits: "any" },
    ]);
    const { run } = await runAndWait(flow.projectBase, {
      environmentId: flow.environmentId,
      workflowId: flow.workflowId,
      concurrency: 3,
    });
    assert.equal(run.status, "passed");
    const times = arrivals(flow.target);
    // Los dos primeros salen juntos; el tercero, en cuanto uno de ellos contesta, sin esperar al
    // otro —que es lo único que «any» significa—.
    assert.ok(times[2] - times[0] < 450, `esperó a los dos: ${times[2] - times[0]} ms`);
    await flow.target.stop();
  });

  test("dos pasos que pueden coincidir no pueden capturar la misma variable", async () => {
    const fixture = await projectAgainst({});
    const list = await api()
      .post(`${fixture.projectBase}/request-templates`)
      .set(as(owner))
      .send({ name: "Listar", operationId: "listThings", expectedStatus: 200 });
    const capture = [{ variable: "primero", from: "body", path: "data.0.id" }];
    const response = await api()
      .post(`${fixture.projectBase}/workflows`)
      .set(as(owner))
      .send({
        name: "Carrera",
        definition: {
          steps: [
            { id: "uno", requestTemplateId: list.body.requestTemplateId, captures: capture },
            { id: "dos", requestTemplateId: list.body.requestTemplateId, captures: capture },
          ],
        },
      });
    // Rechazado al escribirlo y no al ejecutarlo: si dependiera del número de concurrencia, el
    // flujo sería correcto hoy e incorrecto el día que alguien lo suba, sin haberlo tocado.
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.ok(
      response.body.errors.some((error: { detail: string }) => error.detail.includes("capturan primero")),
      JSON.stringify(response.body.errors),
    );
    await fixture.target.stop();
  });

  test("el paso que inicia sesión es una barrera", async () => {
    const fixture = await projectAgainst({});
    const list = await api()
      .post(`${fixture.projectBase}/request-templates`)
      .set(as(owner))
      .send({ name: "Listar", operationId: "listThings", expectedStatus: 200 });
    const response = await api()
      .post(`${fixture.projectBase}/workflows`)
      .set(as(owner))
      .send({
        name: "Sesión suelta",
        definition: {
          steps: [
            {
              id: "iniciar",
              requestTemplateId: list.body.requestTemplateId,
              authorizes: { from: "body", path: "data.0.id" },
            },
            { id: "otro", requestTemplateId: list.body.requestTemplateId },
          ],
        },
      });
    // Una sesión es una credencial para toda la corrida: lo que pudiera correr a su lado mandaría
    // su petición con la vieja o con la nueva según le tocara al planificador.
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.ok(
      response.body.errors.some((error: { detail: string }) => error.detail.includes("inicia sesión")),
      JSON.stringify(response.body.errors),
    );
    await fixture.target.stop();
  });
});
