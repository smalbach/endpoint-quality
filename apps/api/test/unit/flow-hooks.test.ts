import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  FLOW_HOOK_TOKEN,
  REDACTED_TOKEN,
  flowHookKey,
  flowHookToken,
  flowHookUrls,
  hashFlowHookToken,
  keptHookHeaders,
  readHookPayload,
} from "@/modules/runs/domain/flow-hooks";
import { MASK } from "@/modules/endpoints/domain/examples";

const SECRET = "s".repeat(48);
const ID = "5f0c2f3e-7a51-4b1e-9d3a-0e2f4c6a8b10";

describe("el token de una espera", () => {
  test("se deriva del id con la clave del servidor: 43 caracteres de URL, siempre el mismo", () => {
    const token = flowHookToken(flowHookKey(SECRET), ID);
    assert.match(token, FLOW_HOOK_TOKEN);
    assert.equal(flowHookToken(flowHookKey(SECRET), ID), token, "cualquier instancia calcula la misma URL");
    assert.notEqual(flowHookToken(flowHookKey("t".repeat(48)), ID), token, "otra clave, otro token");
    assert.notEqual(flowHookToken(flowHookKey(SECRET), ID.replace("5f", "6f")), token);
  });

  test("lo que se guarda es su hash, y la URL tapada no lo lleva", () => {
    const token = flowHookToken(flowHookKey(SECRET), ID);
    assert.notEqual(hashFlowHookToken(token), token);
    const urls = flowHookUrls(
      { PORT: 3001, JWT_ACCESS_SECRET: SECRET, PUBLIC_API_URL: "https://api.example.com/v1/" },
      ID,
    );
    assert.equal(urls.url, `https://api.example.com/v1/hooks/flows/${token}`);
    assert.equal(urls.redactedUrl, `https://api.example.com/v1/hooks/flows/${REDACTED_TOKEN}`);
  });
});

describe("lo que se guarda de una llamada", () => {
  test("cabeceras: lista blanca y x-…, credenciales tapadas, la red de delante fuera", () => {
    const kept = keptHookHeaders({
      "Content-Type": "application/json",
      "Stripe-Signature": "t=1,v1=abc",
      "X-Event-Id": "evt_1",
      Authorization: "Bearer de-verdad",
      "X-Api-Key": "clave",
      Cookie: "sid=1",
      "X-Forwarded-For": "10.0.0.1",
      "X-Real-IP": "10.0.0.2",
      Host: "api.example.com",
    });
    assert.deepEqual(kept, {
      "content-type": "application/json",
      "stripe-signature": "t=1,v1=abc",
      "x-event-id": "evt_1",
      authorization: MASK,
      "x-api-key": MASK,
      cookie: MASK,
    });
  });

  test("cuerpo: JSON por nombre de campo y por forma de JWT, formulario por nombre, el resto tal cual", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.c2lnbmF0dXJlLWxhcmdh";
    const json = readHookPayload(
      "POST",
      { "content-type": "application/json" },
      Buffer.from(JSON.stringify({ id: 7, client_secret: "x", nested: { data: jwt } })),
      new Date("2026-01-01T00:00:00Z"),
    );
    assert.deepEqual(json.body, { id: 7, client_secret: MASK, nested: { data: MASK } });
    assert.ok(!json.raw.includes(jwt));
    assert.equal(json.receivedAt, "2026-01-01T00:00:00.000Z");

    const form = readHookPayload(
      "POST",
      { "content-type": "application/x-www-form-urlencoded" },
      Buffer.from("event=paid&password=hunter2"),
      new Date(),
    );
    assert.equal(form.body, `event=paid&password=${encodeURIComponent(MASK)}`);

    const text = readHookPayload("PUT", { "content-type": "text/plain" }, Buffer.from("listo"), new Date());
    assert.equal(text.body, "listo");
    const broken = readHookPayload("POST", { "content-type": "application/json" }, Buffer.from("{no"), new Date());
    assert.equal(broken.body, "{no", "un JSON que no parsea se queda como texto");
  });
});
