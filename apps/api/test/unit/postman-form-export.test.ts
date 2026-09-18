/**
 * Un formulario sale a Postman como formulario, y vuelve igual.
 *
 * Antes, un endpoint con cuerpo `form-data` o `urlencoded` salía **sin cuerpo**: el exportador solo
 * miraba el `text`, y un formulario no tiene texto, tiene filas. Y un nodo de flujo con formulario
 * salía como el texto `a=1&b=2`, que en Postman es una cadena y que al volver a entrar ya no era un
 * formulario. Lo que decide algo:
 *
 * - **`formdata` y `urlencoded`, cada uno con su nombre**, y las filas apagadas como `disabled`.
 * - **Un fichero sale como fila `file` sin `src`**, y se dice en `skipped`: los bytes no están aquí.
 * - **Una credencial escrita a mano no sale**, la misma regla que las cabeceras.
 * - **Lo que sale vuelve a entrar igual**, por el lector de Postman de verdad.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseEndpointFile, pendingFileNotes } from "@/modules/endpoints/domain/import-endpoints";
import type { EndpointFormField } from "@/modules/endpoints/domain/model";
import { toPostmanExport } from "@/modules/projects/domain/postman-export";
import type { ProjectBundle } from "@/modules/projects/domain/project-bundle";
import { readPostmanCollection } from "@/modules/workflows/domain/import-requests";

const IDS = { collectionId: "col-1", environmentIds: [] };

const endpoint = (mode: string, fields: EndpointFormField[]) => ({
  method: "POST",
  path: "/subidas",
  description: "",
  pathParameters: [],
  query: [],
  headers: [],
  body: { mode, text: "", contentType: "text/plain", fields },
  requiresAuth: false,
  tags: [],
  status: "active",
  operationId: null,
  preRequestScript: "",
  postResponseScript: "",
});

const exportEndpoints = (mode: string, fields: EndpointFormField[]) =>
  toPostmanExport(
    {
      format: "endpoint-quality/project",
      version: 1,
      project: { name: "Tienda" },
      settings: { baseUrl: "https://api.tienda.test" },
      endpoints: [endpoint(mode, fields)],
    } as unknown as ProjectBundle,
    IDS,
    { contents: "endpoints" },
  );

const bodyOf = (exported: ReturnType<typeof toPostmanExport>) =>
  (exported.collection.item[0] as { request: { body?: Record<string, unknown> } }).request.body;

const text = (name: string, value: string, enabled = true): EndpointFormField => ({
  name,
  value,
  kind: "text",
  enabled,
});

describe("un endpoint con formulario sale con su formulario", () => {
  test("`form-data` sale como `formdata`, con las filas apagadas como `disabled`", () => {
    const exported = exportEndpoints("form-data", [
      text("titulo", "Factura {{mes}}"),
      text("borrador", "si", false),
      { name: "adjunto", value: "", kind: "file", enabled: true },
    ]);
    assert.deepEqual(bodyOf(exported), {
      mode: "formdata",
      formdata: [
        { key: "titulo", value: "Factura {{mes}}", type: "text" },
        { key: "borrador", value: "si", type: "text", disabled: true },
        { key: "adjunto", type: "file" },
      ],
    });
    // El fichero no viaja, y quien exporta lo lee: no es un cuerpo completo que parece completo.
    assert.ok(exported.skipped.some((entry) => /«adjunto» es un fichero/.test(entry.detail)));
  });

  test("`x-www-form-urlencoded` sale como `urlencoded`, sin ficheros, que ese modo no manda", () => {
    const exported = exportEndpoints("x-www-form-urlencoded", [
      text("grant_type", "client_credentials"),
      text("scope", "leer", false),
      { name: "adjunto", value: "", kind: "file", enabled: true },
    ]);
    assert.deepEqual(bodyOf(exported), {
      mode: "urlencoded",
      urlencoded: [
        { key: "grant_type", value: "client_credentials" },
        { key: "scope", value: "leer", disabled: true },
      ],
    });
    assert.deepEqual(exported.skipped, []);
  });

  test("un formulario sin filas no escribe un cuerpo vacío", () => {
    assert.equal(bodyOf(exportEndpoints("form-data", [])), undefined);
  });
});

describe("ningún secreto sale en un formulario", () => {
  test("una credencial escrita a mano sale vacía y desactivada; una variable sale tal cual", () => {
    const exported = exportEndpoints("x-www-form-urlencoded", [
      text("username", "ana"),
      text("password", "hunter2"),
      text("client_secret", "{{client_secret}}"),
    ]);
    assert.deepEqual(bodyOf(exported), {
      mode: "urlencoded",
      urlencoded: [
        { key: "username", value: "ana" },
        { key: "password", value: "", disabled: true },
        { key: "client_secret", value: "{{client_secret}}" },
      ],
    });
    assert.doesNotMatch(JSON.stringify(exported.collection), /hunter2/);
    assert.ok(exported.skipped.some((entry) => /«password» lleva un valor escrito a mano/.test(entry.detail)));
  });
});

describe("lo que sale vuelve a entrar", () => {
  test("un endpoint `form-data` vuelve como `form-data`, con las mismas filas", () => {
    const exported = exportEndpoints("form-data", [
      text("titulo", "Factura {{mes}}"),
      text("borrador", "si", false),
      { name: "adjunto", value: "", kind: "file", enabled: true },
    ]);
    const [draft] = parseEndpointFile("postman", JSON.stringify(exported.collection)).drafts;
    assert.equal(draft.body?.mode, "form-data");
    // El fichero vuelve **como fichero**, en su sitio y sin bytes —antes volvía como un campo de
    // texto vacío, que manda otra cosa—, y el import dice que hay que elegirlo.
    assert.deepEqual(
      draft.body?.fields?.map((field) => [field.name, field.value, field.kind, field.enabled]),
      [
        ["titulo", "Factura {{mes}}", "text", true],
        ["borrador", "si", "text", false],
        ["adjunto", "", "file", true],
      ],
    );
    assert.deepEqual(pendingFileNotes(draft), [
      "POST /subidas: el campo «adjunto» es un fichero — hay que elegir el fichero",
    ]);
  });

  test("una petición guardada no manda un fichero como texto vacío", () => {
    const exported = exportEndpoints("form-data", [
      text("titulo", "x"),
      { name: "adjunto", value: "", kind: "file", enabled: true },
    ]);
    const read = readPostmanCollection(JSON.stringify(exported.collection));
    // El motor no tiene los bytes: la fila de fichero no entra en lo que se manda, y el endpoint la
    // conserva por `formRows`.
    assert.deepEqual(read?.items[0].request.body, { type: "form-data", fields: { titulo: "x" }, disabledFields: {} });
    assert.deepEqual(
      read?.items[0].request.formRows?.map((row) => [row.name, row.kind]),
      [
        ["titulo", "text"],
        ["adjunto", "file"],
      ],
    );
  });

  test("un formulario de Insomnia con un fichero vuelve también como fichero", () => {
    const insomnia = {
      _type: "export",
      resources: [
        {
          _id: "req_1",
          _type: "request",
          name: "Subir",
          method: "POST",
          url: "https://api.tienda.test/subidas",
          body: {
            mimeType: "multipart/form-data",
            params: [
              { name: "foto", type: "file", fileName: "/Users/ana/foto.png" },
              { name: "nota", value: "hola" },
            ],
          },
        },
      ],
    };
    const [draft] = parseEndpointFile("insomnia", JSON.stringify(insomnia)).drafts;
    assert.deepEqual(
      draft.body?.fields?.map((field) => [field.name, field.value, field.kind]),
      [
        ["foto", "", "file"],
        ["nota", "hola", "text"],
      ],
    );
    // La ruta del disco de quien lo eligió no entra.
    assert.doesNotMatch(JSON.stringify(draft), /Users\/ana/);
  });

  test("un endpoint `urlencoded` vuelve como `urlencoded`", () => {
    const exported = exportEndpoints("x-www-form-urlencoded", [text("a", "1"), text("b", "{{b}}", false)]);
    const read = readPostmanCollection(JSON.stringify(exported.collection));
    assert.deepEqual(read?.items[0].request.body, {
      type: "x-www-form-urlencoded",
      fields: { a: "1" },
      disabledFields: { b: "{{b}}" },
    });
  });

  test("un nodo de flujo con formulario sale como formulario y vuelve como el mismo cuerpo", () => {
    // Salía como el texto `nombre=silla`, que al volver era un cuerpo `raw`: el formulario se
    // perdía en la ida y vuelta de un flujo.
    const body = { type: "form-data", fields: { nombre: "silla", foto: "" }, disabledFields: { viejo: "x" } };
    const exported = toPostmanExport(
      {
        format: "endpoint-quality/project",
        version: 1,
        project: { name: "Tienda" },
        settings: { baseUrl: "https://api.tienda.test" },
        flows: {
          requestTemplates: [
            {
              id: "t1",
              name: "Crear",
              operationId: "create",
              method: "post",
              path: "/muebles",
              description: null,
              expectedStatus: 201,
              parameters: {},
              disabledParameters: {},
              headers: {},
              disabledHeaders: {},
              body,
            },
          ],
          workflows: [
            {
              id: "w1",
              name: "Alta",
              description: "",
              status: "ready",
              definition: { steps: [{ id: "s1", requestTemplateId: "t1" }] },
            },
          ],
          datasets: [],
          suites: [],
        },
      } as unknown as ProjectBundle,
      IDS,
    );
    const folder = exported.collection.item[0] as { item: { request: { body?: Record<string, unknown> } }[] };
    assert.equal(folder.item[0].request.body?.mode, "formdata");
    const read = readPostmanCollection(JSON.stringify(exported.collection));
    assert.deepEqual(read?.items[0].request.body, body);
  });
});
