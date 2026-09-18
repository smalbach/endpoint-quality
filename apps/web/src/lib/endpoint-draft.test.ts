import { describe, expect, test } from "vitest";

import {
  EMPTY_BODY,
  NEW_ENDPOINT,
  NO_FILES,
  fileProblem,
  isDirty,
  missingFiles,
  prettyBody,
  resolvedParts,
  savePayload,
  sendForm,
  snapshotRequest,
  variablesOf,
  withPath,
  type EndpointDraft,
} from "./endpoint-draft";
import { renderSnippet } from "./snippets";
import type { Environment } from "./types";

const draft = (patch: Partial<EndpointDraft> = {}): EndpointDraft => ({ ...NEW_ENDPOINT, ...patch });

describe("borrador del endpoint", () => {
  test("cambiar la ruta sigue sus parámetros y conserva lo escrito", () => {
    const first = withPath(draft(), "/users/{id}");
    const typed = { ...first, pathParameters: [{ ...first.pathParameters[0], value: "{{userId}}" }] };
    const next = withPath(typed, "/users/{id}/posts/:postUuid");
    expect(next.pathParameters.map((parameter) => [parameter.name, parameter.type, parameter.value])).toEqual([
      ["id", "string", "{{userId}}"],
      ["postUuid", "uuid", ""],
    ]);
    expect(withPath(next, "/{{version}}/health").pathParameters).toEqual([]);
  });

  test("lo que se guarda no lleva filas en blanco ni el valor de un campo fichero, y las etiquetas van en lista", () => {
    const payload = savePayload(
      draft({
        headers: [
          { name: "X-A", value: "1", enabled: true },
          { name: " ", value: "", enabled: true },
        ],
        body: {
          ...EMPTY_BODY,
          mode: "form-data",
          fields: [{ name: "doc", value: "C:\\fakepath\\x.pdf", kind: "file", enabled: true }],
        },
        tags: "a, b, a",
      }),
    );
    expect(payload.headers).toEqual([{ name: "X-A", value: "1", enabled: true }]);
    expect(payload.body.fields[0].value).toBe("");
    expect(payload.tags).toEqual(["a", "b"]);
  });

  test("sucio compara lo que se guardaría, no el texto de las filas a medio escribir", () => {
    const saved = draft({ path: "/x" });
    expect(isDirty({ ...saved, headers: [{ name: "", value: "", enabled: true }] }, saved)).toBe(false);
    expect(isDirty({ ...saved, description: "cambio" }, saved)).toBe(true);
    expect(isDirty(saved, null)).toBe(true);
  });
});

describe("ficheros", () => {
  const file = (name: string, size = 3) => new File(["x".repeat(size)], name);

  test("extensiones bloqueadas y tamaño", () => {
    expect(fileProblem(file("setup.EXE"))).toMatch(/\.exe/);
    expect(fileProblem(file("a.txt"))).toBeNull();
  });

  test("dice qué fichero falta y lo manda en su parte", async () => {
    const withFile = draft({
      method: "POST",
      path: "/upload",
      body: {
        ...EMPTY_BODY,
        mode: "form-data",
        fields: [
          { name: "caption", value: "hola", kind: "text", enabled: true },
          { name: "doc", value: "", kind: "file", enabled: true },
          { name: "off", value: "", kind: "file", enabled: false },
        ],
      },
    });
    expect(missingFiles(withFile.body, NO_FILES)).toEqual(["doc"]);
    const chosen = { fields: { doc: file("a.txt") }, binary: null };
    expect(missingFiles(withFile.body, chosen)).toEqual([]);

    const form = sendForm({ ...withFile, auth: { type: "none", params: {} } }, "env-1", chosen);
    const request = JSON.parse(form.get("request") as string);
    expect(request.environmentId).toBe("env-1");
    expect(request.auth).toEqual({ type: "none", params: {} });
    expect((form.get("file:doc") as File).name).toBe("a.txt");
    expect(form.get("file:off")).toBeNull();
    expect(missingFiles({ ...EMPTY_BODY, mode: "binary" }, NO_FILES)).toEqual(["cuerpo binario"]);
  });
});

describe("variables y cURL", () => {
  const environment = {
    variables: {
      host: { initial: "https://api.example.com", current: "", sensitive: false },
      userId: { initial: "1", current: "42", sensitive: false },
      token: { initial: "", current: "••••••••", sensitive: true },
    },
  } as unknown as Environment;
  const variables = variablesOf(environment);

  test("la ruta resuelta marca lo conocido, lo secreto y lo que no existe", () => {
    expect(resolvedParts("/users/{{userId}}/{{token}}/{{nadie}}", variables)).toEqual([
      { text: "/users/", kind: "literal" },
      { text: "42", kind: "known" },
      { text: "/", kind: "literal" },
      { text: "••••", kind: "secret" },
      { text: "/", kind: "literal" },
      { text: "{{nadie}}", kind: "unknown" },
    ]);
  });

  test("el cURL sustituye lo que no es secreto y deja el token como variable", () => {
    const curl = renderSnippet(
      "curl",
      snapshotRequest(
        draft({
          method: "POST",
          path: "/users/{id}",
          pathParameters: [{ name: "id", type: "string", description: "", value: "{{userId}}" }],
          query: [
            { name: "dry", type: "string", required: false, description: "", value: "1", enabled: true },
            { name: "off", type: "string", required: false, description: "", value: "x", enabled: false },
          ],
          body: { ...EMPTY_BODY, mode: "json", text: '{"a":"it\'s"}' },
          // El auth se guarda con el endpoint, así que el cURL lo saca del borrador.
          auth: { type: "bearer", params: { token: "{{token}}" } },
        }),
        { baseUrl: "{{host}}/", variables, files: NO_FILES },
      ),
    );
    expect(curl).toBe(
      [
        "curl -X POST 'https://api.example.com/users/42?dry=1'",
        "  -H 'Authorization: Bearer {{token}}'",
        "  -H 'Content-Type: application/json'",
        `  --data '{"a":"it'\\''s"}'`,
      ].join(" \\\n"),
    );
  });

  test("GraphQL: por POST el cURL manda {query, variables}; por GET, en la query como «Enviar»", () => {
    const operation = {
      ...EMPTY_BODY,
      mode: "graphql" as const,
      text: "query ($id: ID!) { user(id: $id) { name } }",
      variables: '{"id": "{{userId}}"}',
    };
    const posted = snapshotRequest(draft({ method: "POST", path: "/graphql", body: operation }), {
      baseUrl: "{{host}}",
      variables,
      files: NO_FILES,
    });
    expect(posted.body).toEqual({
      kind: "text",
      text: JSON.stringify({ query: operation.text, variables: { id: "42" } }, null, 2),
      contentType: "application/json",
      json: true,
    });

    const got = snapshotRequest(draft({ method: "GET", path: "/graphql", body: operation }), {
      baseUrl: "{{host}}",
      variables,
      files: NO_FILES,
    });
    expect(got.body).toEqual({ kind: "none" });
    const search = new URL(got.url).searchParams;
    expect(search.get("query")).toBe(operation.text);
    expect(search.get("variables")).toBe('{"id":"42"}');
  });

  test("unas variables vacías no se guardan: borrarlas no deja el endpoint como cambiado", () => {
    const saved = draft({ body: { ...EMPTY_BODY, mode: "graphql", text: "{ a }" } });
    const typed = draft({ body: { ...EMPTY_BODY, mode: "graphql", text: "{ a }", variables: "  " } });
    expect(savePayload(typed).body).not.toHaveProperty("variables");
    expect(isDirty(typed, saved)).toBe(false);
    expect(savePayload(draft({ body: { ...saved.body, variables: '{"a": 1}' } })).body.variables).toBe('{"a": 1}');
  });

  test("un cuerpo JSON se indenta, el resto se deja como vino", () => {
    expect(prettyBody('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', json: true });
    expect(prettyBody("<x/>")).toEqual({ text: "<x/>", json: false });
  });
});
