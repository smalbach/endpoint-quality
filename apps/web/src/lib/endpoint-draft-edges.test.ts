import { describe, expect, test } from "vitest";

import {
  EMPTY_BODY,
  INHERIT_AUTH,
  MAX_FILE_BYTES,
  NEW_ENDPOINT,
  NO_FILES,
  draftFrom,
  fileProblem,
  graphqlJson,
  missingFiles,
  resolvedParts,
  sendForm,
  snapshotRequest,
  storableParams,
  variablesOf,
  type EndpointDraft,
  type ResolvedVariable,
} from "./endpoint-draft";
import type { EndpointView } from "./types";

const draft = (patch: Partial<EndpointDraft> = {}): EndpointDraft => ({ ...NEW_ENDPOINT, ...patch });
const file = (name: string) => new File(["abc"], name);

describe("draftFrom", () => {
  const view = {
    id: "e1",
    method: "POST",
    path: "/users",
    description: "crea",
    pathParameters: [],
    query: [{ name: "q", value: "1", enabled: true }],
    headers: [],
    body: EMPTY_BODY,
    requiresAuth: true,
    auth: { type: "bearer", params: { token: "t" } },
    tags: ["a", "b"],
    status: "active",
    preRequestScript: "pre",
    postResponseScript: "post",
  } as unknown as EndpointView;

  test("las etiquetas vuelven a texto separado por comas y el auth se conserva", () => {
    const result = draftFrom(view);
    expect(result).toEqual({
      method: "POST",
      path: "/users",
      description: "crea",
      pathParameters: [],
      query: [{ name: "q", value: "1", enabled: true }],
      headers: [],
      body: EMPTY_BODY,
      requiresAuth: true,
      auth: { type: "bearer", params: { token: "t" } },
      tags: "a, b",
      status: "active",
      preRequestScript: "pre",
      postResponseScript: "post",
    });
  });

  test("sin auth guardado hereda", () => {
    expect(draftFrom({ ...view, auth: undefined } as unknown as EndpointView).auth).toBe(INHERIT_AUTH);
  });
});

describe("storableParams", () => {
  test("un secreto vacío se guarda; un texto vacío no", () => {
    expect(storableParams({ type: "basic", params: { username: "", password: "" } })).toEqual({ password: "" });
    expect(storableParams({ type: "basic", params: { username: "ana", password: "x" } })).toEqual({
      username: "ana",
      password: "x",
    });
  });

  test("`value` solo es secreto en una API key", () => {
    expect(storableParams({ type: "apikey", params: { key: "", value: "" } })).toEqual({ value: "" });
    expect(storableParams({ type: "custom", params: { value: "" } } as never)).toEqual({});
  });
});

describe("graphqlJson", () => {
  test("sin variables solo lleva la query", () => {
    expect(JSON.parse(graphqlJson("{ me }", "  "))).toEqual({ query: "{ me }" });
  });

  test("variables objeto se anidan como JSON", () => {
    expect(JSON.parse(graphqlJson("q", '{"a":1}'))).toEqual({ query: "q", variables: { a: 1 } });
  });

  test("variables que no son objeto o no son JSON van tal cual", () => {
    expect(graphqlJson("q", "{{vars}}")).toBe('{\n  "query": "q",\n  "variables": {{vars}}\n}');
    expect(graphqlJson("q", "[1]")).toBe('{\n  "query": "q",\n  "variables": [1]\n}');
    expect(graphqlJson("q", "null")).toBe('{\n  "query": "q",\n  "variables": null\n}');
  });
});

describe("ficheros", () => {
  test("uno demasiado grande", () => {
    const big = { name: "a.bin", size: MAX_FILE_BYTES + 1 } as File;
    expect(fileProblem(big)).toBe("Como mucho 10 MB por fichero");
  });

  test("el cuerpo binario pide su fichero; otros modos no piden nada", () => {
    const binary = { ...EMPTY_BODY, mode: "binary" as const };
    expect(missingFiles(binary, NO_FILES)).toEqual(["cuerpo binario"]);
    expect(missingFiles(binary, { fields: {}, binary: file("a.bin") })).toEqual([]);
    expect(missingFiles({ ...EMPTY_BODY, mode: "json" }, NO_FILES)).toEqual([]);
  });

  test("sendForm manda el binario elegido en su parte", () => {
    const binary = file("blob.bin");
    const form = sendForm(draft({ method: "POST", body: { ...EMPTY_BODY, mode: "binary" } }), null, {
      fields: {},
      binary,
    });
    expect((form.get("binary") as File).name).toBe("blob.bin");
    const without = sendForm(draft({ body: { ...EMPTY_BODY, mode: "binary" } }), null, NO_FILES);
    expect(without.get("binary")).toBeNull();
  });
});

describe("variables y ruta resuelta", () => {
  test("sin entorno no hay variables", () => {
    expect(variablesOf(null)).toEqual({});
    expect(variablesOf(undefined)).toEqual({});
  });

  test("una ruta que acaba en variable no deja literal colgando", () => {
    const vars: Record<string, ResolvedVariable> = { id: { value: "7", sensitive: false } };
    expect(resolvedParts("/u/{{id}}", vars)).toEqual([
      { text: "/u/", kind: "literal" },
      { text: "7", kind: "known" },
    ]);
  });

  test("lo que queda tras la última variable sale como literal", () => {
    expect(resolvedParts("/u/{{id}}/posts", {})).toEqual([
      { text: "/u/", kind: "literal" },
      { text: "{{id}}", kind: "unknown" },
      { text: "/posts", kind: "literal" },
    ]);
  });
});

describe("snapshotRequest", () => {
  const vars: Record<string, ResolvedVariable> = {
    host: { value: "https://api.test", sensitive: false },
    name: { value: "ana", sensitive: false },
    secret: { value: "s3cr3t", sensitive: true },
  };
  const ctx = (patch: Partial<Parameters<typeof snapshotRequest>[1]> = {}) => ({
    baseUrl: "{{host}}/",
    variables: vars,
    files: NO_FILES,
    ...patch,
  });

  test("sin base usa {{baseUrl}}, y `env.` se resuelve contra el nombre sin prefijo", () => {
    const request = snapshotRequest(draft({ path: "/u/{{env.name}}" }), ctx({ baseUrl: "" }));
    expect(request.url).toBe("{{baseUrl}}/u/ana");
    expect(request.body).toEqual({ kind: "none" });
  });

  test("una ruta absoluta no lleva la base delante", () => {
    expect(snapshotRequest(draft({ path: "http://other.test/x" }), ctx()).url).toBe("http://other.test/x");
  });

  test("GraphQL por GET: variables no JSON viajan como están; sin variables no hay parámetro", () => {
    const body = { ...EMPTY_BODY, mode: "graphql" as const, text: "{ me }", variables: "{{secret}}" };
    const url = new URL(snapshotRequest(draft({ path: "/gql", body }), ctx()).url);
    expect(url.searchParams.get("query")).toBe("{ me }");
    expect(url.searchParams.get("variables")).toBe("{{secret}}");

    const plain = { ...EMPTY_BODY, mode: "graphql" as const, text: "{ me }" };
    const noVars = new URL(snapshotRequest(draft({ method: "HEAD", path: "/gql", body: plain }), ctx()).url);
    expect(noVars.searchParams.has("variables")).toBe(false);
  });

  test("GraphQL por POST sin variables lleva solo la query", () => {
    const body = { ...EMPTY_BODY, mode: "graphql" as const, text: "{ me }" };
    const request = snapshotRequest(draft({ method: "POST", path: "/gql", body }), ctx());
    expect(request.body).toEqual({
      kind: "text",
      text: JSON.stringify({ query: "{ me }" }, null, 2),
      contentType: "application/json",
      json: true,
    });
  });

  test("urlencoded solo lleva los campos de texto activos, sustituidos", () => {
    const body = {
      ...EMPTY_BODY,
      mode: "x-www-form-urlencoded" as const,
      fields: [
        { name: "who", value: "{{name}}", kind: "text" as const, enabled: true },
        { name: "off", value: "x", kind: "text" as const, enabled: false },
        { name: "doc", value: "", kind: "file" as const, enabled: true },
      ],
    };
    expect(snapshotRequest(draft({ method: "POST", body }), ctx()).body).toEqual({
      kind: "form",
      fields: [{ name: "who", value: "ana" }],
    });
  });

  test("form-data pone el nombre del fichero elegido, o «fichero» si no hay", () => {
    const body = {
      ...EMPTY_BODY,
      mode: "form-data" as const,
      fields: [
        { name: "who", value: "{{name}}", kind: "text" as const, enabled: true },
        { name: "doc", value: "", kind: "file" as const, enabled: true },
        { name: "img", value: "", kind: "file" as const, enabled: true },
      ],
    };
    const files = { fields: { doc: file("cv.pdf") }, binary: null };
    expect(snapshotRequest(draft({ method: "POST", body }), ctx({ files })).body).toEqual({
      kind: "multipart",
      fields: [
        { name: "who", value: "ana", file: false },
        { name: "doc", value: "cv.pdf", file: true },
        { name: "img", value: "fichero", file: true },
      ],
    });
  });

  test("binario lleva el nombre del fichero elegido, o «fichero» si no hay", () => {
    const body = { ...EMPTY_BODY, mode: "binary" as const };
    expect(snapshotRequest(draft({ method: "POST", body }), ctx()).body).toEqual({
      kind: "binary",
      filename: "fichero",
    });
    expect(
      snapshotRequest(draft({ method: "POST", body }), ctx({ files: { fields: {}, binary: file("b.bin") } })).body,
    ).toEqual({ kind: "binary", filename: "b.bin" });
  });
});
