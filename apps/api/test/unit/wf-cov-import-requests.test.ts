/**
 * Los lectores de peticiones importadas (curl, Postman, Insomnia, HAR) por sus bordes: lo que se
 * salta y por qué, las formas raras de cada fichero y los valores por defecto. Complementa
 * `import-requests.test.ts` e `import-har.test.ts`.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { Operation } from "@eq/runner-core";
import {
  expectedStatusFor,
  graphqlRequestBody,
  harNoise,
  matchOperation,
  parseCurl,
  parseCurlDocument,
  parseHar,
  parseInsomniaExport,
  parsePostmanCollection,
  pathOf,
  queryOf,
  readPostmanCollection,
  shellSplit,
} from "@/modules/workflows/domain/import-requests";
import { readPostmanAuth, storableParams } from "@/modules/workflows/domain/postman-auth";

describe("curl", () => {
  test("an empty quoted argument is still an argument", () => {
    assert.deepEqual(shellSplit("curl ''"), ["curl", ""]);
    assert.deepEqual(shellSplit('a "b\\"c\\\\" d\\\r\ne'), ["a", 'b"c\\', "de"]);
    // A trailing backslash with nothing after it is kept as a character.
    assert.deepEqual(shellSplit("a\\"), ["a\\"]);
  });

  test("dropped flags swallow their value, and cookies, --url and --data-urlencode are read", () => {
    const parsed = parseCurl(
      "curl -A 'Mozilla' -o out.txt -b 'sid=1' --data-urlencode 'q=a b' --url https://api.test/buscar",
    );
    assert.ok(parsed);
    assert.equal(parsed.url, "https://api.test/buscar");
    assert.equal(parsed.method, "POST");
    assert.equal(parsed.headers.Cookie, "sid=1");
    assert.deepEqual(parsed.body, { type: "x-www-form-urlencoded", fields: { q: "a b" }, disabledFields: {} });
    assert.equal(parsed.name, "POST /buscar");
  });

  test("a flag at the end without its value does not crash and the URL survives", () => {
    const parsed = parseCurl("curl https://api.test/x -X");
    assert.ok(parsed);
    assert.equal(parsed.url, "https://api.test/x");
    // `-X` with an empty value leaves the method to be inferred.
    assert.equal(parsed.method, "GET");
  });

  test("a -u without colon is a user with an empty password; -G folds data into an existing query", () => {
    const parsed = parseCurl("curl -G -u ana 'https://api.test/x?a=1' -d b=2");
    assert.ok(parsed);
    assert.equal(parsed.url, "https://api.test/x?a=1&b=2");
    assert.deepEqual(parsed.auth, { type: "basic", params: { username: "ana", password: "" } });
    assert.deepEqual(parsed.body, { type: "none" });
  });

  test("a raw payload declared as something else stays text with its type", () => {
    const parsed = parseCurl("curl -H 'Content-Type: text/csv' -H 'broken' -F 'noequals' -d 'a,b' https://api.test/x");
    assert.ok(parsed);
    assert.deepEqual(parsed.headers, { "Content-Type": "text/csv" });
    assert.deepEqual(parsed.body, { type: "raw", text: "a,b", contentType: "text/csv" });
  });

  test("a document of commands: one without URL is reported, not imported", () => {
    const out = parseCurlDocument("```bash\ncurl https://api.test/a\n```\ncurl -X POST\n");
    assert.equal(out.requests.length, 1);
    assert.deepEqual(out.skipped, [{ name: "curl", method: "", url: "", reason: "el comando no lleva ninguna URL" }]);
  });
});

describe("Postman collection", () => {
  test("text that is not JSON is reported as such", () => {
    assert.equal(readPostmanCollection("{no"), null);
    assert.deepEqual(parsePostmanCollection("{no"), {
      requests: [],
      skipped: [{ name: "", method: "", url: "", reason: "el fichero no es JSON" }],
    });
  });

  test("junk entries are ignored, and nameless / URL-less / unsupported-auth requests are handled", () => {
    const read = readPostmanCollection(
      JSON.stringify({
        item: [
          "junk",
          { name: "sin petición" },
          { request: { url: { host: ["{{base}}"], path: ["pedidos", 1] } } },
          { name: "sin url", request: { method: "post" } },
          { name: "rara", request: { url: "https://x/a", auth: { type: "kerberos" } } },
          { name: "", item: [{ name: "dentro", request: { url: { raw: "" , host: ["h"] } } }] },
        ],
      }),
    );
    assert.ok(read);
    assert.equal(read.name, "");
    assert.equal(read.items.length, 2);
    const [first, nested] = read.items;
    assert.equal(first.label, "Sin nombre");
    assert.equal(first.name, "Sin nombre");
    assert.equal(first.request.method, "GET");
    // A number in the path is not a string and is dropped by the reader.
    assert.equal(first.request.url, "{{base}}/pedidos/");
    assert.deepEqual(nested.trail, []);
    assert.equal(nested.request.url, "h");
    assert.deepEqual(read.skipped, [
      { name: "sin url", method: "post", url: "", reason: "la petición no lleva URL" },
      { name: "rara", method: "", url: "https://x/a", reason: "usa una autenticación «kerberos» que este lector no conoce" },
    ]);
  });

  test("a body in an unknown mode or an empty raw body is no body", () => {
    const read = readPostmanCollection(
      JSON.stringify({
        item: [
          { name: "file", request: { url: "/a", body: { mode: "file", file: {} } } },
          { name: "blank", request: { url: "/b", body: { mode: "raw", raw: "   " } } },
          { name: "gql", request: { url: "/c", body: { mode: "graphql", graphql: { query: " " } } } },
        ],
      }),
    );
    assert.ok(read);
    assert.deepEqual(
      read.items.map((item) => item.request.body),
      [{ type: "none" }, { type: "none" }, { type: "none" }],
    );
  });

  test("an example request with no content type defaults to JSON, and a raw body in xml takes its language", () => {
    const read = readPostmanCollection(
      JSON.stringify({
        item: [
          {
            name: "x",
            request: { url: "/x", body: { mode: "raw", raw: "<a/>", options: { raw: { language: "xml" } } } },
            response: [
              null,
              { code: 42 },
              { name: "ok", code: 200, originalRequest: { url: "/x", header: [] } },
            ],
          },
        ],
      }),
    );
    assert.ok(read);
    const request = read.items[0].request;
    assert.deepEqual(request.body, { type: "raw", text: "<a/>", contentType: "application/xml" });
    assert.equal(request.examples.length, 1);
    assert.deepEqual(request.examples[0].request, {
      method: "GET",
      url: "/x",
      headers: {},
      body: "",
      contentType: "application/json",
    });
    assert.equal(request.examples[0].contentType, "text/plain");
  });
});

describe("Insomnia export", () => {
  test("text that is not JSON is reported as such", () => {
    assert.deepEqual(parseInsomniaExport("nope"), {
      requests: [],
      skipped: [{ name: "", method: "", url: "", reason: "el fichero no es JSON" }],
    });
  });

  test("a nameless request, a request without URL and a URL that already has a query", () => {
    const out = parseInsomniaExport(
      JSON.stringify({
        resources: [
          { _type: "request", url: "https://api/x?a=1", parameters: [{ name: "b", value: "2" }] },
          { _type: "request", name: "vacía", method: "delete" },
        ],
      }),
    );
    assert.equal(out.requests.length, 1);
    assert.equal(out.requests[0].name, "Sin nombre");
    assert.equal(out.requests[0].method, "GET");
    assert.equal(out.requests[0].url, "https://api/x?a=1&b=2");
    assert.deepEqual(out.skipped, [{ name: "vacía", method: "DELETE", url: "", reason: "la petición no lleva URL" }]);
  });

  test("every authentication type maps to ours, and secrets are redacted", () => {
    const auths = [
      { disabled: true, type: "basic", username: "u" },
      { type: "basic", username: "u", password: "p" },
      { type: "bearer", token: "{{tok}}", prefix: "Token" },
      { type: "digest", username: "u", password: "p" },
      { type: "apikey", key: "X-Key", value: "v" },
      { type: "apikey", key: "k", value: "{{v}}", addTo: "queryParams" },
      { type: "oauth2", accessToken: "", accessTokenUrl: "https://t", clientId: "c", clientSecret: "", scope: "s", grantType: "password" },
      { type: "oauth2", grantType: "client_credentials" },
      { type: "hawk", id: "i", key: "k" },
      { type: "hawk", id: "i", key: "", algorithm: "sha1" },
      { type: "awsiam", accessKeyId: "A", secretAccessKey: "S", sessionToken: "T" },
      { type: "ntlm", username: "u", password: "" },
      { type: "weird" },
    ];
    const out = parseInsomniaExport(
      JSON.stringify({
        resources: auths.map((authentication, index) => ({ _type: "request", name: `r${index}`, url: "/x", authentication })),
      }),
    );
    assert.deepEqual(
      out.requests.map((request) => request.auth),
      [
        { type: "inherit", params: {} },
        { type: "basic", params: { username: "u", password: "" } },
        { type: "bearer", params: { token: "{{tok}}", headerPrefix: "Token" } },
        { type: "digest", params: { username: "u", password: "" } },
        { type: "apikey", params: { key: "X-Key", value: "", in: "header" } },
        { type: "apikey", params: { key: "k", value: "{{v}}", in: "queryParams" } },
        {
          type: "oauth2",
          params: {
            accessToken: "",
            accessTokenUrl: "https://t",
            clientId: "c",
            clientSecret: "",
            scope: "s",
            grantType: "password_credentials",
          },
        },
        {
          type: "oauth2",
          params: { accessToken: "", accessTokenUrl: "", clientId: "", clientSecret: "", scope: "", grantType: "client_credentials" },
        },
        { type: "hawk", params: { authId: "i", authKey: "", algorithm: "sha256" } },
        { type: "hawk", params: { authId: "i", authKey: "", algorithm: "sha1" } },
        { type: "awsv4", params: { accessKey: "A", secretKey: "", sessionToken: "T" } },
        { type: "ntlm", params: { username: "u", password: "" } },
        { type: "inherit", params: {} },
      ],
    );
  });

  test("urlencoded, raw with the header's type, raw with the mime, graphql with object/odd variables", () => {
    const out = parseInsomniaExport(
      JSON.stringify({
        resources: [
          {
            _type: "request",
            name: "form",
            url: "/f",
            body: { mimeType: "application/x-www-form-urlencoded", params: [{ name: "a", value: "1" }, { name: "b", value: "2", disabled: true }] },
          },
          {
            _type: "request",
            name: "raw",
            url: "/r",
            headers: [{ name: "Content-Type", value: "text/plain" }],
            body: { mimeType: "application/json", text: '{"a":1}' },
          },
          { _type: "request", name: "mime", url: "/m", body: { mimeType: "application/json", text: '{"a":1}' } },
          { _type: "request", name: "empty", url: "/e", body: { mimeType: "text/plain", text: "  " } },
          {
            _type: "request",
            name: "gql",
            url: "/g",
            body: { mimeType: "application/graphql", text: JSON.stringify({ query: "{ a }", variables: { x: 1 } }) },
          },
          {
            _type: "request",
            name: "gql2",
            url: "/g",
            body: { mimeType: "application/graphql", text: JSON.stringify({ query: "{ b }", variables: 5 }) },
          },
        ],
      }),
    );
    const byName = Object.fromEntries(out.requests.map((request) => [request.name, request]));
    assert.deepEqual(byName.form.body, { type: "x-www-form-urlencoded", fields: { a: "1" }, disabledFields: { b: "2" } });
    assert.deepEqual(byName.raw.body, { type: "raw", text: '{"a":1}', contentType: "text/plain" });
    assert.deepEqual(byName.mime.body, { type: "json", json: { a: 1 } });
    assert.deepEqual(byName.empty.body, { type: "none" });
    assert.deepEqual(byName.gql.graphql, { query: "{ a }", variables: '{\n  "x": 1\n}' });
    assert.deepEqual(byName.gql.body, { type: "json", json: { query: "{ a }", variables: { x: 1 } } });
    assert.deepEqual(byName.gql2.graphql, { query: "{ b }", variables: "" });
  });
});

describe("graphqlRequestBody", () => {
  test("variables that are not a JSON object are written as text inside the body", () => {
    const body = graphqlRequestBody({ query: "{ a }", variables: "{{vars}}" });
    assert.deepEqual(body, { type: "raw", text: '{"query":"{ a }","variables":{{vars}}}', contentType: "application/json" });
    assert.deepEqual(graphqlRequestBody({ query: "{ a }", variables: "  " }), { type: "json", json: { query: "{ a }" } });
  });
});

describe("paths, queries and matching", () => {
  test("pathOf tells hosts from path segments", () => {
    assert.equal(pathOf("https://api.test"), "/");
    assert.equal(pathOf("{{base}}"), "/");
    assert.equal(pathOf("api.test.com:8080/x"), "/x");
    assert.equal(pathOf("localhost"), "/");
    assert.equal(pathOf("pedidos/1"), "/pedidos/1");
    assert.equal(pathOf("/x?y#z"), "/x");
  });

  test("queryOf stops at the fragment", () => {
    assert.deepEqual(queryOf("/x?a=1&b=2#frag"), { a: "1", b: "2" });
    assert.deepEqual(queryOf("/x"), {});
  });

  test("matchOperation prefers literals and decodes placeholders; expectedStatusFor falls back to 200", () => {
    const op = (path: string, statuses: number[] = [200]): Operation =>
      ({ method: "GET", path, statuses }) as unknown as Operation;
    const request = { name: "", method: "GET", url: "https://h/api/w/a%20b", headers: {}, body: { type: "none" as const }, auth: { type: "inherit" as const, params: {} }, examples: [] };
    const match = matchOperation(request, [op("/w/{id}"), op("/w/a%20b"), op("/x/y/z/w/q")]);
    assert.ok(match);
    assert.equal(match.operation.path, "/w/a%20b");
    const placeholder = matchOperation(request, [op("/w/{id}")]);
    assert.deepEqual(placeholder?.parameters, { id: "a b" });
    assert.equal(matchOperation({ ...request, method: "POST" }, [op("/w/{id}")]), null);
    assert.equal(expectedStatusFor(op("/", [404, 500])), 200);
    assert.equal(expectedStatusFor(op("/", [204, 201, 400])), 201);
  });
});

describe("HAR", () => {
  test("a document without log.entries is refused", () => {
    assert.deepEqual(parseHar("{}").skipped, [{ name: "", method: "", url: "", reason: "no es un HAR con `log.entries`" }]);
    assert.equal(parseHar("x").requests.length, 0);
  });

  test("junk, missing URLs, non-http schemes and grouped drop reasons", () => {
    const out = parseHar(
      JSON.stringify({
        log: {
          entries: [
            null,
            { response: {} },
            { request: { url: "" } },
            { request: { method: "OPTIONS", url: "https://api/x" } },
            { request: { method: "GET", url: "ftp://files/x" } },
            { request: { method: "GET", url: "https://api/a.css" }, response: { content: { mimeType: "text/css" } } },
            { request: { method: "GET", url: "https://api/b.css" }, response: { content: { mimeType: "text/css; charset=utf-8" } } },
          ],
        },
      }),
    );
    assert.equal(out.requests.length, 0);
    assert.deepEqual(
      out.skipped.map((row) => row.reason),
      [
        "la entrada no lleva URL",
        "1 petición: son el `OPTIONS` de preflight que manda el navegador",
        "1 petición: no van por http (ftp:)",
        "2 peticiones: son recursos de la página y no de la API (text/css)",
      ],
    );
    assert.equal(out.skipped[0].method, "GET");
  });

  test("harNoise lets an unparseable URL through and drops telemetry", () => {
    assert.equal(harNoise("GET", "{{base}}/x", ""), null);
    assert.equal(harNoise("POST", "https://o1.sentry.io/api", "application/json"), "son de un servicio de telemetría (o1.sentry.io)");
  });

  test("a request without response, bodies from headers and auth schemes read from the header", () => {
    const out = parseHar(
      JSON.stringify({
        log: {
          entries: [
            {
              request: {
                url: "https://api/a",
                headers: [{ name: "Authorization", value: "Digest x" }, { name: "Content-Type", value: "application/json" }],
                postData: { text: '{"a":1}' },
              },
            },
            {
              request: { method: "post", url: "https://api/b", headers: [{ name: "authorization", value: "Basic abc" }], postData: { text: "  " } },
              response: { status: 201, content: { text: "aGk=", encoding: "base64" } },
            },
            {
              request: { url: "https://api/c", headers: [{ name: "Authorization", value: "Negotiate z" }], postData: { mimeType: "text/plain", text: "hola" } },
              response: { status: 200, statusText: "OK", content: { mimeType: "application/json; charset=utf-8", text: "{}" } },
            },
          ],
        },
      }),
    );
    const [a, b, c] = out.requests;
    assert.deepEqual(a.examples, []);
    assert.deepEqual(a.body, { type: "json", json: { a: 1 } });
    assert.deepEqual(a.auth, { type: "digest", params: { username: "", password: "" } });
    assert.equal(b.method, "POST");
    assert.deepEqual(b.body, { type: "none" });
    assert.deepEqual(b.auth, { type: "basic", params: { username: "", password: "" } });
    assert.deepEqual(b.examples[0], {
      name: "201",
      status: 201,
      headers: {},
      body: "hi",
      contentType: "text/plain",
      request: { method: "POST", url: "https://api/b", headers: { authorization: "Basic abc" }, body: "  ", contentType: "application/json" },
    });
    assert.deepEqual(c.auth, { type: "inherit", params: {} });
    assert.deepEqual(c.body, { type: "raw", text: "hola", contentType: "text/plain" });
    assert.equal(c.examples[0].name, "200 OK");
    assert.equal(c.examples[0].contentType, "application/json");
    assert.equal(c.examples[0].request?.contentType, "text/plain");
  });
});

describe("postman-auth edges", () => {
  test("a list of params skips entries that are not objects", () => {
    assert.deepEqual(readPostmanAuth({ type: "bearer", bearer: [null, 3, { key: "token", value: "t" }, { value: "x" }] }), {
      type: "bearer",
      params: { token: "t" },
    });
  });

  test("storableParams tolerates an auth without params", () => {
    assert.deepEqual(storableParams({ type: "none" } as never), {});
  });
});
