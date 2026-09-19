/**
 * Las piezas del motor de flujos que la API usa directamente: el espacio `env.`, el elemento de un
 * bucle, la lista que recorre, la credencial que publica un login y las cuatro rutas de lectura.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  bindElement,
  listAt,
  loopBody,
  readAuthorization,
  readFrom,
  rerunPath,
  withEnvironmentNamespace,
  type WorkflowStep,
} from "../src/workflows.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("variables del entorno", () => {
  test("cada variable queda con su nombre y además bajo «env.»", () => {
    assert.deepEqual(withEnvironmentNamespace({ userId: "7", base: "https://x" }), {
      userId: "7",
      base: "https://x",
      "env.userId": "7",
      "env.base": "https://x",
    });
    assert.deepEqual(withEnvironmentNamespace({}), {});
  });
});

describe("el elemento de un bucle", () => {
  test("un valor suelto se ata como texto, y la ausencia como vacío", () => {
    assert.deepEqual(bindElement("item", null), { item: "" });
    assert.deepEqual(bindElement("item", undefined), { item: "" });
    assert.deepEqual(bindElement("item", 42), { item: "42" });
    assert.deepEqual(bindElement("item", "sku-1"), { item: "sku-1" });
  });

  test("una lista se ata entera como JSON y no se aplana", () => {
    assert.deepEqual(bindElement("item", [1, 2]), { item: "[1,2]" });
  });

  test("un objeto se ata entero y cada campo simple en su propio nombre; lo anidado no se aplana", () => {
    assert.deepEqual(bindElement("item", { id: 3, name: "tuerca", stock: null, tags: ["a"], meta: { x: 1 } }), {
      item: '{"id":3,"name":"tuerca","stock":null,"tags":["a"],"meta":{"x":1}}',
      "item.id": "3",
      "item.name": "tuerca",
      "item.stock": "",
    });
  });
});

describe("la lista que recorre un bucle", () => {
  test("es la lista del camino, o null cuando ahí no hay una lista", () => {
    assert.deepEqual(listAt({ data: { items: [1, 2] } }, "data.items"), [1, 2]);
    assert.equal(listAt({ data: { items: { id: 1 } } }, "data.items"), null);
    assert.equal(listAt({}, "data.items"), null);
  });
});

describe("leer un valor de una respuesta", () => {
  test("una cabecera se busca en minúsculas y, si no, tal cual se escribió", () => {
    assert.equal(readFrom("header", "X-Trace", { body: null, headers: { "x-trace": "abc" } }), "abc");
    assert.equal(readFrom("header", "X-Trace", { body: null, headers: { "X-Trace": "def" } }), "def");
    assert.equal(readFrom("header", "X-Trace", { body: null, headers: {} }), undefined);
  });

  test("una cookie sale de su Set-Cookie, y sin él no hay nada", () => {
    assert.equal(readFrom("cookie", "sid", { body: null, headers: { "set-cookie": "sid=s3cr3t; Path=/" } }), "s3cr3t");
    assert.equal(readFrom("cookie", "sid", { body: null, headers: {} }), undefined);
  });

  test("una regex lee el texto crudo si lo hay, el cuerpo en texto o el JSON del cuerpo", () => {
    assert.equal(readFrom("regex", "id=(\\d+)", { body: { id: 1 }, headers: {}, raw: "id=77" }), "77");
    assert.equal(readFrom("regex", "id=(\\d+)", { body: "id=88", headers: {} }), "88");
    assert.equal(readFrom("regex", '"id":(\\d+)', { body: { id: 99 }, headers: {} }), "99");
    // Sin grupo, el valor es la coincidencia entera.
    assert.equal(readFrom("regex", "\\d+", { body: "abc 123", headers: {} }), "123");
    // Sin cuerpo no hay texto y no hay coincidencia, en vez de buscar en «undefined».
    assert.equal(readFrom("regex", "undefined", { body: undefined, headers: {} }), undefined);
    assert.equal(readFrom("regex", "x", { body: "abc", headers: {} }), undefined);
    // Un patrón roto no tumba la corrida: se informa como «no encontrado».
    assert.equal(readFrom("regex", "(", { body: "abc", headers: {} }), undefined);
  });
});

describe("la credencial que publica un login", () => {
  const response = { body: { token: "t0k", empty: "", nested: { a: 1 } }, headers: { "x-api-key": "k3y" } };

  test("por defecto va en Authorization con «Bearer »", () => {
    assert.deepEqual(readAuthorization({ from: "body", path: "token" }, response), {
      header: "Authorization",
      value: "Bearer t0k",
    });
  });

  test("la cabecera y el esquema se pueden cambiar, y un esquema vacío manda el token solo", () => {
    assert.deepEqual(readAuthorization({ from: "header", path: "x-api-key", header: " X-Api-Key ", scheme: "" }, response), {
      header: "X-Api-Key",
      value: "k3y",
    });
    // Una cabecera en blanco vuelve a la de siempre.
    assert.deepEqual(readAuthorization({ from: "body", path: "token", header: "  ", scheme: "Token " }, response), {
      header: "Authorization",
      value: "Token t0k",
    });
  });

  test("nada, vacío, null o un objeto no son una credencial", () => {
    assert.equal(readAuthorization({ from: "body", path: "missing" }, response), null);
    assert.equal(readAuthorization({ from: "body", path: "empty" }, response), null);
    assert.equal(readAuthorization({ from: "body", path: "nested" }, response), null);
    assert.equal(readAuthorization({ from: "body", path: "token" }, { body: { token: null }, headers: {} }), null);
  });
});

describe("tramos del grafo", () => {
  test("el tramo de un reintento visita una sola vez un paso al que se llega por dos caminos", () => {
    const steps: WorkflowStep[] = [
      { id: "crear", requestTemplateId: uuid(1) },
      { id: "izq", requestTemplateId: uuid(1), dependsOn: ["crear"] },
      { id: "der", requestTemplateId: uuid(1), dependsOn: ["crear"] },
      { id: "unir", requestTemplateId: uuid(1), dependsOn: ["izq", "der", "fantasma"] },
    ];
    assert.deepEqual(rerunPath(steps, "crear", "unir"), ["crear", "izq", "der", "unir"]);
  });

  test("un paso marcado en el bucle pero sin colgar de él no es cuerpo", () => {
    const steps: WorkflowStep[] = [
      { id: "listar", requestTemplateId: uuid(1) },
      { id: "b", kind: "loop", dependsOn: ["listar"], loop: { from: "listar", path: "data", as: "item" } },
      { id: "suelto", requestTemplateId: uuid(1), inLoop: "b" },
      { id: "leer", requestTemplateId: uuid(1), dependsOn: ["b"], inLoop: "b" },
    ];
    assert.deepEqual(loopBody(steps, "b"), ["leer"]);
  });
});
