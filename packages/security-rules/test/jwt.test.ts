import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { base64UrlDecode, decodeJwt, forgeAlgNone, forgeExpired, forgeTampered } from "../src/jwt.ts";
import { forgeAttackToken } from "../src/plan.ts";
import { jwt } from "./fixtures.ts";

describe("el JWT", () => {
  const real = jwt({ alg: "HS256", typ: "JWT" }, { sub: "u1", role: "vendedor", exp: 9_999_999_999 }, "firma-real");

  it("decodifica las tres partes, con o sin el prefijo Bearer", () => {
    const plain = decodeJwt(real)!;
    assert.equal(plain.header.alg, "HS256");
    assert.equal(plain.payload.sub, "u1");
    assert.equal(plain.signature, "firma-real");
    assert.deepEqual(decodeJwt(`bearer   ${real}`), plain);
  });

  it("base64url sobrevive a texto no ASCII y a segmentos sin relleno", () => {
    // A real token with a UTF-8 claim, encoded the way an issuer would (bytes, not UTF-16).
    const utf8 = (value: unknown) =>
      btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
        .replace(/=+$/, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    const token = `${utf8({ alg: "HS256" })}.${utf8({ name: "Añíbal ✓" })}.firma`;
    assert.equal(decodeJwt(token)!.payload.name, "Añíbal ✓");
    assert.equal(decodeJwt(forgeTampered(token)!)!.payload.name, "Añíbal ✓", "forjar no rompe el UTF-8");
    assert.equal(base64UrlDecode("YQ"), "a");
  });

  it("un segmento que no es base64 se lee como vacío, no revienta", () => {
    assert.equal(base64UrlDecode("%%%"), "");
    assert.equal(decodeJwt("%%%.%%%.x"), null);
  });

  it("no es un JWT si no tiene tres partes o si header/payload no son objetos JSON", () => {
    assert.equal(decodeJwt("opaco-sin-puntos"), null);
    assert.equal(decodeJwt("a.b"), null);
    assert.equal(decodeJwt(`${real}.extra`), null);
    const array = `${btoa("[1,2]")}.${btoa('{"a":1}')}.x`;
    assert.equal(decodeJwt(array), null, "un array no es un header");
    const notJson = `${btoa("hola")}.${btoa('{"a":1}')}.x`;
    assert.equal(decodeJwt(notJson), null, "un texto no JSON no es un header");
    const nullPayload = `${btoa('{"alg":"HS256"}')}.${btoa("null")}.x`;
    assert.equal(decodeJwt(nullPayload), null);
  });

  it("alg:none conserva las claims y deja la firma vacía", () => {
    const forged = forgeAlgNone(real)!;
    assert.ok(forged.endsWith("."));
    const decoded = decodeJwt(forged)!;
    assert.equal(decoded.header.alg, "none");
    assert.equal(decoded.header.typ, "JWT");
    assert.equal(decoded.payload.sub, "u1");
    assert.equal(decoded.signature, "");
  });

  it("caducado conserva algoritmo y firma y pone exp en el pasado", () => {
    const decoded = decodeJwt(forgeExpired(real)!)!;
    assert.equal(decoded.header.alg, "HS256");
    assert.equal(decoded.signature, "firma-real");
    assert.equal(decoded.payload.sub, "u1");
    assert.ok((decoded.payload.exp as number) < Math.floor(Date.now() / 1000));
  });

  it("manipulado escala el rol y conserva la firma original", () => {
    const decoded = decodeJwt(forgeTampered(real)!)!;
    assert.equal(decoded.payload.role, "admin");
    assert.equal(decoded.payload.admin, true);
    assert.equal(decoded.payload.isAdmin, true);
    assert.equal(decoded.payload.exp, 9_999_999_999);
    assert.equal(decoded.signature, "firma-real");
  });

  it("no se forja nada a partir de un token que no es JWT", () => {
    assert.equal(forgeAlgNone("opaco"), null);
    assert.equal(forgeExpired("opaco"), null);
    assert.equal(forgeTampered("opaco"), null);
    for (const attack of ["alg-none", "expired", "tampered"]) assert.equal(forgeAttackToken(attack, "opaco"), null);
  });

  it("un ataque desconocido no forja token", () => {
    assert.equal(forgeAttackToken("kid-injection", real), null);
  });
});
