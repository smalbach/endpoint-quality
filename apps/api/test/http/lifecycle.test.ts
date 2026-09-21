/**
 * Las dos puertas nuevas, por HTTP y recurso a recurso: **archivar** y **borrar sin perder**.
 *
 * Una sola suite para los seis recursos porque lo que hay que demostrar es lo mismo en todos —el
 * filtro contesta su lista, archivar saca de la lista, eliminar deja restaurar, y el definitivo
 * pide que antes esté eliminado— y repetir el guion seis veces en seis ficheros lo dejaría distinto
 * en alguno.
 *
 * Lo que **no** es igual y se prueba aparte en cada uno: lo que cada recurso hace de más al salir
 * de la lista. Un entorno pasa el puesto de activo al siguiente; un rol sale de la matriz; un
 * endpoint restaurado choca si su método y su ruta se reutilizaron.
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
  assert.equal(session.status, 200, JSON.stringify(session.body));
  return { organizationId: registered.body.organizationId, token: session.body.accessToken };
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

let owner: Actor;

/** Un proyecto nuevo por bloque: lo que uno archive no puede aparecer en la lista de otro. */
async function newProject(name: string): Promise<string> {
  const created = await api()
    .post(`/orgs/${owner.organizationId}/projects`)
    .set(as(owner))
    .send({ name: `${name}-${Math.random().toString(36).slice(2, 7)}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return `/orgs/${owner.organizationId}/projects/${created.body.projectId}`;
}

before(async () => {
  context = await createTestApp();
  owner = await signUp(`lifecycle-${Date.now()}@example.test`);
});
after(async () => {
  await context?.close();
});

describe("una documentación publicada", () => {
  test("se archiva, se restaura y solo se borra del todo desde la papelera", async () => {
    const base = await newProject("docs");
    const created = await api()
      .post(`${base}/doc-sites`)
      .set(as(owner))
      .send({ name: "la pública", visibility: "public" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id: string = created.body.site.id;
    const publicId: string = created.body.site.publicId;

    // Archivada: fuera de la lista y **su URL deja de publicar**.
    const filed = await api().patch(`${base}/doc-sites/${id}/archived`).set(as(owner)).send({ archived: true });
    assert.equal(filed.status, 200);
    assert.ok(filed.body.archivedAt);
    assert.deepEqual((await api().get(`${base}/doc-sites`).set(as(owner))).body.sites, []);
    assert.equal((await api().get(`/shared/docs/${publicId}`)).status, 404);
    const archived = await api().get(`${base}/doc-sites?state=archived`).set(as(owner));
    assert.equal(archived.body.sites.length, 1);

    // Y desarchivada vuelve a publicar con el mismo enlace.
    await api().patch(`${base}/doc-sites/${id}/archived`).set(as(owner)).send({ archived: false });
    assert.equal((await api().get(`/shared/docs/${publicId}`)).status, 200);

    // Eliminada: a la papelera, y el enlace se recupera al restaurarla.
    assert.equal((await api().delete(`${base}/doc-sites/${id}`).set(as(owner))).status, 204);
    assert.equal((await api().get(`/shared/docs/${publicId}`)).status, 404);
    const trash = await api().get(`${base}/doc-sites?state=deleted`).set(as(owner));
    assert.equal(trash.body.sites.length, 1);
    const back = await api().post(`${base}/doc-sites/${id}/restore`).set(as(owner));
    assert.equal(back.status, 201);
    assert.equal(back.body.publicId, publicId);
    assert.equal((await api().get(`/shared/docs/${publicId}`)).status, 200);

    // El definitivo, en su orden.
    assert.equal((await api().delete(`${base}/doc-sites/${id}?purge=true`).set(as(owner))).status, 409);
    await api().delete(`${base}/doc-sites/${id}`).set(as(owner));
    assert.equal((await api().delete(`${base}/doc-sites/${id}?purge=true`).set(as(owner))).status, 204);
    assert.deepEqual((await api().get(`${base}/doc-sites?state=deleted`).set(as(owner))).body.sites, []);
  });

  test("restaurar con el nombre ya reutilizado es un 409, y archivar lo borrado también", async () => {
    const base = await newProject("docs-clash");
    const first = await api().post(`${base}/doc-sites`).set(as(owner)).send({ name: "la misma", visibility: "public" });
    const id: string = first.body.site.id;
    await api().delete(`${base}/doc-sites/${id}`).set(as(owner));

    const early = await api().patch(`${base}/doc-sites/${id}/archived`).set(as(owner)).send({ archived: true });
    assert.equal(early.status, 409);

    await api().post(`${base}/doc-sites`).set(as(owner)).send({ name: "la misma", visibility: "public" });
    const clash = await api().post(`${base}/doc-sites/${id}/restore`).set(as(owner));
    assert.equal(clash.status, 409);
    assert.match(String(clash.body.type), /doc-site-duplicate-name$/);
  });
});

describe("un entorno", () => {
  const environment = async (base: string, name: string) => {
    const created = await api()
      .post(`${base}/environments`)
      .set(as(owner))
      .send({ name, baseUrl: "https://api.example.com" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.environmentId as string;
  };

  test("archivarlo lo saca del selector y pasa el puesto de activo al siguiente", async () => {
    const base = await newProject("envs");
    const first = await environment(base, "staging");
    const second = await environment(base, "produccion");
    const active = async () => (await api().get(`${base}`).set(as(owner))).body.activeEnvironmentId;
    assert.equal(await active(), first, "el primero es el activo al crearlo");

    const filed = await api().patch(`${base}/environments/${first}/archived`).set(as(owner)).send({ archived: true });
    assert.equal(filed.status, 204);
    assert.equal(await active(), second, "el activo pasa al más viejo que quede");
    const live = await api().get(`${base}/environments`).set(as(owner));
    assert.deepEqual(
      live.body.map((row: { id: string }) => row.id),
      [second],
    );
    const archived = await api().get(`${base}/environments?state=archived`).set(as(owner));
    assert.deepEqual(
      archived.body.map((row: { id: string }) => row.id),
      [first],
    );

    await api().patch(`${base}/environments/${first}/archived`).set(as(owner)).send({ archived: false });
    assert.equal((await api().get(`${base}/environments`).set(as(owner))).body.length, 2);
  });

  test("eliminarlo guarda sus credenciales; el definitivo se las lleva", async () => {
    const base = await newProject("envs-creds");
    const id = await environment(base, "staging");
    const credential = await api()
      .put(`${base}/environments/${id}/credentials`)
      .set(as(owner))
      .send({ name: "t", role: "primary", kind: "bearer", secret: "s" });
    assert.equal(credential.status, 200, JSON.stringify(credential.body));

    assert.equal((await api().delete(`${base}/environments/${id}`).set(as(owner))).status, 204);
    assert.ok(await context.repositories.environments.findCredential(id, "primary"));
    const trash = await api().get(`${base}/environments?state=deleted`).set(as(owner));
    assert.equal(trash.body.length, 1);
    // Y deja de poder ejecutarse: por ahí entran las corridas y los monitores.
    assert.equal(await context.repositories.environments.findById(id), null);

    assert.equal((await api().post(`${base}/environments/${id}/restore`).set(as(owner))).status, 204);
    assert.ok(await context.repositories.environments.findById(id));

    assert.equal((await api().delete(`${base}/environments/${id}?purge=true`).set(as(owner))).status, 409);
    await api().delete(`${base}/environments/${id}`).set(as(owner));
    assert.equal((await api().delete(`${base}/environments/${id}?purge=true`).set(as(owner))).status, 204);
    assert.equal(await context.repositories.environments.findCredential(id, "primary"), null);
  });

  test("restaurar con el nombre reutilizado es un 409", async () => {
    const base = await newProject("envs-clash");
    const id = await environment(base, "staging");
    await api().delete(`${base}/environments/${id}`).set(as(owner));
    await environment(base, "staging");
    const clash = await api().post(`${base}/environments/${id}/restore`).set(as(owner));
    assert.equal(clash.status, 409);
    assert.match(String(clash.body.type), /environment-name-taken$/);
  });
});

describe("un rol", () => {
  const role = async (base: string, name: string) => {
    const created = await api().post(`${base}/roles`).set(as(owner)).send({ name });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.id as string;
  };
  const accessRoles = async (base: string) =>
    ((await api().get(`${base}/config`).set(as(owner))).body.sections.access?.data?.access?.roles ?? []) as string[];

  test("archivado sale de la matriz y vuelve con ella; sus credenciales solo se van en el definitivo", async () => {
    const base = await newProject("roles");
    const id = await role(base, "vendedor");
    await role(base, "comprador");
    const environment = await api()
      .post(`${base}/environments`)
      .set(as(owner))
      .send({ name: "staging", baseUrl: "https://api.example.com" });
    const environmentId: string = environment.body.environmentId;
    const credential = await api()
      .put(`${base}/environments/${environmentId}/credentials`)
      .set(as(owner))
      .send({ name: "v", role: "vendedor", kind: "bearer", secret: "s" });
    assert.equal(credential.status, 200, JSON.stringify(credential.body));
    assert.deepEqual(await accessRoles(base), ["vendedor", "comprador"]);

    assert.equal(
      (await api().patch(`${base}/roles/${id}/archived`).set(as(owner)).send({ archived: true })).status,
      204,
    );
    assert.deepEqual(await accessRoles(base), ["comprador"]);
    assert.ok(await context.repositories.environments.findCredential(environmentId, "vendedor"));
    const archived = await api().get(`${base}/roles?state=archived`).set(as(owner));
    assert.equal(archived.body.length, 1);

    await api().patch(`${base}/roles/${id}/archived`).set(as(owner)).send({ archived: false });
    assert.deepEqual(await accessRoles(base), ["vendedor", "comprador"]);

    assert.equal((await api().delete(`${base}/roles/${id}`).set(as(owner))).status, 204);
    assert.deepEqual(await accessRoles(base), ["comprador"]);
    assert.equal((await api().get(`${base}/roles?state=deleted`).set(as(owner))).body.length, 1);
    assert.equal((await api().post(`${base}/roles/${id}/restore`).set(as(owner))).status, 204);
    assert.deepEqual(await accessRoles(base), ["vendedor", "comprador"]);

    assert.equal((await api().delete(`${base}/roles/${id}?purge=true`).set(as(owner))).status, 409);
    await api().delete(`${base}/roles/${id}`).set(as(owner));
    assert.equal((await api().delete(`${base}/roles/${id}?purge=true`).set(as(owner))).status, 204);
    assert.equal(await context.repositories.environments.findCredential(environmentId, "vendedor"), null);
  });

  test("restaurar un rol cuyo nombre se reutilizó es un 409", async () => {
    const base = await newProject("roles-clash");
    const id = await role(base, "admin");
    await api().delete(`${base}/roles/${id}`).set(as(owner));
    await role(base, "admin");
    const clash = await api().post(`${base}/roles/${id}/restore`).set(as(owner));
    assert.equal(clash.status, 409);
    assert.match(String(clash.body.type), /role-name-taken$/);
  });
});

describe("un canal", () => {
  const channel = async (base: string, name: string) => {
    const created = await api()
      .post(`${base}/channels`)
      .set(as(owner))
      .send({ protocol: "ws", name, url: "wss://eco.example.test/socket" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.id as string;
  };

  test("archivado deja de poder abrirse, y el definitivo se lleva la fila", async () => {
    const base = await newProject("channels");
    const id = await channel(base, "eco");

    assert.equal(
      (await api().patch(`${base}/channels/${id}/archived`).set(as(owner)).send({ archived: true })).status,
      204,
    );
    assert.deepEqual((await api().get(`${base}/channels`).set(as(owner))).body.channels, []);
    const archived = await api().get(`${base}/channels?state=archived`).set(as(owner));
    assert.equal(archived.body.channels.length, 1);
    assert.ok(archived.body.channels[0].archivedAt);
    // Y no se puede abrir una sesión contra él: lo que no está vivo no se resuelve.
    assert.equal((await api().get(`${base}/channels/${id}`).set(as(owner))).status, 404);

    await api().patch(`${base}/channels/${id}/archived`).set(as(owner)).send({ archived: false });
    assert.equal((await api().get(`${base}/channels/${id}`).set(as(owner))).status, 200);

    assert.equal((await api().delete(`${base}/channels/${id}`).set(as(owner))).status, 204);
    assert.equal((await api().get(`${base}/channels?state=deleted`).set(as(owner))).body.channels.length, 1);
    assert.equal((await api().post(`${base}/channels/${id}/restore`).set(as(owner))).status, 204);
    assert.equal((await api().get(`${base}/channels`).set(as(owner))).body.channels.length, 1);

    assert.equal((await api().delete(`${base}/channels/${id}?purge=true`).set(as(owner))).status, 409);
    await api().delete(`${base}/channels/${id}`).set(as(owner));
    assert.equal((await api().delete(`${base}/channels/${id}?purge=true`).set(as(owner))).status, 204);
    assert.deepEqual((await api().get(`${base}/channels?state=deleted`).set(as(owner))).body.channels, []);
  });
});

describe("un endpoint", () => {
  const endpoint = async (base: string, path: string) => {
    const created = await api().post(`${base}/endpoints`).set(as(owner)).send({ method: "GET", path });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.id as string;
  };

  test("la papelera es otra lista, con su cuenta, y desde ella se restaura de uno en uno o en lote", async () => {
    const base = await newProject("endpoints");
    const first = await endpoint(base, "/uno");
    const second = await endpoint(base, "/dos");

    await api().delete(`${base}/endpoints/${first}`).set(as(owner));
    const bulk = await api()
      .post(`${base}/endpoints/bulk-delete`)
      .set(as(owner))
      .send({ ids: [second] });
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));

    const live = await api().get(`${base}/endpoints`).set(as(owner));
    assert.deepEqual(live.body.data, []);
    assert.equal(live.body.deleted, 2, "la cuenta de la papelera va con la lista de siempre");

    const trash = await api().get(`${base}/endpoints?state=deleted`).set(as(owner));
    assert.equal(trash.body.data.length, 2);

    assert.equal((await api().post(`${base}/endpoints/${first}/restore`).set(as(owner))).status, 204);
    // Un lote vacío no es un error: contesta que no restauró ninguno, y no pregunta nada a la base.
    const nothing = await api().post(`${base}/endpoints/bulk-restore`).set(as(owner)).send({ ids: [] });
    assert.equal(nothing.body.restored, 0);
    const restored = await api()
      .post(`${base}/endpoints/bulk-restore`)
      .set(as(owner))
      .send({ ids: [second] });
    assert.equal(restored.body.restored, 1);
    assert.equal((await api().get(`${base}/endpoints`).set(as(owner))).body.data.length, 2);
  });

  test("restaurar uno cuyo método y ruta se reutilizaron es un 409, y el definitivo pide su turno", async () => {
    const base = await newProject("endpoints-clash");
    const id = await endpoint(base, "/repetido");
    await api().delete(`${base}/endpoints/${id}`).set(as(owner));
    // El índice único solo cuenta lo vivo, así que la ruta queda libre mientras está en la papelera.
    await endpoint(base, "/repetido");

    const clash = await api().post(`${base}/endpoints/${id}/restore`).set(as(owner));
    assert.equal(clash.status, 409);
    assert.match(String(clash.body.type), /endpoint-duplicate$/);

    assert.equal((await api().delete(`${base}/endpoints/${id}?purge=true`).set(as(owner))).status, 204);
    assert.deepEqual((await api().get(`${base}/endpoints?state=deleted`).set(as(owner))).body.data, []);
    // Ya no está: ni para restaurar ni para volver a borrar.
    assert.equal((await api().post(`${base}/endpoints/${id}/restore`).set(as(owner))).status, 404);
  });

  test("un filtro inventado es un 422, aquí y en el resto de listas", async () => {
    const base = await newProject("endpoints-state");
    assert.equal((await api().get(`${base}/endpoints?state=papelera`).set(as(owner))).status, 422);
    assert.equal((await api().get(`${base}/doc-sites?state=papelera`).set(as(owner))).status, 422);
    assert.equal((await api().get(`${base}/environments?state=papelera`).set(as(owner))).status, 422);
    assert.equal((await api().get(`${base}/roles?state=papelera`).set(as(owner))).status, 422);
    assert.equal((await api().get(`${base}/channels?state=papelera`).set(as(owner))).status, 422);
    assert.equal((await api().get(`${base}/workflows?state=papelera`).set(as(owner))).status, 422);
    assert.equal((await api().get(`${base}/performance/plans?state=papelera`).set(as(owner))).status, 422);
  });
});

describe("un flujo", () => {
  test("se lleva sus conjuntos a la papelera y los devuelve con él", async () => {
    const base = await newProject("flows");
    const flow = await api().post(`${base}/workflows`).set(as(owner)).send({ name: "alta" });
    assert.equal(flow.status, 201, JSON.stringify(flow.body));
    const workflowId: string = flow.body.workflowId;
    const dataset = await api()
      .post(`${base}/workflows/${workflowId}/datasets`)
      .set(as(owner))
      .send({ name: "clientes", rows: [{ email: "a@b.c" }] });
    assert.equal(dataset.status, 201, JSON.stringify(dataset.body));
    const aside = await api()
      .post(`${base}/workflows/${workflowId}/datasets`)
      .set(as(owner))
      .send({ name: "aparte", rows: [] });
    // Borrado a mano antes que el flujo: al restaurarlo vuelve también, que es la regla que se
    // puede explicar en una frase. Ver `RestoreWorkflowHandler`.
    await api().delete(`${base}/datasets/${aside.body.datasetId}`).set(as(owner));

    assert.equal((await api().delete(`${base}/workflows/${workflowId}`).set(as(owner))).status, 204);
    const trash = await api().get(`${base}/workflows?state=deleted`).set(as(owner));
    assert.equal(trash.body.workflows.length, 1);
    assert.equal(trash.body.datasets.length, 2, "el del flujo y el que ya estaba en la papelera");
    assert.deepEqual((await api().get(`${base}/workflows`).set(as(owner))).body.workflows, []);

    const restoredFlow = await api().post(`${base}/workflows/${workflowId}/restore`).set(as(owner));
    assert.equal(restoredFlow.status, 204, JSON.stringify(restoredFlow.body));
    const backLive = await api().get(`${base}/workflows`).set(as(owner));
    assert.equal(backLive.body.workflows.length, 1);
    assert.deepEqual(
      backLive.body.datasets.map((row: { name: string }) => row.name).sort(),
      ["aparte", "clientes"],
      "el flujo vuelve con sus datos, todos",
    );
    const stillTrashed = await api().get(`${base}/workflows?state=deleted`).set(as(owner));
    assert.deepEqual(stillTrashed.body.datasets, []);

    // Restaurar lo que no está borrado no hace nada y contesta bien.
    assert.equal((await api().post(`${base}/workflows/${workflowId}/restore`).set(as(owner))).status, 204);
  });

  test("una suite que lo nombra bloquea su borrado; archivada ya no", async () => {
    const base = await newProject("flows-suite");
    const flow = await api().post(`${base}/workflows`).set(as(owner)).send({ name: "alta" });
    const workflowId: string = flow.body.workflowId;
    const suite = await api()
      .post(`${base}/suites`)
      .set(as(owner))
      .send({ name: "humo", workflowIds: [workflowId] });
    assert.equal(suite.status, 201, JSON.stringify(suite.body));
    const suiteId: string = suite.body.suiteId;

    const blocked = await api().delete(`${base}/workflows/${workflowId}`).set(as(owner));
    assert.equal(blocked.status, 409);
    assert.match(String(blocked.body.type), /workflow-in-use$/);

    // La suite eliminada deja de contar como referencia: no ejecuta nada.
    await api().delete(`${base}/suites/${suiteId}`).set(as(owner));
    assert.equal((await api().delete(`${base}/workflows/${workflowId}`).set(as(owner))).status, 204);

    // Y restaurarla con un flujo que ya no está es un 422 que dice cuál falta.
    const restored = await api().post(`${base}/suites/${suiteId}/restore`).set(as(owner));
    assert.equal(restored.status, 422);
    assert.match(String(restored.body.type), /workflow-not-found$/);
  });

  test("una suite se archiva y sale de su lista sin tocar los flujos que nombra", async () => {
    const base = await newProject("flows-archive");
    const flow = await api().post(`${base}/workflows`).set(as(owner)).send({ name: "alta" });
    const workflowId: string = flow.body.workflowId;
    const suite = await api()
      .post(`${base}/suites`)
      .set(as(owner))
      .send({ name: "humo", workflowIds: [workflowId] });
    const suiteId: string = suite.body.suiteId;
    const dataset = await api()
      .post(`${base}/workflows/${workflowId}/datasets`)
      .set(as(owner))
      .send({ name: "clientes", rows: [] });
    const datasetId: string = dataset.body.datasetId;

    assert.equal(
      (await api().patch(`${base}/suites/${suiteId}/archived`).set(as(owner)).send({ archived: true })).status,
      204,
    );
    assert.equal(
      (await api().patch(`${base}/datasets/${datasetId}/archived`).set(as(owner)).send({ archived: true })).status,
      204,
    );
    const live = await api().get(`${base}/workflows`).set(as(owner));
    assert.deepEqual(live.body.suites, []);
    assert.deepEqual(live.body.datasets, []);
    assert.equal(live.body.workflows.length, 1, "el flujo que nombraba sigue en su lista");

    const archived = await api().get(`${base}/workflows?state=archived`).set(as(owner));
    assert.equal(archived.body.suites.length, 1);
    assert.equal(archived.body.datasets.length, 1);

    // Una suite archivada **sigue contando** como referencia: está apartada, no borrada, y
    // desarchivarla tiene que devolver la misma suite y no una con un paso menos. Lo que deja de
    // contar es la que está en la papelera, y ahí restaurarla ya comprueba sus flujos.
    const blocked = await api().delete(`${base}/workflows/${workflowId}`).set(as(owner));
    assert.equal(blocked.status, 409);
    assert.match(String(blocked.body.type), /workflow-in-use$/);
    await api().delete(`${base}/suites/${suiteId}`).set(as(owner));
    assert.equal((await api().delete(`${base}/workflows/${workflowId}`).set(as(owner))).status, 204);
  });

  test("un conjunto no vuelve solo si su flujo sigue en la papelera", async () => {
    const base = await newProject("flows-dataset");
    const flow = await api().post(`${base}/workflows`).set(as(owner)).send({ name: "alta" });
    const workflowId: string = flow.body.workflowId;
    const dataset = await api()
      .post(`${base}/workflows/${workflowId}/datasets`)
      .set(as(owner))
      .send({ name: "clientes", rows: [] });
    const datasetId: string = dataset.body.datasetId;

    await api().delete(`${base}/workflows/${workflowId}`).set(as(owner));
    const early = await api().post(`${base}/datasets/${datasetId}/restore`).set(as(owner));
    assert.equal(early.status, 409);
    assert.match(String(early.body.type), /workflow-deleted$/);

    await api().post(`${base}/workflows/${workflowId}/restore`).set(as(owner));
    assert.equal((await api().post(`${base}/datasets/${datasetId}/restore`).set(as(owner))).status, 204);
  });
});
