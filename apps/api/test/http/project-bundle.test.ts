/**
 * Exporting a project to a file and importing that file into another project.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { organizationId: string; token: string };
async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  const session = await api().post("/auth/login").send({ email, password });
  return { organizationId: registered.body.organizationId, token: session.body.accessToken };
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

let owner: Actor;
let source: string;
let childId: string;
let parentId: string;
let templateId: string;
const org = () => `/orgs/${owner.organizationId}`;

async function newProject(name: string): Promise<string> {
  const created = await api()
    .post(`${org()}/projects`)
    .set(as(owner))
    .send({ name, baseUrl: "https://api.origen.test", tags: ["v1"] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return `${org()}/projects/${created.body.projectId}`;
}

async function created(response: request.Response): Promise<request.Response> {
  assert.ok(response.status < 300, `${response.status} ${JSON.stringify(response.body)}`);
  return response;
}

before(async () => {
  context = await createTestApp();
  owner = await signUp("bundle@example.com");
  source = await newProject("Origen");

  await created(await api().post(`${source}/endpoints`).set(as(owner)).send({ method: "GET", path: "/orders" }));
  const endpoints = (await api().get(`${source}/endpoints`).set(as(owner))).body.data as { id: string }[];
  await created(await api().post(`${source}/roles`).set(as(owner)).send({ name: "vendedor" }));
  const [seller] = (await api().get(`${source}/roles`).set(as(owner))).body as { id: string }[];
  await created(
    await api()
      .put(`${source}/roles/${seller!.id}/permissions`)
      .set(as(owner))
      .send({ permissions: [{ endpointId: endpoints[0]!.id, access: "allow", dataScope: "own" }] }),
  );

  const template = await created(
    await api()
      .post(`${source}/request-templates`)
      .set(as(owner))
      .send({ name: "Listar", operationId: "listOrders", expectedStatus: 200 }),
  );
  templateId = template.body.requestTemplateId;
  const child = await created(
    await api()
      .post(`${source}/workflows`)
      .set(as(owner))
      .send({ name: "Hijo", definition: { steps: [{ id: "listar", requestTemplateId: templateId }] } }),
  );
  childId = child.body.workflowId;
  const parent = await created(
    await api()
      .post(`${source}/workflows`)
      .set(as(owner))
      .send({ name: "Padre", definition: { steps: [{ id: "hijo", kind: "subflow", subflow: { workflowId: childId } }] } }),
  );
  parentId = parent.body.workflowId;
  await created(
    await api()
      .post(`${source}/workflows/${childId}/datasets`)
      .set(as(owner))
      .send({ name: "pedidos", rows: [{ sku: "A-1" }] }),
  );
  await created(await api().post(`${source}/suites`).set(as(owner)).send({ name: "Release", workflowIds: [childId] }));

  await created(
    await api()
      .post(`${source}/environments`)
      .set(as(owner))
      .send({
        name: "staging",
        baseUrl: "https://s.example.com",
        variables: { host: "s.example.com", token: { initial: "muy-secreto-123", sensitive: true } },
      }),
  );
  await created(
    await api()
      .post(`${source}/performance/plans`)
      .set(as(owner))
      .send({
        name: "Carga",
        definition: {
          scenarios: [
            { id: "leer", name: "Leer", weight: 1, thinkMs: 0, requests: [{ method: "GET", path: "/orders" }] },
          ],
          profile: { type: "constant", vus: 1, durationS: 1 },
          thresholds: {},
        },
      }),
  );
});

after(async () => {
  await context?.close();
});

describe("exportar e importar un proyecto como fichero", () => {
  test("el fichero lleva todo menos los secretos, y se importa con ids nuevos", async () => {
    const exported = await api().get(`${source}/export`).set(as(owner));
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    const bundle = exported.body;
    assert.equal(bundle.format, "endpoint-quality/project");
    assert.equal(bundle.version, 1);
    assert.equal(bundle.endpoints.length, 1);
    assert.equal(bundle.roles[0].permissions[0].path, "/orders");
    assert.equal(bundle.flows.workflows.length, 2);
    assert.equal(bundle.flows.suites.length, 1);
    assert.equal(bundle.performance.length, 1);
    // Ningún secreto sale en el fichero: la variable sensible viaja con su nombre y vacía.
    assert.ok(!JSON.stringify(bundle).includes("muy-secreto-123"));
    assert.deepEqual(bundle.environments[0].variables.token, { initial: "", current: "", sensitive: true });

    const target = await newProject("Destino");
    const imported = await api().post(`${target}/import-bundle`).set(as(owner)).send({ bundle });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    const result = imported.body;
    assert.equal(result.settings, true);
    assert.equal(result.endpoints, 1);
    assert.equal(result.roles, 1);
    assert.equal(result.permissions, 1);
    assert.equal(result.requestTemplates, 1);
    assert.equal(result.workflows, 2);
    assert.equal(result.datasets, 1);
    assert.equal(result.suites, 1);
    assert.equal(result.environments, 1);
    assert.equal(result.performancePlans, 1);
    assert.ok(result.skipped.some((entry: { what: string; detail: string }) => entry.what === "secreto" && /token/.test(entry.detail)));

    const flows = (await api().get(`${target}/workflows`).set(as(owner))).body;
    const newTemplate = flows.requestTemplates[0];
    assert.notEqual(newTemplate.id, templateId);
    const child = flows.workflows.find((row: { name: string }) => row.name === "Hijo");
    const parent = flows.workflows.find((row: { name: string }) => row.name === "Padre");
    assert.notEqual(child.id, childId);
    assert.equal(child.steps[0].requestTemplateId, newTemplate.id);
    // El sub-flujo apunta al hijo importado, no al del proyecto de origen.
    assert.equal(parent.steps[0].subflow.workflowId, child.id);
    assert.deepEqual(flows.suites[0].workflowIds, [child.id]);

    const roles = (await api().get(`${target}/roles`).set(as(owner))).body;
    assert.equal(roles[0].name, "vendedor");
    const environments = (await api().get(`${target}/environments`).set(as(owner))).body;
    assert.equal(environments[0].writesAllowed, false);
    const plans = (await api().get(`${target}/performance/plans`).set(as(owner))).body;
    assert.equal(plans.length, 1);

    // Importar el mismo fichero otra vez no duplica el endpoint y numera los nombres repetidos.
    const again = await api().post(`${target}/import-bundle`).set(as(owner)).send({ bundle, parts: ["endpoints", "flows"] });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.endpoints, 0);
    assert.deepEqual(again.body.parts, ["endpoints", "flows"]);
    const names = (await api().get(`${target}/workflows`).set(as(owner))).body.workflows.map((row: { name: string }) => row.name);
    assert.ok(names.includes("Hijo (2)"), JSON.stringify(names));
  });

  test("exportar un flujo lleva sus sub-flujos y peticiones, sin suites ni lo demás", async () => {
    const exported = await api().get(`${source}/export?parts=flows&workflowIds=${parentId}`).set(as(owner));
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    assert.equal(exported.body.endpoints, undefined);
    assert.equal(exported.body.flows.workflows.length, 2);
    assert.equal(exported.body.flows.requestTemplates.length, 1);
    assert.equal(exported.body.flows.suites.length, 0);

    const missing = await api().get(`${source}/export?parts=flows&workflowIds=${crypto.randomUUID()}`).set(as(owner));
    assert.equal(missing.status, 404);
    const unknown = await api().get(`${source}/export?parts=secretos`).set(as(owner));
    assert.equal(unknown.status, 422);
  });

  test("un fichero inválido se rechaza entero y no escribe nada", async () => {
    const target = await newProject("Vacío");
    const foreign = await api().post(`${target}/import-bundle`).set(as(owner)).send({ bundle: { format: "otra-cosa" } });
    assert.equal(foreign.status, 422);

    const broken = {
      format: "endpoint-quality/project",
      version: 1,
      endpoints: [{ method: "GET", path: "/ok" }],
      flows: {
        requestTemplates: [],
        workflows: [{ id: "f1", name: "Roto", definition: { steps: [{ id: "a", requestTemplateId: "no-esta" }] } }],
      },
    };
    const refused = await api().post(`${target}/import-bundle`).set(as(owner)).send({ bundle: broken });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.ok(refused.body.errors.some((error: { field: string }) => error.field.includes("requestTemplateId")));
    const endpoints = (await api().get(`${target}/endpoints`).set(as(owner))).body.data;
    assert.equal(endpoints.length, 0);

    const newer = await api()
      .post(`${target}/import-bundle`)
      .set(as(owner))
      .send({ bundle: { format: "endpoint-quality/project", version: 2 } });
    assert.equal(newer.status, 422);
  });
});
