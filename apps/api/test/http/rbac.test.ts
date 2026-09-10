/**
 * Authorization, per endpoint, over HTTP.
 *
 * The plan's acceptance criterion for this phase is "RBAC probado por endpoint", and the reason
 * it is worth a file of its own is that these bugs are invisible in normal use: every one of
 * them looks like a working application right up until somebody sends a request the UI does not
 * offer. The tests are written from the attacker's side — what happens when you ask for
 * something you are not entitled to — rather than from the happy path.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";
import type { Role } from "@/modules/iam/domain/model";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { userId: string; organizationId: string; accessToken: string; email: string };

async function signUp(email: string, organizationName?: string): Promise<Actor> {
  const password = "una-contraseña-larga";
  const registered = await api()
    .post("/auth/register")
    .send({ email, password, name: email.split("@")[0], organizationName });
  const session = await api().post("/auth/login").send({ email, password });
  // Asserted rather than trusted. When login fails the token is `undefined`, every later request
  // goes out as `Bearer undefined`, and the suite reports a 401 on whatever line happens to be
  // next — which describes the symptom and hides the cause.
  assert.equal(session.status, 200, `no se pudo iniciar sesión como ${email}: ${JSON.stringify(session.body)}`);
  assert.ok(session.body.accessToken, `el login de ${email} no devolvió token`);
  return {
    userId: registered.body.userId,
    organizationId: registered.body.organizationId,
    accessToken: session.body.accessToken,
    email,
  };
}

/** Puts an existing account into somebody else's organization at a given role, without going
 * through the invitation flow — that flow has its own tests, and using it here would make every
 * assertion depend on it. */
async function joinAs(actor: Actor, organizationId: string, role: Role) {
  await context.repositories.memberships.save({ organizationId, userId: actor.userId, role, createdAt: new Date() });
}

let owner: Actor;
let admin: Actor;
let editor: Actor;
let viewer: Actor;
let outsider: Actor;

before(async () => {
  context = await createTestApp();
  owner = await signUp("owner@example.com", "Acme");
  admin = await signUp("admin@example.com");
  editor = await signUp("editor@example.com");
  viewer = await signUp("viewer@example.com");
  outsider = await signUp("outsider@example.com");
  await joinAs(admin, owner.organizationId, "admin");
  await joinAs(editor, owner.organizationId, "editor");
  await joinAs(viewer, owner.organizationId, "viewer");
});
after(async () => {
  await context?.close();
});

const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.accessToken}` });

describe("aislamiento entre organizaciones", () => {
  test("un ajeno recibe 403 sobre una organización de la que no es miembro", async () => {
    // The whole tenant boundary in one assertion: the id in the URL is a question, and
    // membership is the answer.
    const response = await api().get(`/orgs/${owner.organizationId}/members`).set(as(outsider));
    assert.equal(response.status, 403);
    assert.equal(response.body.detail, "No perteneces a esta organización");
  });

  test("un ajeno no puede invitar, cambiar roles ni expulsar", async () => {
    // Sequential, not `Promise.all`: supertest binds an ephemeral port per request, and firing
    // four at the same listener races the bind and surfaces as ECONNRESET — a flake that says
    // nothing about authorization.
    const attempts = [
      () =>
        api()
          .post(`/orgs/${owner.organizationId}/invitations`)
          .set(as(outsider))
          .send({ email: "x@example.com", role: "admin" }),
      () =>
        api()
          .patch(`/orgs/${owner.organizationId}/members/${viewer.userId}`)
          .set(as(outsider))
          .send({ role: "viewer" }),
      () => api().delete(`/orgs/${owner.organizationId}/members/${viewer.userId}`).set(as(outsider)),
      () => api().get(`/orgs/${owner.organizationId}/tokens`).set(as(outsider)),
    ];
    for (const attempt of attempts) assert.equal((await attempt()).status, 403);
  });

  test("sin credencial ninguna ruta de organización responde", async () => {
    const response = await api().get(`/orgs/${owner.organizationId}/members`);
    assert.equal(response.status, 401);
  });
});

describe("la escalera de roles", () => {
  test("viewer lee los miembros pero no los gestiona", async () => {
    assert.equal((await api().get(`/orgs/${owner.organizationId}/members`).set(as(viewer))).status, 200);
    assert.equal(
      (
        await api()
          .post(`/orgs/${owner.organizationId}/invitations`)
          .set(as(viewer))
          .send({ email: "n@example.com", role: "viewer" })
      ).status,
      403,
    );
  });

  test("editor tampoco gestiona miembros ni credenciales", async () => {
    // `editor` edits the matrix; environments and credentials are `admin`, because those are the
    // two capabilities that can damage something outside this system.
    assert.equal(
      (
        await api()
          .post(`/orgs/${owner.organizationId}/invitations`)
          .set(as(editor))
          .send({ email: "n@example.com", role: "viewer" })
      ).status,
      403,
    );
    assert.equal((await api().get(`/orgs/${owner.organizationId}/tokens`).set(as(editor))).status, 403);
  });

  test("admin invita, y no por encima de su propio nivel", async () => {
    const allowed = await api()
      .post(`/orgs/${owner.organizationId}/invitations`)
      .set(as(admin))
      .send({ email: "nuevo@example.com", role: "editor" });
    assert.equal(allowed.status, 201);

    // Without this rule an admin invites a new owner and then either accepts it themselves or
    // asks the invitee for the link: a one-step escalation dressed as an ordinary feature.
    const escalation = await api()
      .post(`/orgs/${owner.organizationId}/invitations`)
      .set(as(admin))
      .send({ email: "otro@example.com", role: "owner" });
    assert.equal(escalation.status, 403);
    assert.match(escalation.body.type, /role-escalation$/);
  });

  test("nadie puede cambiar su propio rol", async () => {
    const response = await api()
      .patch(`/orgs/${owner.organizationId}/members/${admin.userId}`)
      .set(as(admin))
      .send({ role: "owner" });
    assert.equal(response.status, 403);
    assert.match(response.body.type, /self-role-change$/);
  });

  test("un admin no puede degradar a un owner", async () => {
    const response = await api()
      .patch(`/orgs/${owner.organizationId}/members/${owner.userId}`)
      .set(as(admin))
      .send({ role: "viewer" });
    assert.equal(response.status, 403);
    assert.match(response.body.type, /role-escalation$/);
  });

  test("un rol inexistente es 422 y no un rol silenciosamente ignorado", async () => {
    const response = await api()
      .patch(`/orgs/${owner.organizationId}/members/${viewer.userId}`)
      .set(as(admin))
      .send({ role: "superuser" });
    assert.equal(response.status, 422);
  });
});

describe("la organización no puede quedarse sin dueño", () => {
  test("el último owner no puede degradarse ni ser degradado", async () => {
    // An organization with no owner has nobody who can appoint one, so its projects,
    // environments and stored credentials become unreachable by everybody.
    const response = await api()
      .patch(`/orgs/${owner.organizationId}/members/${owner.userId}`)
      .set(as(owner))
      .send({ role: "admin" });
    // Blocked by the self-change rule first; the last-owner rule is what catches it when a
    // second owner exists and then leaves.
    assert.equal(response.status, 403);

    const removal = await api().delete(`/orgs/${owner.organizationId}/members/${owner.userId}`).set(as(owner));
    assert.equal(removal.status, 409);
    assert.match(removal.body.type, /last-owner$/);
  });

  test("con dos owners, uno puede irse", async () => {
    const second = await signUp("second-owner@example.com");
    await joinAs(second, owner.organizationId, "owner");
    assert.equal(
      (await api().delete(`/orgs/${owner.organizationId}/members/${second.userId}`).set(as(second))).status,
      204,
    );
  });
});

describe("salir de una organización", () => {
  test("un viewer puede irse solo, sin permiso para gestionar a nadie", async () => {
    const leaver = await signUp("leaver@example.com");
    await joinAs(leaver, owner.organizationId, "viewer");
    assert.equal(
      (await api().delete(`/orgs/${owner.organizationId}/members/${leaver.userId}`).set(as(leaver))).status,
      204,
    );
    assert.equal(await context.repositories.memberships.find(owner.organizationId, leaver.userId), null);
  });

  test("un viewer no puede expulsar a otro", async () => {
    const response = await api().delete(`/orgs/${owner.organizationId}/members/${editor.userId}`).set(as(viewer));
    assert.equal(response.status, 403);
  });
});

describe("invitaciones", () => {
  test("la invitación solo la acepta la dirección a la que se envió", async () => {
    // Otherwise the link is a bearer token for a role: anyone it is forwarded to, deliberately
    // or by a mail rule, can accept it with their own account.
    const invited = await api()
      .post(`/orgs/${owner.organizationId}/invitations`)
      .set(as(owner))
      .send({ email: "destinatario@example.com", role: "editor" });
    const wrongPerson = await api().post("/invitations/accept").set(as(outsider)).send({ token: invited.body.token });
    assert.equal(wrongPerson.status, 403);
    assert.match(wrongPerson.body.type, /invitation-wrong-recipient$/);

    const recipient = await signUp("destinatario@example.com");
    const accepted = await api().post("/invitations/accept").set(as(recipient)).send({ token: invited.body.token });
    assert.equal(accepted.status, 200);
    assert.equal((await context.repositories.memberships.find(owner.organizationId, recipient.userId))?.role, "editor");
  });

  test("una invitación ya aceptada no vale una segunda vez", async () => {
    const invited = await api()
      .post(`/orgs/${owner.organizationId}/invitations`)
      .set(as(owner))
      .send({ email: "unavez@example.com", role: "viewer" });
    const person = await signUp("unavez@example.com");
    assert.equal(
      (await api().post("/invitations/accept").set(as(person)).send({ token: invited.body.token })).status,
      200,
    );
    assert.equal(
      (await api().post("/invitations/accept").set(as(person)).send({ token: invited.body.token })).status,
      404,
    );
  });

  test("un token de invitación inventado es 404", async () => {
    const response = await api().post("/invitations/accept").set(as(outsider)).send({ token: "no-existe" });
    assert.equal(response.status, 404);
  });

  test("la lista de miembros no expone el hash de ninguna invitación", async () => {
    const response = await api().get(`/orgs/${owner.organizationId}/members`).set(as(viewer));
    assert.equal(response.status, 200);
    assert.equal(JSON.stringify(response.body).includes("tokenHash"), false);
  });
});

describe("tokens de servicio", () => {
  test("el token se muestra una vez y después solo su prefijo", async () => {
    const created = await api().post(`/orgs/${owner.organizationId}/tokens`).set(as(owner)).send({ name: "CI" });
    assert.equal(created.status, 201);
    assert.match(created.body.token, /^eqt_/);

    const listed = await api().get(`/orgs/${owner.organizationId}/tokens`).set(as(owner));
    // A product that can show you a token you created last month is a product whose database
    // dump is a set of live credentials.
    assert.equal(JSON.stringify(listed.body).includes(created.body.token), false);
    assert.equal(listed.body[0].preview, created.body.preview);
  });

  test("un token de servicio autentica pero no gestiona miembros", async () => {
    const created = await api().post(`/orgs/${owner.organizationId}/tokens`).set(as(owner)).send({ name: "CI" });
    const withToken = { Authorization: `Bearer ${created.body.token}` };

    assert.equal((await api().get(`/orgs/${owner.organizationId}/members`).set(withToken)).status, 200);
    // A leaked build secret must not be an account takeover.
    const invite = await api()
      .post(`/orgs/${owner.organizationId}/invitations`)
      .set(withToken)
      .send({ email: "z@example.com", role: "admin" });
    assert.equal(invite.status, 403);
    assert.match(invite.body.type, /api-token-role$/);
  });

  test("un token de servicio no puede actuar sobre otra organización", async () => {
    const created = await api().post(`/orgs/${owner.organizationId}/tokens`).set(as(owner)).send({ name: "CI" });
    const response = await api()
      .get(`/orgs/${outsider.organizationId}/members`)
      .set({ Authorization: `Bearer ${created.body.token}` });
    assert.equal(response.status, 403);
  });

  test("un token revocado deja de autenticar", async () => {
    const created = await api().post(`/orgs/${owner.organizationId}/tokens`).set(as(owner)).send({ name: "temporal" });
    assert.equal(
      (await api().delete(`/orgs/${owner.organizationId}/tokens/${created.body.id}`).set(as(owner))).status,
      204,
    );
    const response = await api()
      .get(`/orgs/${owner.organizationId}/members`)
      .set({ Authorization: `Bearer ${created.body.token}` });
    assert.equal(response.status, 401);
  });

  test("revocar un token de otra organización es 404 y no 403", async () => {
    // 403 would confirm the id exists, which is a cross-tenant oracle. To this caller it does
    // not exist.
    const created = await api().post(`/orgs/${owner.organizationId}/tokens`).set(as(owner)).send({ name: "ajeno" });
    const response = await api().delete(`/orgs/${outsider.organizationId}/tokens/${created.body.id}`).set(as(outsider));
    assert.equal(response.status, 404);
  });
});
