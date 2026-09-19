/**
 * Endpoints y entornos por la API: lo que un token de servicio hace a su nombre (su tarro de
 * cookies, su token de sesión), «Enviar» sin multipart, y los 4xx que ninguna prueba pedía —un
 * fichero en blanco, un cURL sin URL, los ejemplos de un endpoint que no existe, una cookie para
 * una URL que no es http(s)—.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { organizationId: string; token: string };
async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200);
  return { organizationId: registered.body.organizationId, token: session.body.accessToken };
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

let target: Server;
let origin: string;
let owner: Actor;
let projectId: string;
let service: { id: string; token: string };
const base = () => `/orgs/${owner.organizationId}/projects/${projectId}`;
const problem = (body: { type?: string }) => body.type?.split("/").pop();

before(async () => {
  target = createServer((_incoming, response) => {
    response.writeHead(200, { "content-type": "application/json", "set-cookie": "ci=1; Path=/" });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;

  context = await createTestApp();
  owner = await signUp("c100-epenv@example.com");
  const created = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Tienda", baseUrl: origin });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  projectId = created.body.projectId;
  const minted = await api().post(`/orgs/${owner.organizationId}/tokens`).set(as(owner)).send({ name: "CI" });
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  service = { id: minted.body.id, token: minted.body.token };
});

after(async () => {
  await context?.close();
  await new Promise<void>((resolve) => target.close(() => resolve()));
});

describe("un token de servicio actúa a su nombre", () => {
  test("«Enviar» sin multipart funciona, y la cookie que contesta el destino va al tarro del token", async () => {
    const sent = await api()
      .post(`${base()}/endpoints/send`)
      .set({ Authorization: `Bearer ${service.token}` })
      .send({ request: JSON.stringify({ method: "GET", path: "/ping" }) });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.response.status, 200);
    assert.deepEqual(sent.body.cookies.stored, ["ci=127.0.0.1/"]);

    const ofToken = await context.repositories.cookieJar.list(service.id, projectId);
    assert.deepEqual(ofToken.map((cookie) => cookie.name), ["ci"]);
    const mine = await api().get(`${base()}/cookies`).set(as(owner));
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.cookies ?? mine.body, []);
  });

  test("el token de sesión que se lee es el del token, no el de la persona", async () => {
    await context.repositories.sessionTokens.save({
      actorId: service.id,
      projectId,
      tokenCiphertext: context.app.get<SecretCipherPort>(SECRET_CIPHER).encrypt("del-ci"),
      claims: null,
      expiresAt: null,
      capturedAt: new Date(),
      source: "script",
    });
    const asService = await api().get(`${base()}/session-token`).set({ Authorization: `Bearer ${service.token}` });
    assert.equal(asService.status, 200);
    assert.equal(asService.body.token.source, "script");
    const asOwner = await api().get(`${base()}/session-token`).set(as(owner));
    assert.deepEqual(asOwner.body, { token: null });
  });
});

describe("los 4xx que faltaban", () => {
  test("un fichero en blanco es un 422 `file-empty`", async () => {
    const response = await api()
      .post(`${base()}/endpoints/import/file`)
      .set(as(owner))
      .attach("file", Buffer.from("  \n\t "), "vacio.md");
    assert.equal(response.status, 422);
    assert.equal(problem(response.body), "file-empty");
    assert.deepEqual(response.body.errors, [{ field: "file", detail: "No hay nada que leer" }]);
  });

  test("un cURL sin URL es un 422 `curl-invalid` que dice por qué", async () => {
    const response = await api().post(`${base()}/endpoints/import/curl`).set(as(owner)).send({ curl: "curl -X POST" });
    assert.equal(response.status, 422);
    assert.equal(problem(response.body), "curl-invalid");
    assert.deepEqual(response.body.errors, [{ field: "curl", detail: "El comando no lleva ninguna URL" }]);
  });

  test("los ejemplos de un endpoint que no existe son un 404, no una lista vacía", async () => {
    const response = await api().get(`${base()}/endpoints/${randomUUID()}/examples`).set(as(owner));
    assert.equal(response.status, 404);
    assert.equal(problem(response.body), "endpoint-not-found");
  });

  test("una cookie para una URL que no es http(s) es un 422 `cookie-url-missing`", async () => {
    const response = await api()
      .post(`${base()}/cookies`)
      .set(as(owner))
      .send({ url: "ftp://files.example.com", setCookie: "a=1; Path=/" });
    assert.equal(response.status, 422);
    assert.equal(problem(response.body), "cookie-url-missing");
    assert.deepEqual(response.body.errors.map((error: { field: string }) => error.field), ["url"]);
  });
});
