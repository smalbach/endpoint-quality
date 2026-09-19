/**
 * Lo capturado, por sus bordes: nombres mal codificados, pares sin valor, cuerpos cortados o con
 * bytes nulos, URL que no son URL; y la CA de captura cuando la tabla, el cifrado o el reloj no
 * cooperan.
 */
import "reflect-metadata";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";

import {
  captureItemFrom,
  captureToFlowCollection,
  captureToHar,
  credentialValues,
  redactCapturedBody,
  redactCapturedUrl,
  unimportable,
  viewCaptureItem,
  viewCaptureSession,
  type CaptureItem,
  type CaptureSession,
  type RawExchange,
} from "@/modules/captures/domain/model";
import { MASK } from "@/modules/endpoints/domain/examples";
import { CaptureAuthority } from "@/modules/captures/infrastructure/capture-authority";
import type { CaptureAuthorityRepositoryPort } from "@/modules/captures/domain/ports";
import { loadEnv } from "@/shared/config/env";
import { AesGcmSecretCipher, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { ConflictError } from "@/shared/errors/domain-error";
import { InMemoryCaptureAuthorityRepository } from "../support/in-memory-captures";
import { TEST_ENV } from "../support/test-app";

const raw = (patch: Partial<RawExchange> & { url: string }): RawExchange => ({
  at: new Date("2026-03-01T10:00:00Z"),
  method: "get",
  status: 200,
  encrypted: false,
  requestHeaders: {},
  requestBody: Buffer.alloc(0),
  requestBodyTruncated: false,
  responseHeaders: { "content-type": "application/json" },
  responseBody: Buffer.from("{}"),
  responseBodyTruncated: false,
  durationMs: 3,
  error: null,
  ...patch,
});
let seq = 0;
const item = (patch: Partial<RawExchange> & { url: string }): CaptureItem =>
  captureItemFrom(raw(patch), { sessionId: "s", projectId: "p", seq: ++seq });

describe("la redacción, por sus bordes", () => {
  test("en la URL, un par sin '=' y un nombre mal codificado se quedan tal cual", () => {
    assert.equal(redactCapturedUrl("https://a.test/x?flag&%E0%A4%A=1&token=abc"), `https://a.test/x?flag&%E0%A4%A=1&token=${encodeURIComponent(MASK)}`);
    // Un nombre de credencial sin valor no tiene nada que tapar.
    assert.equal(redactCapturedUrl("https://a.test/x?token"), "https://a.test/x?token");
    // Sin query, solo se quita el fragmento.
    assert.equal(redactCapturedUrl("https://a.test/x#y"), "https://a.test/x");
  });

  test("en un formulario, lo mismo: el par sin '=' y el nombre roto no se tocan, el + es un espacio", () => {
    const body = "solo&%E0%A4%A=v&pass+word=hunter2&api%5Fkey=k1234";
    assert.equal(
      redactCapturedBody(body, "application/x-www-form-urlencoded; charset=utf-8"),
      `solo&%E0%A4%A=v&pass+word=hunter2&api%5Fkey=${encodeURIComponent(MASK)}`,
    );
    assert.equal(redactCapturedBody("", "application/json"), "");
  });

  test("los valores de credencial salen de la query, los formularios y el JSON, sin atributos ni valores cortos", () => {
    const values = credentialValues(
      raw({
        url: "https://a.test/x?sinvalor&%E0%A4%A=zz&api_key=CLAVE%2BURL",
        requestHeaders: { "content-type": "application/x-www-form-urlencoded", "x-api-key": "abc" },
        requestBody: Buffer.from("password=FORM-SECRETO&nombre=ana"),
        responseHeaders: { "content-type": "application/json" },
        responseBody: Buffer.from(JSON.stringify({ data: [{ token: "TOKEN-EN-LISTA" }, { pin: 1234567 }], secret: MASK })),
      }),
    );
    // La clave de la URL, tal cual y decodificada; la del formulario; la de la lista del JSON.
    for (const expected of ["CLAVE%2BURL", "CLAVE+URL", "FORM-SECRETO", "TOKEN-EN-LISTA"])
      assert.ok(values.includes(expected), expected);
    // `abc` es demasiado corto para buscarlo en el texto, y la máscara no es un secreto.
    assert.ok(!values.includes("abc"));
    assert.ok(!values.includes(MASK));
    // De más largo a más corto: tapar primero el largo no deja trozos del corto a la vista.
    assert.deepEqual([...values].sort((a, b) => b.length - a.length), values);
  });

  test("un JSON demasiado hondo no se recorre más allá de 20 niveles, y uno roto no rompe nada", () => {
    let deep: unknown = { token: "HONDO-SECRETO" };
    for (let index = 0; index < 25; index += 1) deep = { nivel: deep };
    const values = credentialValues(
      raw({ url: "https://a.test/x", responseBody: Buffer.from(JSON.stringify(deep)) }),
    );
    assert.deepEqual(values, []);
    assert.deepEqual(credentialValues(raw({ url: "https://a.test/x", responseBody: Buffer.from("{roto") })), []);
  });

  test("un cuerpo de petición cortado se guarda sin parsear pero con los valores conocidos tapados", () => {
    const stored = item({
      url: "https://a.test/login",
      method: "post",
      requestHeaders: { Authorization: "Bearer VALOR-DE-SESION", "content-type": "application/json" },
      requestBody: Buffer.from('{"eco":"VALOR-DE-SESION","lista":[1,'),
      requestBodyTruncated: true,
    });
    assert.equal(stored.method, "POST");
    assert.equal(stored.requestBodyTruncated, true);
    assert.equal(stored.requestBody, `{"eco":"${MASK}","lista":[1,`);
  });

  test("una respuesta cortada tapa el JWT suelto y deja lo que no parece uno", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJhLWxhcmdh";
    const stored = item({
      url: "https://a.test/x",
      responseBody: Buffer.from(`{"nota":"${jwt}","version":"abcdefgh.ijklmnop.qrstuvwx","nombre":"ana","sigue`),
      responseBodyTruncated: true,
    });
    assert.ok(!stored.responseBody.includes(jwt));
    assert.ok(stored.responseBody.includes(MASK));
    assert.ok(stored.responseBody.includes("abcdefgh.ijklmnop.qrstuvwx"));
    assert.ok(stored.responseBody.includes('"nombre":"ana"'));
  });

  test("un cuerpo con un byte nulo no es texto y no se guarda; el error se tapa y se corta", () => {
    const stored = item({
      url: "https://a.test/x",
      requestHeaders: { Authorization: "Bearer SECRETO-EN-ERROR" },
      responseBody: Buffer.from("hola\u0000mundo"),
      error: `falló con SECRETO-EN-ERROR ${"x".repeat(600)}`,
    });
    assert.equal(stored.responseBody, "");
    assert.ok(!stored.error!.includes("SECRETO-EN-ERROR"));
    assert.equal(stored.error!.length, 500);
  });
});

describe("las vistas y el camino al import", () => {
  test("una sesión antigua sin la marca de descifrado se ve como que no descifra", () => {
    const session = {
      id: "s",
      projectId: "p",
      status: "stopped",
      tokenHash: "h",
      limits: { durationMs: 1, maxRequests: 1, maxBodyBytes: 1 },
      itemCount: 0,
      startedAt: new Date("2026-03-01T10:00:00Z"),
      expiresAt: new Date("2026-03-01T10:30:00Z"),
      stoppedAt: null,
      stopReason: "restart",
      startedBy: "u",
    } as unknown as CaptureSession;
    const view = viewCaptureSession(session);
    assert.equal(view.decryptHttps, false);
    assert.equal(view.stoppedAt, null);
    assert.equal(view.stopReason, "restart");
  });

  test("una URL que no es URL se enseña sin host, y una petición sin respuesta dice que no contestó", () => {
    const broken = item({ url: "no es una url", status: null, error: "ECONNRESET" });
    const view = viewCaptureItem(broken);
    assert.equal(view.host, "");
    assert.equal(view.noise, "no llegó a contestar");
    assert.equal(view.requestBody, "");
    assert.equal(unimportable(broken), null);
    const tunnel = item({ url: "https://a.test:443", method: "CONNECT", encrypted: true, status: null });
    assert.equal(unimportable(tunnel), "https://a.test:443: cifrado, sin detalle");
  });

  test("el HAR lleva el cuerpo de la petición y pone estado 0 a la que no contestó", () => {
    const posted = item({
      url: "https://a.test/pedidos",
      method: "POST",
      requestHeaders: { "content-type": "application/json" },
      requestBody: Buffer.from('{"a":1}'),
      status: null,
      error: "timeout",
    });
    const har = JSON.parse(captureToHar([posted]));
    const [entry] = har.log.entries;
    assert.equal(entry.response.status, 0);
    assert.equal(entry.request.postData.mimeType, "application/json");
    assert.deepEqual(JSON.parse(entry.request.postData.text), { a: 1 });
    assert.equal(entry.request.bodySize, Buffer.byteLength(entry.request.postData.text));
  });

  test("el flujo: una URL que no se parsea es su propio nombre, y un cuerpo que no es JSON va sin lenguaje", () => {
    const odd = item({
      url: "ruta-relativa",
      method: "POST",
      requestHeaders: { "content-type": "text/plain" },
      requestBody: Buffer.from("hola"),
    });
    const json = item({
      url: "https://a.test/v1/pedidos",
      method: "PUT",
      requestHeaders: { "Content-Type": "application/json" },
      requestBody: Buffer.from('{"b":2}'),
    });
    const failed = item({ url: "https://a.test/v1/caido", error: "sin respuesta", status: null });
    const flow = captureToFlowCollection("Captura", [json, failed, odd]);
    assert.equal(flow.steps, 2);
    const collection = JSON.parse(flow.text);
    // En el orden de llegada, no en el de la lista.
    assert.deepEqual(
      collection.item.map((entry: { name: string }) => entry.name),
      ["POST ruta-relativa", "PUT /v1/pedidos"],
    );
    assert.deepEqual(collection.item[0].request.body, { mode: "raw", raw: "hola" });
    assert.deepEqual(collection.item[1].request.body.options, { raw: { language: "json" } });
  });
});

/* ------------------------------------------------------------------ *
 * La CA de captura
 * ------------------------------------------------------------------ */

const env = loadEnv({ ...TEST_ENV, CAPTURE_MITM: "true" });
const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 9).toString("base64"));
type Leaves = Map<string, { context: Promise<unknown>; madeAt: number }>;
const leavesOf = (authority: CaptureAuthority) => (authority as unknown as { leaves: Leaves }).leaves;

describe("la CA de captura, cuando algo no coopera", () => {
  test("un nombre se firma una vez y se reutiliza; una IP y un nombre con caracteres raros también se firman", async () => {
    const authority = new CaptureAuthority(env, cipher, new InMemoryCaptureAuthorityRepository());
    const first = authority.contextFor("API.Ejemplo.test");
    assert.equal(authority.contextFor("api.ejemplo.test"), first);
    await first;
    await authority.contextFor("[::1]");
    await authority.contextFor("127.0.0.1");
    await authority.contextFor('raro,+="<>#;.test');
    assert.deepEqual([...leavesOf(authority).keys()].sort(), [
      "127.0.0.1",
      "::1",
      "api.ejemplo.test",
      'raro,+="<>#;.test',
    ]);
  });

  test("con 500 nombres recordados, el más antiguo sale para hacer sitio", async () => {
    const authority = new CaptureAuthority(env, cipher, new InMemoryCaptureAuthorityRepository());
    const leaves = leavesOf(authority);
    for (let index = 0; index < 500; index += 1)
      leaves.set(`n${index}.test`, { context: Promise.resolve(null), madeAt: Date.now() });
    await authority.contextFor("nuevo.test");
    assert.equal(leaves.size, 500);
    assert.equal(leaves.has("n0.test"), false);
    assert.equal(leaves.has("nuevo.test"), true);
  });

  test("una hoja que no se pudo firmar no se queda recordada", async () => {
    const off = new CaptureAuthority(loadEnv({ ...TEST_ENV }), cipher, new InMemoryCaptureAuthorityRepository());
    await assert.rejects(off.contextFor("a.test"), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.code, "capture-mitm-disabled");
      return true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(leavesOf(off).size, 0);
  });

  test("si la tabla no guarda la CA, se dice; y el siguiente intento vuelve a probar", async () => {
    let dropsWrites = true;
    const inner = new InMemoryCaptureAuthorityRepository();
    const repository: CaptureAuthorityRepositoryPort = {
      find: () => inner.find(),
      insertIfAbsent: async (row) => {
        if (dropsWrites) return;
        await inner.insertIfAbsent(row);
      },
    };
    const authority = new CaptureAuthority(env, cipher, repository);
    await assert.rejects(authority.ensure(), /no quedó guardada/);
    assert.deepEqual(await authority.status(), { ready: false, problem: "La CA de captura no quedó guardada" });
    dropsWrites = false;
    assert.deepEqual(await authority.status(), { ready: true, problem: null });
    assert.ok(inner.row);
  });

  test("una tabla que falla con algo que no es un Error da el motivo genérico", async () => {
    const authority = new CaptureAuthority(env, cipher, {
      find: () => Promise.reject("fallo raro"),
      insertIfAbsent: async () => undefined,
    });
    await assert.rejects(authority.ensure(), /No se pudo preparar la CA de captura/);
  });

  test("un cifrado que no devuelve lo cifrado, o que falla sin Error, no deja generar nada", async () => {
    const liar: SecretCipherPort = { encrypt: (plain) => plain, decrypt: () => "otra cosa" };
    const repository = new InMemoryCaptureAuthorityRepository();
    await assert.rejects(new CaptureAuthority(env, liar, repository).ensure(), /no devuelve lo cifrado/);
    const thrower: SecretCipherPort = {
      encrypt: () => {
        throw "roto";
      },
      decrypt: (payload) => payload,
    };
    await assert.rejects(
      new CaptureAuthority(env, thrower, repository).ensure(),
      /el cifrado no está disponible/,
    );
    assert.equal(repository.row, null);
  });

  test("una CA guardada que ya caducó no se usa, y se dice qué hacer", async () => {
    const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
    const keys = (await webcrypto.subtle.generateKey(algorithm, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
    const certificate = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: "01",
      name: "CN=caducada",
      notBefore: new Date(Date.now() - 10 * 86_400_000),
      notAfter: new Date(Date.now() - 86_400_000),
      keys,
      signingAlgorithm: algorithm,
    });
    const pkcs8 = x509.PemConverter.encode(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey), "PRIVATE KEY");
    const repository = new InMemoryCaptureAuthorityRepository();
    repository.row = {
      certificatePem: certificate.toString("pem"),
      privateKeyCiphertext: cipher.encrypt(pkcs8),
      createdAt: new Date(),
    };
    const before = repository.row.certificatePem;
    await assert.rejects(new CaptureAuthority(env, cipher, repository).ensure(), /caducó/);
    // No se sustituye en silencio.
    assert.equal(repository.row.certificatePem, before);
  });
});
