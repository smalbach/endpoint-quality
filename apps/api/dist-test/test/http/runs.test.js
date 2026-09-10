"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const supertest_1 = __importDefault(require("supertest"));
const test_app_1 = require("../support/test-app");
const stub_target_1 = require("../support/stub-target");
let context;
const api = () => (0, supertest_1.default)(context.app.getHttpServer());
async function signUp(email) {
    const password = "una-contraseña-larga";
    const registered = await api().post("/auth/register").send({ email, password, name: email.split("@")[0] });
    const session = await api().post("/auth/login").send({ email, password });
    // Asserted rather than trusted. When login fails the token is `undefined`, every later request
    // goes out as `Bearer undefined`, and the suite reports a 401 on whatever line happens to be
    // next — which describes the symptom and hides the cause.
    strict_1.default.equal(session.status, 200, `no se pudo iniciar sesión como ${email}: ${JSON.stringify(session.body)}`);
    strict_1.default.ok(session.body.accessToken, `el login de ${email} no devolvió token`);
    return { userId: registered.body.userId, organizationId: registered.body.organizationId, token: session.body.accessToken };
}
const as = (actor) => ({ Authorization: `Bearer ${actor.token}` });
let owner;
let base;
/** A project pointed at a freshly configured target. Each test gets its own so one run's writes
 * cannot change what the next one measures. */
async function projectAgainst(faults, environment = {}) {
    const target = new stub_target_1.StubTarget(faults);
    await target.start();
    // Every step is asserted. A helper that quietly produces an undefined project id turns every
    // later failure into a 404 with no explanation, which is how a five-minute bug becomes an hour.
    const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: `p-${Math.random().toString(36).slice(2, 8)}` });
    strict_1.default.equal(project.status, 201, `no se pudo crear el proyecto: ${JSON.stringify(project.body)}`);
    const projectBase = `/orgs/${owner.organizationId}/projects/${project.body.projectId}`;
    const imported = await api().post(`${projectBase}/spec-versions`).set(as(owner)).send({ source: { kind: "inline", raw: stub_target_1.STUB_SPEC_YAML } });
    strict_1.default.equal(imported.status, 201, `no se pudo importar el contrato: ${JSON.stringify(imported.body)}`);
    await api().put(`${projectBase}/config/bodies`).set(as(owner)).send({ bodyTemplates: { createThing: { body: { name: "creado", size: 7 } } } });
    await api().put(`${projectBase}/config/parameters`).set(as(owner)).send({
        parameterSamples: {},
        fallbackSamples: ["test"],
        excludeFromSoloScenarios: [],
        pathDefaults: { id: "1" },
        fallbackPathValue: "1",
        missingIdValue: "no-existe",
    });
    const created = await api().post(`${projectBase}/environments`).set(as(owner)).send({
        name: "stub",
        baseUrl: environment.baseUrl ?? target.origin,
        specUrl: `${target.origin}/openapi.json`,
        writesAllowed: environment.writesAllowed ?? true,
        authEnforced: environment.authEnforced ?? false,
    });
    strict_1.default.equal(created.status, 201, `no se pudo crear el entorno: ${JSON.stringify(created.body)}`);
    return { target, projectBase, environmentId: created.body.environmentId };
}
/** Starts a run and waits for the worker to finish it. The wait is on the queue rather than on a
 * poll loop, so a hang here is a hang and not a flaky timeout. */
async function runAndWait(projectBase, body) {
    const started = await api().post(`${projectBase}/runs`).set(as(owner)).send(body);
    strict_1.default.equal(started.status, 202, JSON.stringify(started.body));
    await context.queue.idle();
    const run = await api().get(`${projectBase}/runs/${started.body.runId}`).set(as(owner));
    return { runId: started.body.runId, run: run.body };
}
const caseOf = (run, operationId, scenarioId) => {
    const found = run.cases.find((item) => item.operationId === operationId && item.scenarioId === scenarioId);
    // Named rather than `!`: a case that is absent means the matrix did not generate it, and the
    // failure should say which one instead of a null dereference three lines later.
    if (!found)
        throw new Error(`La corrida no contiene el caso ${operationId}:${scenarioId}`);
    return found;
};
(0, node_test_1.before)(async () => {
    context = await (0, test_app_1.createTestApp)();
    owner = await signUp("runs-owner@example.com");
    base = `/orgs/${owner.organizationId}`;
});
(0, node_test_1.after)(async () => {
    await context?.close();
});
(0, node_test_1.describe)("una corrida completa contra un destino correcto", () => {
    let fixture;
    (0, node_test_1.before)(async () => {
        fixture = await projectAgainst({});
    });
    (0, node_test_1.after)(async () => {
        await fixture.target.stop();
    });
    (0, node_test_1.test)("responde 202 con un id y ejecuta en segundo plano", async () => {
        // The request returns before anything has been requested of the target. That is what makes
        // closing the browser harmless, and it is the difference from a loop in a React component.
        const started = await api().post(`${fixture.projectBase}/runs`).set(as(owner)).send({ environmentId: fixture.environmentId });
        strict_1.default.equal(started.status, 202);
        strict_1.default.ok(started.body.runId);
        await context.queue.idle();
        const run = await api().get(`${fixture.projectBase}/runs/${started.body.runId}`).set(as(owner));
        strict_1.default.equal(run.body.status, "passed", JSON.stringify(run.body.totals));
    });
    (0, node_test_1.test)("todos los casos pasan y los totales cuadran", async () => {
        const { run } = await runAndWait(fixture.projectBase, { environmentId: fixture.environmentId });
        strict_1.default.equal(run.totals.failed, 0);
        strict_1.default.equal(run.totals.completed, run.totals.cases);
        strict_1.default.equal(run.totals.passed + run.totals.skipped, run.totals.cases);
    });
    (0, node_test_1.test)("el flujo create-read deja la base como estaba", async () => {
        // Without the cleanup the second run of this case is a conflict over the natural key, which
        // reports the previous run rather than the endpoint.
        const { run } = await runAndWait(fixture.projectBase, { environmentId: fixture.environmentId, operationIds: ["createThing"] });
        const runCase = caseOf(run, "createThing", "create-read");
        const detail = await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner));
        strict_1.default.deepEqual(detail.body.steps.map((step) => step.purpose), ["act", "verify", "cleanup"]);
        strict_1.default.equal(detail.body.steps.every((step) => step.ok), true);
    });
    (0, node_test_1.test)("las credenciales no aparecen en lo que se guarda", async () => {
        const { run } = await runAndWait(fixture.projectBase, { environmentId: fixture.environmentId, operationIds: ["listThings"] });
        const runCase = caseOf(run, "listThings", "default");
        const detail = await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner));
        // Masked before the row is written. A redaction at read time is one query away from being
        // forgotten, and the value is a live credential for somebody's environment.
        strict_1.default.equal(JSON.stringify(detail.body).includes("Bearer "), false);
    });
    (0, node_test_1.test)("una corrida queda en el historial del proyecto", async () => {
        // The capability the coupled dashboard did not have: there the result lived in useState and
        // died on refresh.
        const history = await api().get(`${fixture.projectBase}/runs`).set(as(owner));
        strict_1.default.ok(history.body.length >= 1);
        strict_1.default.ok(history.body[0].finishedAt);
    });
});
(0, node_test_1.describe)("un 200 no es un test que pasa", () => {
    (0, node_test_1.test)("envelope roto: el status pasa y el caso falla", async () => {
        // The thesis of the whole product. The API answers 200 with `{ items: [] }` where the
        // contract declares `{ data: [...] }`, and only the schema assertion sees it.
        const fixture = await projectAgainst({ brokenEnvelope: true });
        const { run } = await runAndWait(fixture.projectBase, { environmentId: fixture.environmentId, operationIds: ["listThings"] });
        const runCase = caseOf(run, "listThings", "default");
        strict_1.default.equal(runCase.status, "failed");
        const detail = await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner));
        const assertions = detail.body.steps[0].assertions;
        strict_1.default.equal(assertions.find((assertion) => assertion.label.startsWith("Status")).pass, true);
        strict_1.default.equal(assertions.find((assertion) => assertion.label === "Schema OpenAPI").pass, false);
        strict_1.default.match(assertions.find((assertion) => assertion.label === "Schema OpenAPI").detail, /campo requerido/);
        await fixture.target.stop();
    });
    (0, node_test_1.test)("campos que no persisten: el POST responde 201 y el caso falla en la relectura", async () => {
        const fixture = await projectAgainst({ dropsFields: true });
        const { run } = await runAndWait(fixture.projectBase, { environmentId: fixture.environmentId, operationIds: ["createThing"] });
        const runCase = caseOf(run, "createThing", "create-read");
        strict_1.default.equal(runCase.status, "failed");
        const detail = await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner));
        // The create step itself is fine — that is the point.
        strict_1.default.equal(detail.body.steps[0].ok, true);
        const persistence = detail.body.steps[1].assertions.find((assertion) => assertion.label === "Persistencia de campos");
        strict_1.default.equal(persistence.pass, false);
        strict_1.default.match(persistence.detail, /name|size/);
        await fixture.target.stop();
    });
    (0, node_test_1.test)("borrado blando: el DELETE responde 204 y el recurso sigue ahí", async () => {
        const fixture = await projectAgainst({ softDelete: true });
        const { run } = await runAndWait(fixture.projectBase, { environmentId: fixture.environmentId, operationIds: ["deleteThing"] });
        // `delete-read` passes: the API did answer 204. `deleted-read` is the one that looks at what
        // the resource *is* afterwards.
        strict_1.default.equal(caseOf(run, "deleteThing", "delete-read").status, "passed");
        strict_1.default.equal(caseOf(run, "deleteThing", "deleted-read").status, "failed");
        await fixture.target.stop();
    });
    (0, node_test_1.test)("un destino lento incumple el presupuesto y solo el presupuesto", async () => {
        const fixture = await projectAgainst({ slowMs: 120 });
        await api().put(`${fixture.projectBase}/config/budgets`).set(as(owner)).send({
            budgets: [{ id: "get", methods: ["GET"], thresholdMs: 50, label: "GET p95 < 50 ms", source: "prueba" }],
        });
        const { run } = await runAndWait(fixture.projectBase, { environmentId: fixture.environmentId, operationIds: ["listThings"] });
        const runCase = caseOf(run, "listThings", "default");
        strict_1.default.equal(runCase.status, "failed");
        const detail = await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner));
        const assertions = detail.body.steps[0].assertions;
        strict_1.default.equal(assertions.find((assertion) => assertion.label === "Schema OpenAPI").pass, true);
        strict_1.default.equal(assertions.at(-1).label, "GET p95 < 50 ms");
        strict_1.default.equal(assertions.at(-1).pass, false);
        await fixture.target.stop();
    });
    (0, node_test_1.test)("un 405 es su propio diagnóstico y silencia el resto", async () => {
        const fixture = await projectAgainst({ notImplemented: true });
        const { run } = await runAndWait(fixture.projectBase, { environmentId: fixture.environmentId, operationIds: ["createThing"] });
        const runCase = caseOf(run, "createThing", "create-read");
        const detail = await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner));
        const assertions = detail.body.steps[0].assertions;
        strict_1.default.match(assertions[0].detail, /no está implementado/);
        // Nothing downstream says anything useful about a response the API never produced.
        strict_1.default.match(assertions.find((assertion) => assertion.label === "Schema OpenAPI").detail, /No evaluado/);
        // The flow stops there: chasing a read-back for a create that never happened is a second red
        // line that says nothing new.
        strict_1.default.equal(detail.body.steps.length, 1);
        await fixture.target.stop();
    });
    (0, node_test_1.test)("errores sin Problem Details se detectan", async () => {
        const fixture = await projectAgainst({ plainErrors: true });
        const { run } = await runAndWait(fixture.projectBase, { environmentId: fixture.environmentId, operationIds: ["getThing"] });
        // `{ "error": "..." }` is the shape the error-envelope assertion exists to reject.
        strict_1.default.equal(caseOf(run, "getThing", "not-found").status, "failed");
        // The 200 of the same endpoint is unaffected, so the failure names the right case.
        strict_1.default.equal(caseOf(run, "getThing", "found").status, "passed");
        await fixture.target.stop();
    });
});
(0, node_test_1.describe)("guardas del entorno", () => {
    (0, node_test_1.test)("sin escrituras permitidas nada sale a la red y el caso queda saltado", async () => {
        const fixture = await projectAgainst({}, { writesAllowed: false });
        const before = fixture.target.requests.length;
        const { run } = await runAndWait(fixture.projectBase, { environmentId: fixture.environmentId, operationIds: ["createThing", "deleteThing"] });
        for (const runCase of run.cases)
            strict_1.default.notEqual(runCase.status, "passed");
        // Refused before anything leaves the process: the check is in the engine, not in the UI,
        // because CI never sees the UI.
        const writes = fixture.target.requests.slice(before).filter((entry) => entry.method !== "GET");
        strict_1.default.deepEqual(writes, []);
        await fixture.target.stop();
    });
    (0, node_test_1.test)("una corrida con casos saltados y ningún fallo pasa", async () => {
        // A case the environment refused is not a finding about the API, and reporting it as one
        // would train people to ignore red.
        const fixture = await projectAgainst({}, { writesAllowed: false });
        const { run } = await runAndWait(fixture.projectBase, { environmentId: fixture.environmentId, operationIds: ["listThings"] });
        strict_1.default.equal(run.status, "passed");
        await fixture.target.stop();
    });
    (0, node_test_1.test)("con autorización aplicada, la matriz 401/403 se ejecuta de verdad", async () => {
        const fixture = await projectAgainst({ enforcesAuth: true }, { authEnforced: true });
        await api().put(`${fixture.projectBase}/environments/${fixture.environmentId}/credentials`).set(as(owner)).send({
            name: "admin", role: "primary", kind: "bearer", secret: "token-completo",
        });
        await api().put(`${fixture.projectBase}/environments/${fixture.environmentId}/credentials`).set(as(owner)).send({
            name: "lectura", role: "insufficient", kind: "bearer", secret: "solo-lectura",
        });
        const { run } = await runAndWait(fixture.projectBase, { environmentId: fixture.environmentId, operationIds: ["listThings", "createThing"] });
        // `auth-none` sends nothing and expects 401; the insufficient token authenticates and does
        // not reach the write, which is the 403. Neither is testable with one credential.
        strict_1.default.equal(caseOf(run, "listThings", "auth-none").status, "passed");
        strict_1.default.equal(caseOf(run, "createThing", "auth-none").status, "passed");
        await fixture.target.stop();
    });
    (0, node_test_1.test)("una URL base inalcanzable falla como conexión, no como schema", async () => {
        const fixture = await projectAgainst({}, { baseUrl: "http://127.0.0.1:1" });
        const { run } = await runAndWait(fixture.projectBase, { environmentId: fixture.environmentId, operationIds: ["listThings"] });
        const runCase = caseOf(run, "listThings", "default");
        strict_1.default.equal(runCase.status, "failed");
        const detail = await api().get(`${fixture.projectBase}/runs/${run.id}/cases/${runCase.id}`).set(as(owner));
        strict_1.default.equal(detail.body.steps[0].assertions[0].label, "Conexión con la API");
        await fixture.target.stop();
    });
});
(0, node_test_1.describe)("permisos y aislamiento", () => {
    let fixture;
    (0, node_test_1.before)(async () => {
        fixture = await projectAgainst({});
    });
    (0, node_test_1.after)(async () => {
        await fixture.target.stop();
    });
    (0, node_test_1.test)("un viewer ve las corridas pero no las lanza", async () => {
        const viewer = await signUp("runs-viewer@example.com");
        await context.repositories.memberships.save({ organizationId: owner.organizationId, userId: viewer.userId, role: "viewer", createdAt: new Date() });
        strict_1.default.equal((await api().get(`${fixture.projectBase}/runs`).set(as(viewer))).status, 200);
        strict_1.default.equal((await api().post(`${fixture.projectBase}/runs`).set(as(viewer)).send({ environmentId: fixture.environmentId })).status, 403);
    });
    (0, node_test_1.test)("un token de CI sí puede lanzar una corrida", async () => {
        // That is the point of a service credential: a pipeline keeps the matrix running without a
        // person logging in.
        const created = await api().post(`${base}/tokens`).set(as(owner)).send({ name: "CI" });
        const started = await api().post(`${fixture.projectBase}/runs`).set({ Authorization: `Bearer ${created.body.token}` }).send({ environmentId: fixture.environmentId });
        strict_1.default.equal(started.status, 202);
        await context.queue.idle();
    });
    (0, node_test_1.test)("un entorno de otro proyecto es 404", async () => {
        const other = await projectAgainst({});
        const response = await api().post(`${fixture.projectBase}/runs`).set(as(owner)).send({ environmentId: other.environmentId });
        strict_1.default.equal(response.status, 404);
        await other.target.stop();
    });
    (0, node_test_1.test)("un proyecto sin contrato no puede lanzar corridas", async () => {
        // 409 and not 404: the project exists and the caller may see it — what is missing is the
        // contract, and saying so is more useful than pretending the project is not there.
        const bare = await api().post(`${base}/projects`).set(as(owner)).send({ name: "sin contrato" });
        const response = await api().post(`${base}/projects/${bare.body.projectId}/runs`).set(as(owner)).send({ environmentId: fixture.environmentId });
        strict_1.default.equal(response.status, 409);
        strict_1.default.match(response.body.type, /no-active-spec$/);
    });
});
//# sourceMappingURL=runs.test.js.map