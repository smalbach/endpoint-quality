/**
 * Importar un fichero de proyecto: las negativas antes de escribir nada, y lo que cada parte hace
 * con lo que ya había en el proyecto de destino (endpoints, roles, reglas, entornos, planes, el
 * contrato) y lo que dice en `skipped`.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { blankChannel, MAX_CHANNELS_PER_PROJECT } from "@/modules/channels/domain/model";
import { createTestApp, type TestContext } from "../support/test-app";
import { STUB_SPEC_YAML } from "../support/stub-target";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { organizationId: string; token: string };
async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  const session = await api().post("/auth/login").send({ email, password });
  return { organizationId: registered.body.organizationId, token: session.body.accessToken };
}
let owner: Actor;
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

async function newProject(name: string): Promise<{ url: string; id: string }> {
  const created = await api()
    .post(`/orgs/${owner.organizationId}/projects`)
    .set(as(owner))
    .send({ name, baseUrl: "https://api.destino.test" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { url: `/orgs/${owner.organizationId}/projects/${created.body.projectId}`, id: created.body.projectId };
}
const importBundle = (url: string, bundle: unknown, parts?: string[]) =>
  api()
    .post(`${url}/import-bundle`)
    .set(as(owner))
    .send({ bundle, ...(parts ? { parts } : {}) });

const BASE = { format: "endpoint-quality/project", version: 1 };
const problemType = (response: request.Response) => String(response.body.type).split("/").pop();

before(async () => {
  context = await createTestApp();
  owner = await signUp("proj-cov-bundle@example.com");
});
after(async () => {
  await context?.close();
});

describe("las negativas, antes de escribir nada", () => {
  test("una parte que no existe se nombra", async () => {
    const { url } = await newProject("Partes");
    const response = await importBundle(url, { ...BASE, settings: {} }, ["settings", "secretos"]);
    assert.equal(response.status, 422);
    assert.equal(problemType(response), "unknown-bundle-part");
    assert.deepEqual(response.body.errors, [{ field: "parts", detail: "secretos" }]);
  });

  test("elegir solo partes que el fichero no trae es un fichero vacío", async () => {
    const { url } = await newProject("Vacío");
    const response = await importBundle(url, { ...BASE, settings: { description: "x" } }, ["flows"]);
    assert.equal(response.status, 422);
    assert.equal(problemType(response), "bundle-empty");
    const nothing = await importBundle(url, BASE);
    assert.equal(problemType(nothing), "bundle-empty");
  });

  test("un proyecto que pasaría del máximo de canales no recibe ninguno", async () => {
    const { url, id } = await newProject("Lleno");
    const now = new Date();
    for (let index = 0; index < MAX_CHANNELS_PER_PROJECT; index++) {
      await context.repositories.channels.save(
        blankChannel({ id: randomUUID(), projectId: id, name: `c${index}`, url: "wss://x.test", now, by: "t" }),
      );
    }
    const response = await importBundle(url, {
      ...BASE,
      flows: {
        workflows: [
          { id: "w", name: "Canal", definition: { steps: [{ id: "s", kind: "channel", channel: { channelId: "c" } }] } },
        ],
        channels: [{ id: "c", name: "nuevo", url: "wss://nuevo.test" }],
      },
    });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(problemType(response), "channels-full");
    assert.equal((await context.repositories.channels.listByProject(id)).length, MAX_CHANNELS_PER_PROJECT);
    assert.deepEqual(await context.repositories.workflows.listWorkflows(id), []);
  });
});

describe("cada parte con lo que ya había", () => {
  test("ajustes, configuración, endpoints con ejemplos, roles con reglas, entornos y planes", async () => {
    const { url, id } = await newProject("Destino");
    await api().post(`${url}/endpoints`).set(as(owner)).send({ method: "GET", path: "/ya" }).expect(201);
    await api().post(`${url}/roles`).set(as(owner)).send({ name: "Vendedor" }).expect(201);
    await api()
      .post(`${url}/performance/plans`)
      .set(as(owner))
      .send({
        name: "Carga",
        definition: {
          scenarios: [{ id: "l", name: "L", weight: 1, thinkMs: 0, requests: [{ method: "GET", path: "/ya" }] }],
          profile: { type: "constant", vus: 1, durationS: 1 },
          thresholds: {},
        },
      })
      .expect(201);
    const plan = (await context.repositories.performancePlans.list(id))[0]!;

    const example = {
      name: "ok",
      request: { method: "GET", url: "https://x.test/nuevo", headers: [], body: { text: "", contentType: "" } },
      response: { status: 200, headers: [], body: "{}", contentType: "application/json" },
    };
    const response = await importBundle(url, {
      ...BASE,
      settings: { description: "Del fichero", baseUrl: " https://nueva.test ", tags: ["Uno", "uno", "Dos"] },
      config: [{ section: "implemented", data: { implemented: ["listThings"] } }],
      endpoints: [
        { method: "GET", path: "/ya" },
        { method: "GET", path: "/nuevo/", examples: [example, { ...example, name: "otro" }] },
      ],
      roles: [
        {
          name: "vendedor",
          permissions: [
            { method: "GET", path: "/nuevo", access: "allow" },
            ...["/a", "/b", "/c", "/d"].map((path) => ({ method: "GET", path, access: "deny" })),
          ],
        },
        { name: "Comprador", color: "#123456" },
      ],
      roleRules: [
        { source: "Vendedor", target: "comprador", canRead: true },
        { source: "comprador", target: "vendedor" },
        { source: "fantasma", target: "vendedor", canRead: true },
      ],
      environments: [
        {
          name: "staging",
          baseUrl: "https://s.test///",
          variables: { host: { initial: "h", current: "h2" }, token: { initial: "x", sensitive: true } },
          disabledVariables: { host: { initial: "repetida" }, viejo: { initial: "v" } },
        },
        { name: "staging", baseUrl: "https://t.test" },
      ],
      performance: [{ name: plan.name, definition: plan.definition }],
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const result = response.body;
    assert.deepEqual(
      [...result.parts].sort(),
      ["config", "endpoints", "environments", "performance", "roles", "settings"],
    );
    assert.equal(result.settings, true);
    assert.deepEqual(result.sections, ["implemented"]);
    assert.equal(result.endpoints, 1);
    assert.equal(result.examples, 2);
    assert.equal(result.roles, 1);
    assert.equal(result.permissions, 1);
    assert.equal(result.environments, 2);
    assert.equal(result.performancePlans, 1);

    const skipped = result.skipped as { what: string; detail: string }[];
    const detail = (what: string) => skipped.filter((entry) => entry.what === what).map((entry) => entry.detail);
    assert.deepEqual(detail("endpoint"), ["GET /ya ya existe"]);
    assert.deepEqual(detail("rol"), ["vendedor ya existía: se conserva y recibe los permisos del fichero"]);
    assert.deepEqual(detail("permiso"), ["vendedor: 4 endpoints no existen aquí (GET /a, GET /b, GET /c…)"]);
    assert.deepEqual(detail("regla"), ["fantasma → vendedor: uno de los roles no existe"]);
    assert.deepEqual(detail("secreto"), ["staging: hay que escribir token"]);

    // Lo escrito, tal como quedó.
    const project = (await context.repositories.projects.findById(id))!;
    assert.equal(project.description, "Del fichero");
    assert.equal(project.baseUrl, "https://nueva.test");
    assert.ok(project.tags.length >= 2);
    const endpoints = await context.repositories.endpoints.listAll(id);
    const nuevo = endpoints.find((endpoint) => endpoint.path === "/nuevo")!;
    assert.equal(nuevo.origin, "import");
    assert.equal((await context.repositories.examples.listByEndpoint(id, nuevo.id)).length, 2);

    const roles = await context.repositories.roles.list(id);
    assert.deepEqual(roles.map((role) => role.name).sort(), ["Comprador", "Vendedor"]);
    assert.equal(roles.find((role) => role.name === "Comprador")!.color, "#123456");
    const rules = await context.repositories.roles.listRules(id);
    // La regla sin ningún permiso no se guarda: no dice nada.
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.canRead, true);

    const environments = await context.repositories.environments.listForProject(id);
    assert.deepEqual(environments.map((row) => row.name).sort(), ["staging", "staging (2)"]);
    const staging = environments.find((row) => row.name === "staging")!;
    assert.equal(staging.baseUrl, "https://s.test");
    assert.deepEqual(staging.variables.host, { initial: "h", current: "h2", sensitive: false });
    assert.deepEqual(staging.variables.token, { initial: "", current: "", sensitive: true });
    assert.deepEqual(Object.keys(staging.disabledVariables), ["viejo"]);
    assert.equal(project.activeEnvironmentId, staging.id);

    const plans = await context.repositories.performancePlans.list(id);
    assert.deepEqual(plans.map((row) => row.name).sort(), ["Carga", "Carga (2)"]);

    // Otra vez los entornos: el activo ya está puesto y no se cambia.
    const again = await importBundle(url, { ...BASE, environments: [{ name: "prod", baseUrl: "https://p.test" }] });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal((await context.repositories.projects.findById(id))!.activeEnvironmentId, staging.id);
  });

  test("roles sin permisos ni reglas: se crean con un color de la paleta", async () => {
    const { url, id } = await newProject("Roles");
    const response = await importBundle(url, { ...BASE, roles: [{ name: "lector" }] });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.permissions, 0);
    const [role] = await context.repositories.roles.list(id);
    assert.equal(role!.name, "lector");
    assert.match(role!.color, /^#/);

    // Las reglas de un fichero se suman a las que ya había, no las sustituyen.
    const first = await importBundle(url, {
      ...BASE,
      roles: [{ name: "escritor" }],
      roleRules: [{ source: "lector", target: "escritor", canWrite: true }],
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await importBundle(url, {
      ...BASE,
      roles: [{ name: "lector" }],
      roleRules: [{ source: "escritor", target: "lector", canDelete: true }],
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.roles, 0);
    const rules = await context.repositories.roles.listRules(id);
    assert.equal(rules.length, 2);
    assert.deepEqual(rules.map((rule) => [rule.canRead, rule.canWrite, rule.canDelete]).sort(), [
      [false, false, true],
      [false, true, false],
    ]);
  });

  test("unos ajustes vacíos no cambian nada del proyecto, pero cuentan como importados", async () => {
    const { url, id } = await newProject("Ajustes");
    const before = (await context.repositories.projects.findById(id))!;
    const response = await importBundle(url, { ...BASE, settings: {} });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.settings, true);
    const after = (await context.repositories.projects.findById(id))!;
    assert.equal(after.baseUrl, before.baseUrl);
    assert.equal(after.description, before.description);
    assert.deepEqual(after.tags, before.tags);
  });

  test("el mismo contrato otra vez no cambia; las operaciones que faltan se cuentan de cinco en cinco", async () => {
    const { url } = await newProject("Contrato");
    const first = await importBundle(url, { ...BASE, contract: { raw: STUB_SPEC_YAML } });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.contract, "imported");

    const templates = ["uno", "dos", "tres", "cuatro", "cinco", "seis"].map((name) => ({
      id: name,
      name,
      operationId: `op-${name}`,
      expectedStatus: 200,
    }));
    const second = await importBundle(url, {
      ...BASE,
      project: { name: "Origen" },
      contract: { raw: STUB_SPEC_YAML },
      flows: { requestTemplates: [...templates, { id: "ok", name: "ok", operationId: "listThings", expectedStatus: 200 }] },
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.contract, "unchanged");
    assert.equal(second.body.requestTemplates, 7);
    const operation = (second.body.skipped as { what: string; detail: string }[]).find(
      (entry) => entry.what === "operación",
    )!;
    assert.match(operation.detail, /uno \(op-uno\).*cinco \(op-cinco\) y 1 más: no se podrán ejecutar/);
    assert.doesNotMatch(operation.detail, /listThings/);
  });

  test("una sola petición sin contrato lo dice en singular; la petición guarda cuerpo y auth por defecto", async () => {
    const { url, id } = await newProject("Sin contrato");
    const response = await importBundle(url, {
      ...BASE,
      flows: {
        requestTemplates: [{ id: "t", name: "Sola", operationId: "x", expectedStatus: 200 }],
        workflows: [
          { id: "w", name: "Flujo", status: "ready", definition: { steps: [{ id: "s", requestTemplateId: "t" }] } },
        ],
        datasets: [{ workflowId: "w", name: "filas", rows: [{ a: "1" }] }],
        suites: [{ name: "Suite", workflowIds: ["w"] }],
      },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.deepEqual(
      (response.body.skipped as { what: string; detail: string }[]).map((entry) => entry.detail),
      ["este proyecto no tiene contrato: la petición importada no se podrán ejecutar hasta importar uno"],
    );
    const [template] = await context.repositories.workflows.listTemplates(id);
    assert.deepEqual(template!.body, { type: "none" });
    assert.equal(template!.auth, "default");
    const [workflow] = await context.repositories.workflows.listWorkflows(id);
    assert.equal(workflow!.definition.steps[0]!.requestTemplateId, template!.id);
    assert.equal(workflow!.status, "ready");
    const [suite] = await context.repositories.workflows.listSuites(id);
    assert.deepEqual(suite!.workflowIds, [workflow!.id]);
    assert.equal(response.body.datasets, 1);
  });
});
