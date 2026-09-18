/**
 * Solicitudes de fusión, por HTTP: crearlas desde la bifurcación, revisarlas desde el original y
 * fusionarlas con la misma comparación que la fusión directa.
 *
 * Lo que importa aquí: quién puede cada cosa (un viewer lee la lista y nada más, el autor no se
 * aprueba ni se rechaza, y retirar es solo suyo), que otra organización no ve nada, que fusionar
 * recalcula —una huella vieja es un 409 y la solicitud sigue abierta— y que el correo no lleva la
 * comparación.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";
import type { Role } from "@/modules/iam/domain/model";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { userId: string; organizationId: string; token: string; email: string };
async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api()
    .post("/auth/register")
    .send({ email, password, name: email.split("@")[0] });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200, JSON.stringify(session.body));
  return {
    userId: registered.body.userId,
    organizationId: registered.body.organizationId,
    token: session.body.accessToken,
    email,
  };
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });
async function joinAs(actor: Actor, organizationId: string, role: Role) {
  await context.repositories.memberships.save({ organizationId, userId: actor.userId, role, createdAt: new Date() });
}

let owner: Actor;
let author: Actor;
let viewer: Actor;
let outsider: Actor;
const org = () => `/orgs/${owner.organizationId}/projects`;
const unique = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

before(async () => {
  context = await createTestApp();
  owner = await signUp("mr-owner@example.com");
  author = await signUp("mr-author@example.com");
  viewer = await signUp("mr-viewer@example.com");
  outsider = await signUp("mr-outsider@example.com");
  await joinAs(author, owner.organizationId, "editor");
  await joinAs(viewer, owner.organizationId, "viewer");
});
after(async () => {
  await context?.close();
});

/** Un original con un endpoint y su bifurcación, y un cambio en la bifurcación que llevar. */
async function forkWithChange() {
  const created = await api()
    .post(org())
    .set(as(owner))
    .send({ name: unique("original") });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const parentId = created.body.projectId as string;
  const parent = `${org()}/${parentId}`;
  await api().post(`${parent}/endpoints`).set(as(owner)).send({ method: "GET", path: "/orders" });
  const forked = await api()
    .post(`${parent}/fork`)
    .set(as(author))
    .send({ name: unique("bifurcacion") });
  assert.equal(forked.status, 201, JSON.stringify(forked.body));
  const forkId = forked.body.projectId as string;
  const forkBase = `${org()}/${forkId}`;
  const [row] = (await api().get(`${forkBase}/endpoints`).set(as(author))).body.data as { id: string }[];
  await api().patch(`${forkBase}/endpoints/${row!.id}`).set(as(author)).send({ description: "descripción-privada" });
  return { parentId, parent, forkId, forkBase };
}

const open = (forkBase: string, actor = author, title = "Describir pedidos") =>
  api().post(`${forkBase}/merge-requests`).set(as(actor)).send({ title, description: "Para el equipo de pagos" });

describe("el ciclo de una solicitud", () => {
  test("se crea desde la bifurcación, se comenta, se aprueba y se fusiona con la comparación de ahora", async () => {
    const { parent, parentId, forkBase } = await forkWithChange();
    const created = await open(forkBase);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id as string;
    assert.equal((await open(forkBase)).status, 409, "una sola pendiente por bifurcación");

    // En la lista del original y en la de la bifurcación; un viewer la ve.
    const listed = await api().get(`${parent}/merge-requests`).set(as(viewer));
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(
      listed.body.map((row: { id: string; status: string; changes: number; author: { name: string } }) => [
        row.id,
        row.status,
        row.changes,
        row.author.name,
      ]),
      [[id, "open", 1, "mr-author"]],
    );
    assert.equal((await api().get(`${forkBase}/merge-requests`).set(as(author))).body[0].id, id);

    const commented = await api()
      .post(`${parent}/merge-requests/${id}/comments`)
      .set(as(owner))
      .send({ body: "¿Y el ejemplo?" });
    assert.equal(commented.status, 204, JSON.stringify(commented.body));
    const self = await api().post(`${parent}/merge-requests/${id}/approve`).set(as(author)).send({});
    assert.equal(self.status, 403, JSON.stringify(self.body));
    const approved = await api().post(`${parent}/merge-requests/${id}/approve`).set(as(owner)).send({ body: "Bien" });
    assert.equal(approved.status, 204, JSON.stringify(approved.body));

    const detail = await api().get(`${parent}/merge-requests/${id}`).set(as(owner));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.status, "approved");
    assert.equal(detail.body.approvals, 1);
    assert.deepEqual(detail.body.can, { approve: true, decline: true, close: false, merge: true, comment: true });
    assert.deepEqual(
      detail.body.requested.map((entry: { key: string }) => entry.key),
      ["GET /orders"],
    );
    assert.equal(detail.body.current.target.id, parentId);

    const merged = await api()
      .post(`${parent}/merge-requests/${id}/merge`)
      .set(as(owner))
      .send({ token: detail.body.current.token });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal(merged.body.applied.endpoint, 1);
    const [row] = (await api().get(`${parent}/endpoints`).set(as(owner))).body.data as { description: string }[];
    assert.equal(row!.description, "descripción-privada");

    const after = (await api().get(`${parent}/merge-requests/${id}`).set(as(owner))).body;
    assert.equal(after.status, "merged");
    assert.equal(after.mergedVersion, 2);
    assert.equal(after.current, null);
    assert.deepEqual(
      after.events.map((event: { kind: string }) => event.kind),
      ["comment", "approved", "merged"],
    );
    const again = await api()
      .post(`${parent}/merge-requests/${id}/merge`)
      .set(as(owner))
      .send({ token: detail.body.current.token });
    assert.equal(again.status, 409, JSON.stringify(again.body));

    // El autor recibe los avisos, y ninguno lleva la comparación.
    await new Promise((resolve) => setImmediate(resolve));
    const mails = context.mailer.sent.filter((mail) => mail.to === author.email);
    assert.ok(mails.some((mail) => mail.subject.includes("aprobó")));
    assert.ok(mails.some((mail) => mail.subject.includes("fusionó")));
    assert.ok(mails.every((mail) => !mail.text.includes("descripción-privada") && !mail.html.includes("/orders")));
  });

  test("fusionar recalcula: una huella vieja es 409, un conflicto sin decidir 422, y la solicitud sigue abierta", async () => {
    const { parent, forkBase } = await forkWithChange();
    const id = (await open(forkBase)).body.id as string;
    const token = (await api().get(`${parent}/merge-requests/${id}`).set(as(owner))).body.current.token;
    // El original cambia el mismo endpoint después de crearla: ahora es un conflicto.
    const [row] = (await api().get(`${parent}/endpoints`).set(as(owner))).body.data as { id: string }[];
    await api().patch(`${parent}/endpoints/${row!.id}`).set(as(owner)).send({ description: "del original" });

    const stale = await api().post(`${parent}/merge-requests/${id}/merge`).set(as(owner)).send({ token });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    const current = (await api().get(`${parent}/merge-requests/${id}`).set(as(owner))).body;
    assert.equal(current.current.entries[0].status, "conflict");
    // Lo pedido no cambia: es lo que había al crearla.
    assert.equal(current.requested[0].status, "incoming");
    const unresolved = await api()
      .post(`${parent}/merge-requests/${id}/merge`)
      .set(as(owner))
      .send({ token: current.current.token });
    assert.equal(unresolved.status, 422, JSON.stringify(unresolved.body));
    assert.equal((await api().get(`${parent}/merge-requests/${id}`).set(as(owner))).body.status, "open");

    const merged = await api()
      .post(`${parent}/merge-requests/${id}/merge`)
      .set(as(owner))
      .send({ token: current.current.token, resolutions: { "endpoint:GET /orders": "target" } });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
  });

  test("retirar es del autor y rechazar de quien revisa; una cerrada ya no se decide pero se comenta", async () => {
    const { parent, forkBase } = await forkWithChange();
    const first = (await open(forkBase)).body.id as string;
    assert.equal((await api().post(`${parent}/merge-requests/${first}/close`).set(as(owner)).send({})).status, 403);
    assert.equal((await api().post(`${parent}/merge-requests/${first}/close`).set(as(author)).send({})).status, 204);
    assert.equal((await api().post(`${parent}/merge-requests/${first}/approve`).set(as(owner)).send({})).status, 409);
    const late = await api()
      .post(`${forkBase}/merge-requests/${first}/comments`)
      .set(as(author))
      .send({ body: "La rehago" });
    assert.equal(late.status, 204, JSON.stringify(late.body));

    const second = (await open(forkBase)).body.id as string;
    assert.ok(second, "retirada la primera, se puede abrir otra");
    assert.equal((await api().post(`${parent}/merge-requests/${second}/decline`).set(as(author)).send({})).status, 403);
    const declined = await api()
      .post(`${parent}/merge-requests/${second}/decline`)
      .set(as(owner))
      .send({ body: "No es el momento" });
    assert.equal(declined.status, 204, JSON.stringify(declined.body));
    const statuses = (await api().get(`${parent}/merge-requests`).set(as(owner))).body.map(
      (row: { status: string }) => row.status,
    );
    assert.deepEqual(statuses.sort(), ["closed", "declined"]);
    assert.equal((await api().post(`${parent}/merge-requests/${second}/sideways`).set(as(owner)).send({})).status, 422);
  });

  test("una bifurcación sin nada que llevar no abre solicitud, y el título es obligatorio", async () => {
    const { parent } = await forkWithChange();
    const empty = await api()
      .post(`${parent}/fork`)
      .set(as(author))
      .send({ name: unique("vacia") });
    const emptyBase = `${org()}/${empty.body.projectId}`;
    const refused = await open(emptyBase);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.type, /merge-request-empty/);
    const untitled = await api().post(`${emptyBase}/merge-requests`).set(as(author)).send({ title: "  " });
    assert.equal(untitled.status, 422, JSON.stringify(untitled.body));
    const notFork = await open(parent);
    assert.equal(notFork.status, 409, JSON.stringify(notFork.body));
  });
});

describe("permisos y organizaciones", () => {
  test("un viewer lee la lista y nada más; otra organización no ve la solicitud", async () => {
    const { parent, forkBase, parentId } = await forkWithChange();
    const id = (await open(forkBase)).body.id as string;

    assert.equal((await open(forkBase, viewer)).status, 403);
    assert.equal((await api().get(`${parent}/merge-requests/${id}`).set(as(viewer))).status, 403);
    assert.equal(
      (await api().post(`${parent}/merge-requests/${id}/comments`).set(as(viewer)).send({ body: "hola" })).status,
      403,
    );
    assert.equal((await api().post(`${parent}/merge-requests/${id}/approve`).set(as(viewer)).send({})).status, 403);

    // Alguien de fuera, en nuestra organización: 403. En la suya, con nuestros ids: no existe.
    assert.equal((await api().get(`${parent}/merge-requests`).set(as(outsider))).status, 403);
    const theirs = `/orgs/${outsider.organizationId}/projects/${parentId}/merge-requests`;
    assert.equal((await api().get(theirs).set(as(outsider))).status, 404);
    assert.equal((await api().get(`${theirs}/${id}`).set(as(outsider))).status, 404);
    const ownProject = await api()
      .post(`/orgs/${outsider.organizationId}/projects`)
      .set(as(outsider))
      .send({ name: "Suyo" });
    const across = `/orgs/${outsider.organizationId}/projects/${ownProject.body.projectId}/merge-requests/${id}`;
    assert.equal((await api().get(across).set(as(outsider))).status, 404);
    assert.equal((await api().post(`${across}/approve`).set(as(outsider)).send({})).status, 404);

    // Bajo un proyecto de la organización que no es ninguno de los dos: tampoco.
    const other = await api()
      .post(org())
      .set(as(owner))
      .send({ name: unique("otro") });
    const unrelated = await api().get(`${org()}/${other.body.projectId}/merge-requests/${id}`).set(as(owner));
    assert.equal(unrelated.status, 404, JSON.stringify(unrelated.body));
    assert.deepEqual((await api().get(`${org()}/${other.body.projectId}/merge-requests`).set(as(owner))).body, []);
  });

  test("dos fusiones a la vez de la misma solicitud: una escribe, la otra es 409", async () => {
    const { parent, forkBase } = await forkWithChange();
    const id = (await open(forkBase)).body.id as string;
    const token = (await api().get(`${parent}/merge-requests/${id}`).set(as(owner))).body.current.token;
    context.repositories.forks.holdApplies(2);
    const results = await Promise.all([
      api().post(`${parent}/merge-requests/${id}/merge`).set(as(owner)).send({ token }),
      api().post(`${parent}/merge-requests/${id}/merge`).set(as(owner)).send({ token }),
    ]);
    assert.deepEqual(
      results.map((response) => response.status).sort(),
      [200, 409],
      JSON.stringify(results.map((response) => response.body)),
    );
    assert.equal((await api().get(`${parent}/merge-requests/${id}`).set(as(owner))).body.status, "merged");
    const events = await context.repositories.mergeRequests.listEvents(id);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["merged"],
    );
  });
});
