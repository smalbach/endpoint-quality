/**
 * Copiar entre proyectos y exportar: bifurcar un proyecto con contrato, ejemplos, autenticación
 * con secreto y credenciales; traer elementos sueltos de otro proyecto con lo que se rompe por el
 * camino; y los ficheros propios y de Postman con lo que no siempre está.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { blankChannel, MAX_CHANNELS_PER_PROJECT } from "@/modules/channels/domain/model";
import type { WorkflowRow } from "@/modules/workflows/domain/model";
import { createTestApp, type TestContext } from "../support/test-app";
import { STUB_SPEC_YAML } from "../support/stub-target";
import { SHOP_FILES } from "../support/grpc-server";

let context: TestContext;
const api = () => request(context.app.getHttpServer());
let token: string;
let organizationId: string;
const auth = () => ({ Authorization: `Bearer ${token}` });
const org = () => `/orgs/${organizationId}/projects`;
const unique = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
const at = new Date("2026-01-01T00:00:00.000Z");

before(async () => {
  context = await createTestApp();
  const email = "proj-cov-copy@example.com";
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  organizationId = registered.body.organizationId;
  token = (await api().post("/auth/login").send({ email, password })).body.accessToken;
});
after(async () => {
  await context?.close();
});

async function ok(response: request.Response | Promise<request.Response>): Promise<request.Response> {
  const settled = await response;
  assert.ok(settled.status < 300, `${settled.status} ${JSON.stringify(settled.body)}`);
  return settled;
}
async function newProject(body: Record<string, unknown> = {}): Promise<{ id: string; base: string }> {
  const created = await ok(api().post(org()).set(auth()).send({ name: unique("p"), ...body }));
  return { id: created.body.projectId, base: `${org()}/${created.body.projectId}` };
}
const workflow = (projectId: string, name: string, steps: unknown[]): WorkflowRow => ({
  id: randomUUID(),
  projectId,
  name,
  description: null,
  status: "ready",
  definition: { steps } as WorkflowRow["definition"],
  createdAt: at,
  updatedAt: at,
  updatedBy: "t",
  deletedAt: null,
});
const example = {
  name: "ok",
  request: { method: "GET", url: "https://api.test/orders", headers: [], body: { text: "", contentType: "" } },
  response: { status: 200, headers: [], body: "[]", contentType: "application/json", durationMs: 3 },
};

describe("bifurcar un proyecto completo", () => {
  test("sin nombre se llama como el original; el contrato, los ejemplos y los sub-flujos viajan; lo secreto no", async () => {
    const parent = await newProject({ auth: { type: "bearer", token: "secreto-del-proyecto" } });
    const parentRow = (await context.repositories.projects.findById(parent.id))!;
    await ok(
      api().post(`${parent.base}/spec-versions`).set(auth()).send({ source: { kind: "inline", raw: STUB_SPEC_YAML } }),
    );
    const endpoint = await ok(api().post(`${parent.base}/endpoints`).set(auth()).send({ method: "GET", path: "/propio" }));
    const endpointId = (endpoint.body.id ?? endpoint.body.endpointId) as string;
    await ok(api().post(`${parent.base}/endpoints/${endpointId}/examples`).set(auth()).send(example));

    const child = workflow(parent.id, "Hijo", [{ id: "a", requestTemplateId: "plantilla-que-no-existe" }]);
    const main = workflow(parent.id, "Principal", [
      { id: "sub", kind: "subflow", subflow: { workflowId: child.id } },
      { id: "fuera", kind: "subflow", subflow: { workflowId: "flujo-de-otro-sitio" } },
    ]);
    await context.repositories.workflows.saveWorkflow(child);
    await context.repositories.workflows.saveWorkflow(main);

    const environment = await ok(
      api().post(`${parent.base}/environments`).set(auth()).send({ name: "staging", baseUrl: "https://s.test" }),
    );
    await ok(
      api()
        .put(`${parent.base}/environments/${environment.body.environmentId}/credentials`)
        .set(auth())
        .send({ name: "Admin", role: "primary", kind: "bearer", secret: "token-del-admin" }),
    );

    const forked = await ok(api().post(`${parent.base}/fork`).set(auth()).send({}));
    const result = forked.body as { projectId: string; copied: Record<string, number>; skipped: { what: string; detail: string }[] };
    const fork = (await context.repositories.projects.findById(result.projectId))!;
    assert.equal(fork.name, `${parentRow.name} (bifurcación)`);
    assert.equal(fork.auth.type, "bearer");
    assert.equal(fork.auth.secretCiphertext, null);
    assert.ok(!JSON.stringify(fork.auth).includes("secreto-del-proyecto"));

    const what = (kind: string) => result.skipped.filter((entry) => entry.what === kind).map((entry) => entry.detail);
    assert.deepEqual(what("autenticación"), ["la del proyecto llega sin su secreto: hay que volver a escribirlo"]);
    assert.deepEqual(what("credencial"), ["staging: hay que volver a crear las de primary"]);
    assert.deepEqual(what("paso"), ["Hijo: a apunta a una prueba que no existe en el origen"]);

    // El contrato es una copia propia, con sus operaciones.
    assert.ok(fork.activeSpecVersionId);
    assert.notEqual(fork.activeSpecVersionId, parentRow.activeSpecVersionId ?? "x");
    const operations = await context.repositories.specs.listOperations(fork.activeSpecVersionId!);
    assert.ok(operations.some((operation) => operation.id === "listThings"));

    // El ejemplo cuelga del endpoint copiado.
    const copied = (await context.repositories.endpoints.listAll(fork.id)).find((row) => row.path === "/propio")!;
    const examples = await context.repositories.examples.listByEndpoint(fork.id, copied.id);
    assert.deepEqual(
      examples.map((row) => row.name),
      ["ok"],
    );

    // El sub-flujo apunta al hijo copiado; el que no era del proyecto se queda como estaba.
    const flows = await context.repositories.workflows.listWorkflows(fork.id);
    const copiedChild = flows.find((row) => row.name === "Hijo")!;
    const copiedMain = flows.find((row) => row.name === "Principal")!;
    assert.equal(copiedMain.definition.steps[0]!.subflow!.workflowId, copiedChild.id);
    assert.equal(copiedMain.definition.steps[1]!.subflow!.workflowId, "flujo-de-otro-sitio");
    assert.equal(copiedChild.definition.steps[0]!.requestTemplateId, "plantilla-que-no-existe");
  });
});

describe("traer elementos de otro proyecto", () => {
  test("un proyecto que pasaría del máximo de canales no recibe nada", async () => {
    const source = await newProject();
    const target = await newProject();
    const channel = blankChannel({ id: randomUUID(), projectId: source.id, name: "eco", url: "wss://e.test", now: at, by: "t" });
    await context.repositories.channels.save(channel);
    const flow = workflow(source.id, "Con canal", [{ id: "c", kind: "channel", channel: { channelId: channel.id } }]);
    await context.repositories.workflows.saveWorkflow(flow);
    for (let index = 0; index < MAX_CHANNELS_PER_PROJECT; index++) {
      await context.repositories.channels.save(
        blankChannel({ id: randomUUID(), projectId: target.id, name: `c${index}`, url: "wss://x.test", now: at, by: "t" }),
      );
    }
    const response = await api()
      .post(`${target.base}/import-elements`)
      .set(auth())
      .send({ sourceProjectId: source.id, workflowIds: [flow.id] });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.match(String(response.body.type), /channels-full$/);
    assert.deepEqual(await context.repositories.workflows.listWorkflows(target.id), []);
  });

  test("ciclos, canales que ya no están, flujos que caen en cadena, nombres ocupados y secretos", async () => {
    const source = await newProject();
    const target = await newProject();

    // Canales del origen: uno con un secreto en una cabecera (una fila de antes de la regla) y uno
    // gRPC con sus .proto. El destino ya tiene un «eco».
    const eco = {
      ...blankChannel({ id: randomUUID(), projectId: source.id, name: "eco", url: "wss://e.test", now: at, by: "t" }),
      headers: [{ name: "Authorization", value: "Bearer literal", enabled: true }],
    };
    const tienda = blankChannel({
      id: randomUUID(),
      projectId: source.id,
      name: "tienda",
      url: "grpc://127.0.0.1:50051",
      now: at,
      by: "t",
      protocol: "grpc",
    });
    await context.repositories.channels.save(eco);
    await context.repositories.channels.save(tienda);
    await context.repositories.channelProtos.replace(tienda.id, SHOP_FILES);
    await context.repositories.channels.save(
      blankChannel({ id: randomUUID(), projectId: target.id, name: "eco", url: "wss://otro.test", now: at, by: "t" }),
    );

    const template = await ok(
      api().post(`${source.base}/request-templates`).set(auth()).send({ name: "Listar", operationId: "x", expectedStatus: 200 }),
    );
    await ok(
      api().post(`${target.base}/request-templates`).set(auth()).send({ name: "Listar", operationId: "y", expectedStatus: 200 }),
    );

    // A y B se llaman entre sí; C usa un canal borrado; D ejecuta C y cae con él.
    const a = workflow(source.id, "A", []);
    const b = workflow(source.id, "B", []);
    a.definition = {
      steps: [
        { id: "t", requestTemplateId: template.body.requestTemplateId },
        { id: "b", kind: "subflow", subflow: { workflowId: b.id } },
        { id: "eco", kind: "channel", channel: { channelId: eco.id } },
        { id: "grpc", kind: "channel", channel: { channelId: tienda.id } },
      ],
    } as WorkflowRow["definition"];
    b.definition = { steps: [{ id: "a", kind: "subflow", subflow: { workflowId: a.id } }] } as WorkflowRow["definition"];
    const c = workflow(source.id, "C", [{ id: "roto", kind: "channel", channel: { channelId: "canal-borrado" } }]);
    const d = workflow(source.id, "D", [{ id: "sub", kind: "subflow", subflow: { workflowId: c.id } }]);
    for (const row of [a, b, c, d]) await context.repositories.workflows.saveWorkflow(row);
    await context.repositories.workflows.saveDataset({
      id: randomUUID(),
      projectId: source.id,
      workflowId: a.id,
      name: "filas",
      rows: [{ x: "1" }],
      createdAt: at,
      updatedAt: at,
      updatedBy: "t",
      archivedAt: null,
      deletedAt: null,
    });
    await ok(api().post(`${target.base}/workflows`).set(auth()).send({ name: "A", definition: { steps: [] } }));

    // Endpoints y entornos, con choques.
    const orders = await ok(api().post(`${source.base}/endpoints`).set(auth()).send({ method: "GET", path: "/orders" }));
    await ok(api().post(`${target.base}/endpoints`).set(auth()).send({ method: "GET", path: "/orders" }));
    const staging = await ok(
      api()
        .post(`${source.base}/environments`)
        .set(auth())
        .send({
          name: "staging",
          baseUrl: "https://s.test",
          disabledVariables: { viejo: { initial: "s", current: "s", sensitive: true } },
        }),
    );
    await ok(api().post(`${target.base}/environments`).set(auth()).send({ name: "staging", baseUrl: "https://t.test" }));

    const response = await ok(
      api()
        .post(`${target.base}/import-elements`)
        .set(auth())
        .send({
          sourceProjectId: source.id,
          workflowIds: [a.id, c.id, d.id, randomUUID()],
          endpointIds: [orders.body.id ?? orders.body.endpointId],
          environmentIds: [staging.body.environmentId],
        }),
    );
    const result = response.body as {
      endpoints: number;
      workflows: number;
      environments: number;
      channels: number;
      skipped: { what: string; detail: string }[];
    };
    assert.equal(result.endpoints, 0);
    assert.equal(result.workflows, 2);
    assert.equal(result.channels, 2);
    assert.equal(result.environments, 1);
    const details = result.skipped.map((entry) => entry.detail);
    for (const expected of [
      "GET /orders ya existe",
      "eco (2): llega sin sus secretos, hay que volver a escribirlos",
      "C: el nodo «roto» abre un canal que ya no existe en el origen",
      "D: el sub-flujo «sub» ejecuta un flujo que no se ha podido traer",
      "staging (2): hay que reescribir viejo",
    ])
      assert.ok(details.includes(expected), `falta «${expected}» en ${JSON.stringify(details)}`);

    const flows = await context.repositories.workflows.listWorkflows(target.id);
    assert.deepEqual(flows.map((row) => row.name).sort(), ["A", "A (2)", "B"]);
    const newA = flows.find((row) => row.name === "A (2)")!;
    const newB = flows.find((row) => row.name === "B")!;
    assert.equal(newA.definition.steps[1]!.subflow!.workflowId, newB.id);
    assert.equal(newB.definition.steps[0]!.subflow!.workflowId, newA.id);
    const templates = await context.repositories.workflows.listTemplates(target.id);
    const copiedTemplate = templates.find((row) => row.name === "Listar (2)")!;
    assert.equal(newA.definition.steps[0]!.requestTemplateId, copiedTemplate.id);
    const datasets = await context.repositories.workflows.listDatasets(target.id);
    assert.deepEqual(
      datasets.map((row) => [row.workflowId, row.name]),
      [[newA.id, "filas"]],
    );

    const channels = await context.repositories.channels.listByProject(target.id);
    const copiedEco = channels.find((row) => row.name === "eco (2)")!;
    assert.equal(copiedEco.headers[0]!.value, "");
    const copiedGrpc = channels.find((row) => row.name === "tienda")!;
    assert.equal((await context.repositories.channelProtos.list(copiedGrpc.id)).length, SHOP_FILES.length);
    assert.equal(newA.definition.steps[2]!.channel!.channelId, copiedEco.id);

    const environments = await context.repositories.environments.listForProject(target.id);
    const copiedEnv = environments.find((row) => row.name === "staging (2)")!;
    assert.deepEqual(copiedEnv.disabledVariables.viejo, { initial: "", current: "", sensitive: true });
    assert.equal(copiedEnv.writesAllowed, false);

    // La vista previa enseña los flujos del origen con su número de nodos.
    const preview = await ok(api().get(`${target.base}/import-preview?sourceProjectId=${source.id}`).set(auth()));
    const previewA = (preview.body.workflows as { id: string; steps: number }[]).find((row) => row.id === a.id)!;
    assert.equal(previewA.steps, 4);
  });
});

describe("los ficheros de exportación", () => {
  test("el propio lleva ejemplos agrupados, reglas entre roles, planes y canales de cada protocolo", async () => {
    const project = await newProject();
    const endpoint = await ok(api().post(`${project.base}/endpoints`).set(auth()).send({ method: "GET", path: "/orders" }));
    const endpointId = (endpoint.body.id ?? endpoint.body.endpointId) as string;
    await ok(api().post(`${project.base}/endpoints/${endpointId}/examples`).set(auth()).send(example));
    await ok(
      api()
        .post(`${project.base}/endpoints/${endpointId}/examples`)
        .set(auth())
        .send({ ...example, name: "vacío", response: { ...example.response, status: 204, body: "" } }),
    );
    const admin = await ok(api().post(`${project.base}/roles`).set(auth()).send({ name: "admin" }));
    const lector = await ok(api().post(`${project.base}/roles`).set(auth()).send({ name: "lector" }));
    await ok(
      api()
        .put(`${project.base}/roles/${admin.body.id}/permissions`)
        .set(auth())
        .send({ permissions: [{ endpointId, access: "allow" }] }),
    );
    await ok(
      api()
        .put(`${project.base}/role-rules`)
        .set(auth())
        .send({
          rules: [{ sourceRoleId: admin.body.id, targetRoleId: lector.body.id, canRead: true, canWrite: false, canDelete: true }],
        }),
    );
    await ok(
      api()
        .post(`${project.base}/performance/plans`)
        .set(auth())
        .send({
          name: "Carga",
          definition: {
            scenarios: [{ id: "l", name: "L", weight: 1, thinkMs: 0, requests: [{ method: "GET", path: "/orders" }] },
            ],
            profile: { type: "constant", vus: 1, durationS: 1 },
            thresholds: {},
          },
        }),
    );
    for (const protocol of ["mqtt", "grpc", "socketio"] as const) {
      await context.repositories.channels.save(
        blankChannel({ id: randomUUID(), projectId: project.id, name: protocol, url: `${protocol === "mqtt" ? "mqtt" : "wss"}://h.test`, now: at, by: "t", protocol }),
      );
    }

    const exported = await ok(api().get(`${project.base}/export`).set(auth()));
    const bundle = exported.body;
    assert.deepEqual(
      bundle.endpoints[0].examples.map((row: { name: string }) => row.name).sort(),
      ["ok", "vacío"],
    );
    const exportedAdmin = bundle.roles.find((role: { name: string }) => role.name === "admin");
    assert.deepEqual(exportedAdmin.permissions, [{ method: "GET", path: "/orders", access: "allow", dataScope: "all" }]);
    assert.deepEqual(bundle.roleRules, [{ source: "admin", target: "lector", canRead: true, canWrite: false, canDelete: true }]);
    assert.deepEqual(
      bundle.performance.map((plan: { name: string }) => plan.name),
      ["Carga"],
    );
    const byProtocol = Object.fromEntries(
      (bundle.flows.channels as Record<string, unknown>[]).map((row) => [row.protocol as string, row]),
    );
    assert.ok(byProtocol.mqtt!.mqtt);
    assert.ok(byProtocol.grpc!.grpc);
    assert.ok(byProtocol.socketio!.socketio);
    assert.equal("mqtt" in byProtocol.grpc!, false);
    // Sin contrato activo, las peticiones no dicen método ni ruta, y no hay contrato en el fichero.
    assert.equal(bundle.contract, undefined);
  });

  test("Postman: sin `kind` sale la colección; varios entornos salen como volcado; un nombre sin letras es «proyecto»", async () => {
    const project = await newProject({ name: "¡¡¡" });
    for (const name of ["uno", "dos"]) {
      await ok(api().post(`${project.base}/environments`).set(auth()).send({ name, baseUrl: `https://${name}.test` }));
    }
    const collection = await ok(api().get(`${project.base}/export/postman`).set(auth()));
    assert.equal(collection.body.kind, "collection");
    assert.equal(collection.body.filename, "proyecto.postman_collection.json");
    const blank = await ok(api().get(`${project.base}/export/postman?kind=`).set(auth()));
    assert.equal(blank.body.kind, "collection");

    const environments = await ok(api().get(`${project.base}/export/postman?kind=environments`).set(auth()));
    assert.equal(environments.body.filename, "proyecto.postman_environments.json");
    assert.deepEqual(environments.body.counts, { collections: 0, environments: 2 });
    assert.deepEqual(environments.body.file.collections, []);
    assert.equal(environments.body.file.environments.length, 2);

    // Con un solo entorno, el fichero es ese entorno y no un volcado.
    const single = await newProject();
    await ok(api().post(`${single.base}/environments`).set(auth()).send({ name: "solo", baseUrl: "https://solo.test" }));
    const one = await ok(api().get(`${single.base}/export/postman?kind=environments`).set(auth()));
    assert.equal(one.body.file.name, "solo");
    assert.equal(one.body.file._postman_variable_scope, "environment");

    const unknown = await api().get(`${project.base}/export/postman?kind=pdf`).set(auth());
    assert.equal(unknown.status, 422);
    assert.match(String(unknown.body.type), /unknown-postman-kind$/);
  });
});
