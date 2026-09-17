/**
 * Las dos piezas puras del import por URL: la credencial y el zip.
 *
 * Las dos son de las que se prueban aquí y no por HTTP, porque las dos deciden algo con los bytes
 * delante y sin base de datos ni red en medio.
 *
 * **La credencial.** Lo que se fija es lo que no debe pasar: un token con un salto de línea parte
 * la petición en dos, un nombre de cabecera inventado revienta dentro de `fetch` con un mensaje
 * que no dice nada, y `Host` lo pone el guardia de SSRF —aceptarlo aquí sería aceptar algo que
 * luego se tira sin avisar. Y se fija que **el valor del secreto no sale en el texto de ningún
 * error**, que es la regla por la que existe el módulo.
 *
 * **El zip.** Se detecta por sus cuatro bytes mágicos y no por el nombre ni por el
 * `Content-Type`, porque una URL que sirve un zip lo manda como `application/octet-stream` desde
 * `/download?id=7` tan a menudo como con su tipo bueno. Los zips se construyen a mano, byte a byte
 * (`support/make-zip.ts`): un fixture binario en el repositorio no dice por qué falla cuando falla.
 *
 * El lector es `readZip` de `@eq/import-detect`, **el mismo que abre el zip que se arrastra a la
 * pantalla**: lo que se prueba aquí es el camino de la URL, no el formato. El formato y sus topes
 * —entradas, tamaño por entrada y total descomprimido— se prueban donde vive el lector,
 * `packages/import-detect/test/zip.test.ts`, y tenerlos en un solo sitio es justamente el punto:
 * por una URL no puede entrar más que soltando los ficheros a mano.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { credentialHeaders } from "@/shared/import/url-credential";
import { looksZipped, readZip } from "@eq/import-detect";
import { makeZip as zip } from "../support/make-zip";

describe("la cabecera de una credencial de import", () => {
  test("sin credencial no hay cabecera, y quien llama no tiene que ramificar", () => {
    assert.deepEqual(credentialHeaders(undefined), {});
  });

  test("un bearer es un Authorization, con el token recortado", () => {
    assert.deepEqual(credentialHeaders({ kind: "bearer", token: "  abc123  " }), { Authorization: "Bearer abc123" });
  });

  test("una cabecera con nombre y valor viaja tal cual", () => {
    assert.deepEqual(credentialHeaders({ kind: "header", name: "X-API-Key", value: "k-9" }), { "X-API-Key": "k-9" });
  });

  test("un token vacío se dice, en vez de mandar «Bearer » y recibir un 401 sin explicación", () => {
    assert.throws(() => credentialHeaders({ kind: "bearer" }), /token está vacío/);
    assert.throws(() => credentialHeaders({ kind: "bearer", token: "   " }), /token está vacío/);
  });

  test("un salto de línea en el token es una inyección de cabeceras, no un espacio que recortar", () => {
    assert.throws(() => credentialHeaders({ kind: "bearer", token: "a\r\nX-Admin: 1" }), /salto de línea/);
    assert.throws(() => credentialHeaders({ kind: "header", name: "X-Key", value: "a\nX-Admin: 1" }), /salto de línea/);
  });

  test("un nombre de cabecera que no lo es se nombra aquí y no tres capas más abajo", () => {
    assert.throws(() => credentialHeaders({ kind: "header", value: "k" }), /falta el nombre/);
    assert.throws(() => credentialHeaders({ kind: "header", name: "X Key", value: "k" }), /no es un nombre/);
    assert.throws(() => credentialHeaders({ kind: "header", name: "X-Key" }), /falta el valor/);
  });

  test("Host no: lo pone el guardia con el nombre de la URL, y fijarlo aquí no haría nada", () => {
    assert.throws(() => credentialHeaders({ kind: "header", name: "Host", value: "interno" }), /guardia/);
  });

  test("el valor del secreto no aparece en el texto de ningún error", () => {
    // La regla entera del módulo, en una prueba: lo que se rechaza se nombra por su forma.
    const secret = "sk-no-debe-salir";
    for (const credential of [
      { kind: "bearer" as const, token: `${secret}\nX-Admin: 1` },
      { kind: "header" as const, name: "X Key", value: secret },
      { kind: "header" as const, name: "X-Key", value: `${secret}\r\nX-Admin: 1` },
    ]) {
      assert.throws(
        () => credentialHeaders(credential),
        (error: Error) => !error.message.includes(secret),
      );
    }
  });
});

describe("un zip reconocido por sus bytes", () => {
  test("los cuatro bytes mágicos, y el nombre no vota", () => {
    // Nombre vacío a propósito: `looksZipped` también dice sí por el sufijo `.zip`, y una URL que
    // acaba en `.zip` y contesta un JSON no es un zip. Por esta puerta deciden los bytes.
    assert.equal(looksZipped("", zip([{ name: "a.json", text: "{}" }])), true);
    assert.equal(looksZipped("", new TextEncoder().encode('{"info":{}}')), false);
    // Un zip vacío empieza por PK\x05\x06 y no trae nada que importar: no cuenta como uno.
    assert.equal(looksZipped("", new Uint8Array([0x50, 0x4b, 0x05, 0x06])), false);
    assert.equal(looksZipped("", new Uint8Array([0x50, 0x4b])), false);
  });

  test("los ficheros de dentro salen con su nombre y su contenido", async () => {
    const entries = await readZip(
      zip([
        { name: "collections/tienda.json", text: '{"info":{"name":"Tienda"}}' },
        { name: "contrato.yaml", text: "openapi: 3.0.0\n" },
      ]),
    );
    // Por su última parte: una entrada puede llamarse `../algo` y aquí sólo se enseña el nombre.
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["tienda.json", "contrato.yaml"],
    );
    assert.equal(entries[1].text, "openapi: 3.0.0\n");
  });

  test("comprimido y almacenado se leen igual, que es lo que escriben los zips de verdad", async () => {
    const text = `{"item":[${'{"name":"x"},'.repeat(200)}{"name":"y"}]}`;
    const [stored] = await readZip(zip([{ name: "a.json", text, deflate: false }]));
    const [deflated] = await readZip(zip([{ name: "b.json", text, deflate: true }]));
    assert.equal(stored.text, text);
    assert.equal(deflated.text, text);
  });

  test("un zip sin nada legible dentro sale vacío, y quien llama decide qué decir", async () => {
    assert.deepEqual(await readZip(zip([{ name: "captura.png", text: "x" }])), []);
  });

  test("una entrada cifrada se salta, y no tumba las demás", async () => {
    // Un zip con nueve colecciones y una entrada que no se puede inflar tiene que traer las nueve.
    const entries = await readZip(
      zip([
        { name: "cifrada.json", text: "{}", encrypted: true },
        { name: "tienda.json", text: '{"info":{"name":"Tienda"}}' },
      ]),
    );
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["tienda.json"],
    );
  });

  test("un zip cortado se dice, en vez de salir como un JSON raro", async () => {
    const bytes = zip([{ name: "a.json", text: "{}" }]);
    await assert.rejects(() => readZip(bytes.subarray(0, bytes.byteLength - 10)), /índice del final/);
    await assert.rejects(() => readZip(new Uint8Array(0)), /índice del final/);
  });
});
