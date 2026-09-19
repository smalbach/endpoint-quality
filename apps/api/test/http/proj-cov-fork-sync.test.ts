/**
 * Traer los borrados del original a una bifurcación, y las guardas que los frenan.
 *
 * Las pruebas de `project-forks.test.ts` llevan cambios y altas; aquí van las bajas: un endpoint,
 * un flujo con su dataset, un entorno activo, un rol con sus reglas y una sección que desaparecen
 * del original, y lo que la bifurcación no deja borrar porque algo suyo lo sigue usando. También el
 * original que ya no está, los secretos de un entorno y la cabecera de un canal que se conserva.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { organizationId: string; token: string };
let owner: Actor;
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });
const org = () => `/orgs/${owner.organizationId}/projects`;
const unique = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

before(async () => {
  context = await createTestApp();
  const password = "Una-contraseña-larga-1";
  const email = "proj-cov-fork-sync@example.com";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  const session = await api().post("/auth/login").send({ email, password });
  owner = { organizationId: registered.body.organizationId, token: session.body.accessToken };
});
after(async () => {
  await context?.close();
});

async function ok(response: request.Response | Promise<request.Response>): Promise<request.Response> {
  const settled = await response;
  assert.ok(settled.status < 300, `${settled.status} ${JSON.stringify(settled.body)}`);
  return settled;
}
async function newProject(): Promise<{ id: string; base: string }> {
  const created = await ok(api().post(org()).set(as(owner)).send({ name: unique("original") }));
  return { id: created.body.projectId, base: `${org()}/${created.body.projectId}` };
}
async function forkOf(parentId: string): Promise<{ id: string; base: string }> {
  const forked = await ok(api().post(`${org()}/${parentId}/fork`).set(as(owner)).send({ name: unique("bif") }));
  return { id: forked.body.projectId, base: `${org()}/${forked.body.projectId}` };
}
async function pull(base: string, resolutions: Record<string, string> = {}) {
  const diff = await ok(api().get(`${base}/fork/pull`).set(as(owner)));
  const applied = await ok(api().post(`${base}/fork/pull`).set(as(owner)).send({ token: diff.body.token, resolutions }));
  return { diff: diff.body, result: applied.body as { applied: Record<string, number>; skipped: { what: string; detail: string }[] } };
}

describe("los borrados del original llegan a la bifurcación", () => {
  test("endpoint, flujo con dataset, entorno activo, rol con reglas y sección; salvo lo que algo usa", async () => {
    const parent = await newProject();
    const users = await ok(api().post(`${parent.base}/endpoints`).set(as(owner)).send({ method: "GET", path: "/users" }));
    await ok(api().post(`${parent.base}/endpoints`).set(as(owner)).send({ method: "GET", path: "/orders" }));
    const template = await ok(
      api()
        .post(`${parent.base}/request-templates`)
        .set(as(owner))
        .send({ name: "Listar", operationId: "listOrders", expectedStatus: 200 }),
    );
    const templateId = template.body.requestTemplateId as string;
    const pedidos = await ok(
      api()
        .post(`${parent.base}/workflows`)
        .set(as(owner))
        .send({ name: "Pedidos", definition: { steps: [{ id: "a", requestTemplateId: templateId }] } }),
    );
    const otro = await ok(
      api()
        .post(`${parent.base}/workflows`)
        .set(as(owner))
        .send({ name: "Otro", definition: { steps: [{ id: "a", requestTemplateId: templateId }] } }),
    );
    await ok(
      api()
        .post(`${parent.base}/workflows/${otro.body.workflowId}/datasets`)
        .set(as(owner))
        .send({ name: "filas", rows: [{ sku: "A" }] }),
    );
    const staging = await ok(
      api()
        .post(`${parent.base}/environments`)
        .set(as(owner))
        .send({ name: "staging", baseUrl: "https://s.example.com" }),
    );
    await ok(api().post(`${parent.base}/environments/${staging.body.environmentId}/activate`).set(as(owner)));
    const admin = await ok(api().post(`${parent.base}/roles`).set(as(owner)).send({ name: "admin" }));
    const lector = await ok(api().post(`${parent.base}/roles`).set(as(owner)).send({ name: "lector" }));
    await ok(
      api()
        .put(`${parent.base}/role-rules`)
        .set(as(owner))
        .send({
          rules: [
            { sourceRoleId: admin.body.id, targetRoleId: lector.body.id, canRead: true, canWrite: false, canDelete: false },
            { sourceRoleId: lector.body.id, targetRoleId: admin.body.id, canRead: true, canWrite: false, canDelete: false },
          ],
        }),
    );
    await ok(api().put(`${parent.base}/config/budgets`).set(as(owner)).send({ budgets: [] }));

    const fork = await forkOf(parent.id);
    const forkProject = (await context.repositories.projects.findById(fork.id))!;
    assert.ok(forkProject.activeEnvironmentId, "la bifurcación nace con el entorno activo del original");
    assert.equal((await context.repositories.roles.listRules(fork.id)).length, 2);

    // La bifurcación usa cosas que el original va a borrar: una suite suya con «Pedidos» y un flujo
    // suyo con la prueba «Listar».
    const [forkTemplate] = await context.repositories.workflows.listTemplates(fork.id);
    const forkFlows = await context.repositories.workflows.listWorkflows(fork.id);
    const forkPedidos = forkFlows.find((row) => row.name === "Pedidos")!;
    await ok(
      api()
        .post(`${fork.base}/workflows`)
        .set(as(owner))
        .send({ name: "Mío", definition: { steps: [{ id: "a", requestTemplateId: forkTemplate!.id }] } }),
    );
    await ok(api().post(`${fork.base}/suites`).set(as(owner)).send({ name: "Propia", workflowIds: [forkPedidos.id] }));

    // El original borra.
    await ok(api().delete(`${parent.base}/endpoints/${users.body.id ?? users.body.endpointId}`).set(as(owner)));
    await ok(api().delete(`${parent.base}/workflows/${otro.body.workflowId}`).set(as(owner)));
    await ok(api().delete(`${parent.base}/workflows/${pedidos.body.workflowId}`).set(as(owner)));
    await ok(api().delete(`${parent.base}/request-templates/${templateId}`).set(as(owner)));
    await ok(api().delete(`${parent.base}/environments/${staging.body.environmentId}`).set(as(owner)));
    await ok(api().delete(`${parent.base}/roles/${lector.body.id}`).set(as(owner)));
    await ok(api().delete(`${parent.base}/config/budgets`).set(as(owner)));

    const { diff, result } = await pull(fork.base);
    const deleted = (diff.entries as { kind: string; sourceChange: string }[])
      .filter((entry) => entry.sourceChange === "deleted")
      .map((entry) => entry.kind)
      .sort();
    for (const kind of ["endpoint", "environment", "role", "section", "template", "workflow"])
      assert.ok(deleted.includes(kind), `falta el borrado de ${kind}: ${deleted.join(", ")}`);

    const details = result.skipped.map((entry) => entry.detail);
    assert.ok(details.includes("Pedidos: no se borró, la suite Propia lo usa"), JSON.stringify(details));
    assert.ok(details.includes("Listar: no se borró, un flujo la usa"), JSON.stringify(details));

    // Lo que se borró, borrado.
    const endpoints = await context.repositories.endpoints.listAll(fork.id);
    assert.deepEqual(endpoints.map((row) => row.path), ["/orders"]);
    const flows = (await context.repositories.workflows.listWorkflows(fork.id)).map((row) => row.name).sort();
    assert.deepEqual(flows, ["Mío", "Pedidos"]);
    assert.deepEqual(await context.repositories.workflows.listDatasets(fork.id), []);
    assert.equal((await context.repositories.workflows.listTemplates(fork.id)).length, 1);
    assert.deepEqual(await context.repositories.environments.listForProject(fork.id), []);
    // El entorno activo ya no existe: el proyecto se queda sin ninguno, no apuntando a nada.
    assert.equal((await context.repositories.projects.findById(fork.id))!.activeEnvironmentId, null);
    const roles = await context.repositories.roles.list(fork.id);
    assert.deepEqual(roles.map((row) => row.name), ["admin"]);
    // Las reglas hacia o desde el rol que se fue se van con él.
    assert.deepEqual(await context.repositories.roles.listRules(fork.id), []);
    assert.equal(await context.repositories.config.findSection(fork.id, "budgets"), null);
    const access = (await context.repositories.config.findSection(fork.id, "access"))?.data as {
      access: { roles: string[] };
    };
    assert.deepEqual(access.access.roles, ["admin"]);

    // Y la siguiente comparación ya no trae borrados.
    const again = await ok(api().get(`${fork.base}/fork/pull`).set(as(owner)));
    assert.ok(
      !(again.body.entries as { sourceChange: string; status: string }[]).some(
        (entry) => entry.sourceChange === "deleted" && entry.status === "incoming",
      ),
      JSON.stringify(again.body.entries),
    );
  });

  test("un rol que llega con reglas trae las que tienen destino y dice las que no", async () => {
    const parent = await newProject();
    const peon = await ok(api().post(`${parent.base}/roles`).set(as(owner)).send({ name: "peon" }));
    const withBoth = await forkOf(parent.id);
    const withoutPeon = await forkOf(parent.id);
    const [gone] = await context.repositories.roles.list(withoutPeon.id);
    await ok(api().delete(`${withoutPeon.base}/roles/${gone!.id}`).set(as(owner)));

    await ok(api().patch(`${parent.base}/roles/${peon.body.id}`).set(as(owner)).send({ color: "#10b981" }));
    const jefe = await ok(api().post(`${parent.base}/roles`).set(as(owner)).send({ name: "jefe" }));
    await ok(
      api()
        .put(`${parent.base}/role-rules`)
        .set(as(owner))
        .send({
          rules: [
            { sourceRoleId: jefe.body.id, targetRoleId: peon.body.id, canRead: true, canWrite: true, canDelete: false },
          ],
        }),
    );

    // Con los dos roles: la regla llega apuntando a los de la bifurcación.
    await pull(withBoth.base);
    const [rule, ...more] = await context.repositories.roles.listRules(withBoth.id);
    assert.equal(more.length, 0);
    const byName = Object.fromEntries((await context.repositories.roles.list(withBoth.id)).map((row) => [row.name, row.id]));
    assert.deepEqual([rule!.sourceRoleId, rule!.targetRoleId, rule!.canWrite], [byName.jefe, byName.peon, true]);

    // El conflicto de «peon» (borrado aquí, cambiado allí) lo gana la bifurcación: la regla de
    // «jefe» se queda sin destino, y se dice.
    const diff = (await ok(api().get(`${withoutPeon.base}/fork/pull`).set(as(owner)))).body;
    const conflict = (diff.entries as { kind: string; key: string; status: string }[]).find(
      (entry) => entry.kind === "role" && entry.status === "conflict",
    )!;
    const applied = await ok(
      api()
        .post(`${withoutPeon.base}/fork/pull`)
        .set(as(owner))
        .send({ token: diff.token, resolutions: { [`role:${conflict.key}`]: "target" } }),
    );
    assert.deepEqual((await context.repositories.roles.list(withoutPeon.id)).map((row) => row.name), ["jefe"]);
    assert.ok(
      (applied.body.skipped as { detail: string }[]).some(
        (entry) => entry.detail === "jefe: una regla hacia un rol que el destino no tiene",
      ),
      JSON.stringify(applied.body.skipped),
    );
    assert.deepEqual(await context.repositories.roles.listRules(withoutPeon.id), []);
  });
});

describe("el original ya no está", () => {
  test("comparar una bifurcación cuyo original se borró es 409, no 404", async () => {
    const parent = await newProject();
    const fork = await forkOf(parent.id);
    await ok(api().delete(parent.base).set(as(owner)));
    const response = await api().get(`${fork.base}/fork/pull`).set(as(owner));
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.match(String(response.body.type), /fork-parent-gone$/);
  });
});

describe("secretos que se conservan al traer", () => {
  test("un entorno nuevo llega con su secreto vacío y se dice; uno que el destino ya tenía se queda el suyo", async () => {
    const parent = await newProject();
    const staging = await ok(
      api()
        .post(`${parent.base}/environments`)
        .set(as(owner))
        .send({
          name: "staging",
          baseUrl: "https://s.example.com",
          variables: { token: { initial: "del-original", current: "del-original", sensitive: true } },
          disabledVariables: { viejo: { initial: "v", current: "v", sensitive: true } },
        }),
    );
    const fork = await forkOf(parent.id);
    const [forkStaging] = await context.repositories.environments.listForProject(fork.id);
    await ok(
      api()
        .patch(`${fork.base}/environments/${forkStaging!.id}`)
        .set(as(owner))
        .send({ variables: { token: { initial: "mío", current: "mío", sensitive: true } } }),
    );
    const mine = (await context.repositories.environments.listForProject(fork.id))[0]!.variables.token!;

    await ok(
      api()
        .patch(`${parent.base}/environments/${staging.body.environmentId}`)
        .set(as(owner))
        .send({ baseUrl: "https://s2.example.com" }),
    );
    await ok(
      api()
        .post(`${parent.base}/environments`)
        .set(as(owner))
        .send({
          name: "prod",
          baseUrl: "https://p.example.com",
          variables: { clave: { initial: "x", current: "x", sensitive: true }, zona: "eu" },
        }),
    );

    const { diff } = { diff: (await ok(api().get(`${fork.base}/fork/pull`).set(as(owner)))).body };
    const resolutions = Object.fromEntries(
      (diff.entries as { kind: string; key: string; status: string }[])
        .filter((entry) => entry.status === "conflict")
        .map((entry) => [`${entry.kind}:${entry.key}`, "source"]),
    );
    const applied = await ok(
      api().post(`${fork.base}/fork/pull`).set(as(owner)).send({ token: diff.token, resolutions }),
    );
    const skipped = applied.body.skipped as { what: string; detail: string }[];
    assert.ok(
      skipped.some((entry) => entry.what === "secreto" && entry.detail === "prod: hay que escribir clave"),
      JSON.stringify(skipped),
    );

    const environments = await context.repositories.environments.listForProject(fork.id);
    const updated = environments.find((row) => row.name === "staging")!;
    assert.equal(updated.baseUrl, "https://s2.example.com");
    assert.deepEqual(updated.variables.token, mine);
    assert.notEqual(mine.initial, "");
    const prod = environments.find((row) => row.name === "prod")!;
    assert.deepEqual(prod.variables.clave, { initial: "", current: "", sensitive: true });
    assert.equal(prod.variables.zona!.initial, "eu");
    assert.equal(prod.writesAllowed, false);
  });

  test("un canal que llega con una cabecera vacía conserva el valor que el destino le había puesto", async () => {
    const parent = await newProject();
    const channel = await ok(
      api()
        .post(`${parent.base}/channels`)
        .set(as(owner))
        .send({ name: "eco", url: "wss://eco.example.com", headers: [{ name: "X-Key", value: "", enabled: true }] }),
    );
    const fork = await forkOf(parent.id);
    const [copy] = await context.repositories.channels.listByProject(fork.id);
    await context.repositories.channels.save({
      ...copy!,
      headers: [{ name: "X-Key", value: "valor-de-la-bifurcacion", enabled: true }],
    });
    await ok(api().patch(`${parent.base}/channels/${channel.body.id}`).set(as(owner)).send({ name: "eco-2" }));

    const { diff } = { diff: (await ok(api().get(`${fork.base}/fork/pull`).set(as(owner)))).body };
    const entry = (diff.entries as { kind: string; key: string; status: string }[]).find((row) => row.kind === "channel")!;
    await ok(
      api()
        .post(`${fork.base}/fork/pull`)
        .set(as(owner))
        .send({ token: diff.token, resolutions: { [`channel:${entry.key}`]: "source" } }),
    );
    const [after] = await context.repositories.channels.listByProject(fork.id);
    assert.equal(after!.name, "eco-2");
    assert.equal(after!.id, copy!.id);
    assert.deepEqual(
      after!.headers.map((header) => [header.name, header.value]),
      [["X-Key", "valor-de-la-bifurcacion"]],
    );
  });
});

describe("lo que llega cuando falta algo que nombraba", () => {
  test("pruebas, datasets, sub-flujos y canales que ya no están, suites con flujos fantasma y entornos que chocan", async () => {
    const parent = await newProject();
    const orders = await ok(api().post(`${parent.base}/endpoints`).set(as(owner)).send({ method: "GET", path: "/orders" }));
    const ordersId = (orders.body.id ?? orders.body.endpointId) as string;
    const admin = await ok(api().post(`${parent.base}/roles`).set(as(owner)).send({ name: "admin" }));
    await ok(
      api()
        .put(`${parent.base}/roles/${admin.body.id}/permissions`)
        .set(as(owner))
        .send({ permissions: [{ endpointId: ordersId, access: "allow" }] }),
    );
    const template = await ok(
      api().post(`${parent.base}/request-templates`).set(as(owner)).send({ name: "Listar", operationId: "x", expectedStatus: 200 }),
    );
    const templateId = template.body.requestTemplateId as string;
    const flow = async (name: string, steps: unknown[]) =>
      (await ok(api().post(`${parent.base}/workflows`).set(as(owner)).send({ name, definition: { steps } }))).body
        .workflowId as string;
    const pedidos = await flow("Pedidos", [{ id: "t", requestTemplateId: templateId }]);
    const viejo = await ok(
      api().post(`${parent.base}/workflows/${pedidos}/datasets`).set(as(owner)).send({ name: "viejo", rows: [{ a: "1" }] }),
    );
    const hijo = await flow("Hijo", [{ id: "t", requestTemplateId: templateId }]);
    const padre = await flow("Padre", [{ id: "sub", kind: "subflow", subflow: { workflowId: hijo } }]);
    const eco = await ok(api().post(`${parent.base}/channels`).set(as(owner)).send({ name: "eco", url: "wss://eco.test" }));
    const canalero = await flow("Canalero", [{ id: "c", kind: "channel", channel: { channelId: eco.body.id } }]);
    const conAuth = await ok(
      api()
        .post(`${parent.base}/channels`)
        .set(as(owner))
        .send({ name: "con-auth", url: "wss://auth.test", auth: { type: "bearer", params: { token: "{{tok}}" } } }),
    );
    await ok(api().post(`${parent.base}/suites`).set(as(owner)).send({ name: "Nocturna", workflowIds: [pedidos] }));
    const staging = await ok(
      api().post(`${parent.base}/environments`).set(as(owner)).send({ name: "staging", baseUrl: "https://s.test" }),
    );
    await ok(api().post(`${parent.base}/environments/${staging.body.environmentId}/activate`).set(as(owner)));
    const prod = await ok(api().post(`${parent.base}/environments`).set(as(owner)).send({ name: "prod", baseUrl: "https://p.test" }));

    const fork = await forkOf(parent.id);
    await ok(api().post(`${fork.base}/environments`).set(as(owner)).send({ name: "qa", baseUrl: "https://qa.test" }));
    const forkStaging = (await context.repositories.projects.findById(fork.id))!.activeEnvironmentId;
    assert.ok(forkStaging);

    // El original cambia y borra.
    await ok(api().patch(`${parent.base}/request-templates/${templateId}`).set(as(owner)).send({ name: "Listar v2" }));
    await ok(api().delete(`${parent.base}/datasets/${viejo.body.datasetId ?? viejo.body.id}`).set(as(owner)));
    await ok(api().put(`${parent.base}/workflows/${pedidos}`).set(as(owner)).send({ name: "Pedidos 2" }));
    await ok(api().patch(`${parent.base}/endpoints/${ordersId}`).set(as(owner)).send({ description: "cambiada" }));
    await ok(api().patch(`${parent.base}/roles/${admin.body.id}`).set(as(owner)).send({ color: "#10b981" }));
    // Borrados por debajo: la API no deja borrar lo que otro flujo usa, pero una fila así existe
    // (se borró antes de esa regla, o lo borró otra instancia a la vez).
    await context.repositories.workflows.deleteWorkflow(parent.id, hijo);
    await ok(api().put(`${parent.base}/workflows/${padre}`).set(as(owner)).send({ name: "Padre 2" }));
    const ecoRow = (await context.repositories.channels.findById(parent.id, eco.body.id))!;
    await context.repositories.channels.save({ ...ecoRow, deletedAt: new Date() });
    await ok(api().put(`${parent.base}/workflows/${canalero}`).set(as(owner)).send({ name: "Canalero 2" }));
    await ok(api().patch(`${parent.base}/channels/${conAuth.body.id}`).set(as(owner)).send({ name: "con-auth-2" }));
    const [storedSuite] = await context.repositories.workflows.listSuites(parent.id);
    await context.repositories.workflows.saveSuite({
      ...storedSuite!,
      description: "cada hora",
      workflowIds: [pedidos, "flujo-fantasma"],
    });
    await ok(api().delete(`${parent.base}/environments/${staging.body.environmentId}`).set(as(owner)));
    await ok(api().patch(`${parent.base}/environments/${prod.body.environmentId}`).set(as(owner)).send({ name: "qa" }));

    const diff = (await ok(api().get(`${fork.base}/fork/pull`).set(as(owner)))).body;
    const resolutions = Object.fromEntries(
      (diff.entries as { kind: string; key: string; status: string }[])
        .filter((entry) => entry.status === "conflict")
        .map((entry) => [`${entry.kind}:${entry.key}`, "source"]),
    );
    const applied = await ok(api().post(`${fork.base}/fork/pull`).set(as(owner)).send({ token: diff.token, resolutions }));
    const details = (applied.body.skipped as { detail: string }[]).map((entry) => entry.detail);
    for (const expected of [
      "Padre 2: el paso sub ejecuta un flujo que no está en el destino",
      "Canalero 2: el paso c usa un canal que no está en el destino",
      "Nocturna: nombraba un flujo que ya no existe y se quitó",
      "qa: ya había otro con ese nombre, se llama qa (2)",
    ])
      assert.ok(details.includes(expected), `falta «${expected}» en ${JSON.stringify(details)}`);

    const templates = await context.repositories.workflows.listTemplates(fork.id);
    assert.deepEqual(templates.map((row) => row.name), ["Listar v2"]);
    const flows = await context.repositories.workflows.listWorkflows(fork.id);
    const forkPedidos = flows.find((row) => row.name === "Pedidos 2")!;
    assert.ok(forkPedidos);
    assert.deepEqual(
      (await context.repositories.workflows.listDatasets(fork.id)).filter((row) => row.workflowId === forkPedidos.id),
      [],
    );
    const [forkSuite] = await context.repositories.workflows.listSuites(fork.id);
    assert.deepEqual(forkSuite!.workflowIds, [forkPedidos.id]);
    const channels = await context.repositories.channels.listByProject(fork.id);
    const renamed = channels.find((row) => row.name === "con-auth-2")!;
    assert.deepEqual(renamed.auth, { type: "bearer", params: { token: "{{tok}}" } });
    const access = (await context.repositories.config.findSection(fork.id, "access"))?.data as { access: { roles: string[] } };
    assert.deepEqual(access.access.roles, ["admin"]);

    const environments = await context.repositories.environments.listForProject(fork.id);
    assert.deepEqual(environments.map((row) => row.name).sort(), ["qa", "qa (2)"]);
    const active = (await context.repositories.projects.findById(fork.id))!.activeEnvironmentId;
    assert.notEqual(active, forkStaging);
    assert.ok(environments.some((row) => row.id === active), "el activo apunta a uno que existe");
  });

  test("al fusionar un borrado, el original pierde el elemento y su pareja; el activo se queda sin entorno", async () => {
    const parent = await newProject();
    const staging = await ok(
      api().post(`${parent.base}/environments`).set(as(owner)).send({ name: "staging", baseUrl: "https://s.test" }),
    );
    await ok(api().post(`${parent.base}/environments/${staging.body.environmentId}/activate`).set(as(owner)));
    const fork = await forkOf(parent.id);
    const [copy] = await context.repositories.environments.listForProject(fork.id);
    await ok(api().delete(`${fork.base}/environments/${copy!.id}`).set(as(owner)));

    const diff = (await ok(api().get(`${fork.base}/fork/merge`).set(as(owner)))).body;
    assert.deepEqual(
      (diff.entries as { kind: string; sourceChange: string }[]).map((entry) => [entry.kind, entry.sourceChange]),
      [["environment", "deleted"]],
    );
    await ok(api().post(`${fork.base}/fork/merge`).set(as(owner)).send({ token: diff.token }));
    assert.deepEqual(await context.repositories.environments.listForProject(parent.id), []);
    assert.equal((await context.repositories.projects.findById(parent.id))!.activeEnvironmentId, null);
    const stored = context.repositories.forks.rows.get(fork.id)!;
    assert.deepEqual(stored.lineage.environment, []);
    assert.deepEqual((await ok(api().get(`${fork.base}/fork/merge`).set(as(owner)))).body.entries, []);
  });
});
