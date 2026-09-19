/**
 * The case executor against a scripted network.
 *
 * What is asserted is what leaves the process and what is written about it: the URL a signed query
 * lands on, the header a session or a role travels in, the request that is refused before it goes
 * out and the words the step records for it.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, resolveOperation, type StepFetch, type StepGraphql, type TestScenario } from "@eq/runner-core";

import { CaseExecutor, fetchUrl, type ExecutionTarget } from "@/modules/runs/infrastructure/case-executor";
import type { SafeFetchPort, SafeFetchResult, SafeRequestOptions } from "@/shared/http/safe-fetch";
import type { SecretCipherPort } from "@/shared/crypto/secret-cipher";
import type { Credential } from "@/modules/environments/domain/model";

type Handler = (url: string, options: SafeRequestOptions) => Partial<SafeFetchResult> | Error;

function network(handler: Handler = () => ({})) {
  const sent: { url: string; options: SafeRequestOptions }[] = [];
  const http: SafeFetchPort = {
    get: async () => {
      throw new Error("no se usa");
    },
    request: async (url, options) => {
      sent.push({ url, options });
      const answer = handler(url, options);
      if (answer instanceof Error) throw answer;
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        setCookie: [],
        body: "{}",
        finalUrl: url,
        durationMs: 7,
        ...answer,
      } as SafeFetchResult;
    },
  };
  return { http, sent };
}

/** The cipher the executor decrypts a credential with: the ciphertext is the secret, reversed. */
const cipher: SecretCipherPort = {
  encrypt: (plain: string) => [...plain].reverse().join(""),
  decrypt: (payload: string) => [...payload].reverse().join(""),
} as unknown as SecretCipherPort;

function target(extra: Partial<ExecutionTarget> = {}): ExecutionTarget {
  return {
    baseUrl: "https://api.ejemplo.test",
    writesAllowed: true,
    spec: null,
    specError: "no hay contrato",
    credentials: [],
    variables: {},
    session: null,
    cookies: [],
    ...extra,
  };
}

const call = (extra: Partial<StepFetch> = {}): StepFetch => ({ method: "GET", url: "/things", ...extra });

describe("un nodo fetch", () => {
  test("un cuerpo que parece JSON sin serlo va como texto plano y se guarda tal cual", async () => {
    const { http, sent } = network();
    const executed = await new CaseExecutor(http, cipher).fetch({
      call: call({ method: "POST", body: "{esto no es json" }),
      target: target(),
    });
    assert.equal(sent[0].options.headers?.["Content-Type"], "text/plain");
    assert.equal(executed.steps[0].sent.body, "{esto no es json");
    assert.equal(executed.ok, true);
  });

  test("con useSession presenta la sesión de la corrida, tapada en lo que se guarda", async () => {
    const { http, sent } = network();
    const executed = await new CaseExecutor(http, cipher).fetch({
      call: call({ useSession: true }),
      target: target({ session: { header: "Authorization", value: "Bearer abc" } }),
    });
    assert.equal(sent[0].options.headers?.Authorization, "Bearer abc");
    assert.equal(executed.steps[0].sent.headers.Authorization, "••••••••");
  });

  test("una clave en la query se añade con «?» o con «&» según la URL", async () => {
    const auth = { type: "apikey", params: { key: "k", value: "v 1", in: "query" } } as StepFetch["auth"];
    const { http, sent } = network();
    const executor = new CaseExecutor(http, cipher);
    await executor.fetch({ call: call({ auth }), target: target() });
    await executor.fetch({ call: call({ url: "/things?page=2", auth }), target: target() });
    assert.equal(sent[0].url, "https://api.ejemplo.test/things?k=v%201");
    assert.equal(sent[1].url, "https://api.ejemplo.test/things?page=2&k=v%201");
  });

  test("OAuth 2 sin token no sale; con token va como Bearer", async () => {
    const { http, sent } = network();
    const executor = new CaseExecutor(http, cipher);
    const refused = await executor.fetch({
      call: call({ auth: { type: "oauth2", params: { accessToken: "  " } } as StepFetch["auth"] }),
      target: target(),
    });
    assert.equal(sent.length, 0);
    assert.equal(refused.ok, false);
    assert.equal(refused.steps[0].failure, "config");
    assert.equal(refused.steps[0].assertions[0].label, "Autenticación");
    assert.match(refused.steps[0].assertions[0].detail, /OAuth 2.0 sin token/);

    await executor.fetch({
      call: call({ auth: { type: "oauth2", params: { accessToken: "tok-1" } } as StepFetch["auth"] }),
      target: target(),
    });
    assert.match(sent[0].options.headers?.Authorization ?? "", /tok-1/);
  });

  test("un modo que no se puede firmar se dice y no sale; «none» no añade nada", async () => {
    const { http, sent } = network();
    const executor = new CaseExecutor(http, cipher);
    const refused = await executor.fetch({
      call: call({ auth: { type: "bearer", params: { token: "" } } as StepFetch["auth"] }),
      target: target(),
    });
    assert.equal(sent.length, 0);
    assert.equal(refused.steps[0].assertions[0].detail, "Falta el token");

    const plain = await executor.fetch({ call: call({ auth: { type: "none", params: {} } }), target: target() });
    assert.equal(plain.ok, true);
    assert.equal(sent[0].options.headers?.Authorization, undefined);
  });

  test("Digest pide el reto primero, y dice por qué no pudo firmar cuando no llega", async () => {
    const auth = { type: "digest", params: { username: "ana", password: "secreta" } } as StepFetch["auth"];

    const failing = network(() => new Error("conexión rechazada"));
    const noProbe = await new CaseExecutor(failing.http, cipher).fetch({ call: call({ auth }), target: target() });
    assert.equal(noProbe.steps[0].assertions[0].detail, "No se pudo pedir el reto de Digest al servidor");

    const silent = network(() => ({ status: 200 }));
    const noChallenge = await new CaseExecutor(silent.http, cipher).fetch({ call: call({ auth }), target: target() });
    assert.equal(noChallenge.steps[0].assertions[0].detail, "El servidor no pidió autenticación: no hay reto que firmar");
    assert.equal(silent.sent.length, 1);

    const challenging = network((_url, options) =>
      options.headers?.Authorization
        ? { status: 200 }
        : { status: 401, headers: { "www-authenticate": 'Digest realm="api", nonce="n0nce", qop="auth"' } },
    );
    const signed = await new CaseExecutor(challenging.http, cipher).fetch({ call: call({ auth }), target: target() });
    assert.equal(signed.ok, true);
    assert.equal(challenging.sent.length, 2);
    assert.match(challenging.sent[1].options.headers?.Authorization ?? "", /^Digest .*nonce="n0nce"/);
  });

  test("una petición que no llega a nadie falla como «network» con el motivo", async () => {
    const { http } = network(() => new Error("ECONNREFUSED"));
    const executed = await new CaseExecutor(http, cipher).fetch({ call: call(), target: target() });
    assert.equal(executed.ok, false);
    assert.equal(executed.steps[0].failure, "network");
    assert.equal(executed.steps[0].assertions[0].label, "Conexión");
    assert.equal(executed.steps[0].assertions[0].detail, "ECONNREFUSED");
  });

  test("una escritura a otro host sale aunque el entorno no permita escrituras, también con una base ilegible", async () => {
    const { http, sent } = network();
    const executed = await new CaseExecutor(http, cipher).fetch({
      call: call({ method: "POST", url: "https://hooks.otro.test/x", body: "{}" }),
      target: target({ baseUrl: "no es una url", writesAllowed: false }),
    });
    assert.equal(executed.ok, true);
    assert.equal(sent[0].url, "https://hooks.otro.test/x");
  });

  test("una cookie que el objetivo no puede poner no entra en el tarro", async () => {
    const { http } = network(() => ({ setCookie: ["sesion=1; Domain=otro-dominio.test"] }));
    const jar = target();
    await new CaseExecutor(http, cipher).fetch({ call: call(), target: jar });
    assert.deepEqual(jar.cookies, []);
  });

  test("una ruta sin barra cuelga de la base igual que con barra", () => {
    assert.equal(fetchUrl("things", "https://api.ejemplo.test/"), "https://api.ejemplo.test/things");
    assert.equal(fetchUrl("/things", "https://api.ejemplo.test//"), "https://api.ejemplo.test/things");
  });
});

describe("un nodo GraphQL", () => {
  test("rechazado por una variable sin valor, guarda la consulta con variables y nombre vacíos", async () => {
    const { http, sent } = network();
    const executed = await new CaseExecutor(http, cipher).graphql({
      call: { url: "/graphql", query: "{ cosa(id: \"{{id}}\") { id } }" } as StepGraphql,
      target: target(),
    });
    assert.equal(sent.length, 0);
    assert.equal(executed.ok, false);
    assert.equal(executed.steps[0].assertions[0].detail, "Faltan variables: id");
    assert.deepEqual(executed.steps[0].sent.body, {
      query: "{ cosa(id: \"{{id}}\") { id } }",
      variables: null,
      operationName: null,
    });
  });

  test("lleva el estado esperado, la sesión y la autenticación del nodo hasta la petición", async () => {
    const { http, sent } = network(() => ({ status: 201, body: JSON.stringify({ data: { ok: true } }) }));
    const executed = await new CaseExecutor(http, cipher).graphql({
      call: {
        url: "/graphql",
        query: "mutation { crear { id } }",
        expectedStatus: 201,
        useSession: true,
        auth: { type: "apikey", params: { key: "X-Clave", value: "c1" } },
      } as StepGraphql,
      target: target({ session: { header: "Authorization", value: "Bearer sesion" } }),
    });
    assert.equal(executed.ok, true, JSON.stringify(executed.steps[0].assertions));
    assert.equal(sent[0].options.headers?.Authorization, "Bearer sesion");
    assert.equal(sent[0].options.headers?.["X-Clave"], "c1");
  });
});

describe("un caso planificado del contrato", () => {
  const operation = resolveOperation(
    { id: "listThings", method: "GET", path: "/things", summary: "", tag: "", statuses: [200], parameters: [] },
    DEFAULT_CONFIG,
  );
  const scenario = (auth: string): TestScenario =>
    ({ id: "s", name: "Listar", description: "", expectedStatus: 200, flow: "request", auth }) as TestScenario;
  const credential = (role: string, secret: string, headerName: string): Credential =>
    ({
      id: role,
      environmentId: "env",
      name: role,
      role,
      kind: "api-key",
      headerName,
      secretCiphertext: [...secret].reverse().join(""),
      scopes: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as unknown as Credential;

  test("«insufficient» y «api-key» presentan su credencial, y la mala a propósito no lleva el tarro", async () => {
    const { http, sent } = network();
    const executor = new CaseExecutor(http, cipher);
    const credentials = [credential("insufficient", "poca", "X-Poca"), credential("alternate", "otra", "X-Otra")];
    const jar = target({ credentials, cookies: [{ name: "s", value: "1" } as never] });
    await executor.run({ operation, scenario: scenario("insufficient"), operations: [operation], config: DEFAULT_CONFIG, target: jar, samples: 1 });
    await executor.run({ operation, scenario: scenario("api-key"), operations: [operation], config: DEFAULT_CONFIG, target: jar, samples: 1 });
    assert.equal(sent[0].options.headers?.["X-Poca"], "poca");
    assert.equal(sent[0].options.jar, undefined);
    assert.equal(sent[1].options.headers?.["X-Otra"], "otra");
    assert.ok(sent[1].options.jar);
  });

  test("sin credencial declarada presenta la principal y el tarro; un JSON roto se queda como texto", async () => {
    const { http, sent } = network(() => ({ body: "{roto" }));
    const credentials = [credential("primary", "buena", "X-Buena")];
    const executed = await new CaseExecutor(http, cipher).run({
      operation,
      scenario: { id: "s", name: "Listar", description: "", expectedStatus: 200, flow: "request" } as TestScenario,
      operations: [operation],
      config: DEFAULT_CONFIG,
      target: target({ credentials }),
      samples: 1,
    });
    assert.equal(sent[0].options.headers?.["X-Buena"], "buena");
    assert.ok(sent[0].options.jar);
    assert.equal(executed.steps[0].actual?.body, "{roto");
  });

  test("las muestras extra se cortan en la primera que falla, y el esquema del contrato se aplica", async () => {
    let calls = 0;
    const { http } = network(() => {
      calls += 1;
      if (calls === 2) return new Error("se cayó");
      return { status: 200, body: JSON.stringify({ data: [] }) };
    });
    const spec = {
      paths: {
        "/things": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { type: "object", required: ["total"], properties: { total: { type: "integer" } } },
                  },
                },
              },
            },
          },
        },
      },
    };
    const executed = await new CaseExecutor(http, cipher).run({
      operation,
      scenario: scenario("primary"),
      operations: [operation],
      config: DEFAULT_CONFIG,
      target: target({ spec, specError: null }),
      samples: 3,
    });
    assert.equal(calls, 2);
    const [step] = executed.steps;
    assert.deepEqual(step.latency.samples, [7]);
    assert.equal(step.latency.timing, undefined);
    assert.equal(step.durationMs, 7);
    // The contract's schema demands `total`, and the body does not have it.
    assert.equal(step.ok, false);
    assert.match(JSON.stringify(step.assertions), /total/);
  });
});
