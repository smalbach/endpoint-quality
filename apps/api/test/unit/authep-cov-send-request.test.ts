/**
 * «Enviar» del editor de endpoints, con el manejador a pelo: la red y el sandbox son falsos y
 * guionizados, y los repositorios son los de memoria de siempre.
 *
 * Lo que las pruebas HTTP no alcanzan sin montar un servidor para cada caso: el login del proyecto
 * que falla de cada manera, el token de OAuth 2 pedido y rechazado, el reto de Digest que no llega,
 * el destino bloqueado, las cookies que el servidor borra, y un script sin entorno que intenta
 * guardar.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  SendEndpointRequestCommand,
  SendEndpointRequestHandler,
  type SentRequestView,
} from "@/modules/endpoints/application/commands/send-endpoint-request";
import { AesGcmSecretCipher } from "@/shared/crypto/secret-cipher";
import { FixedClock } from "@/shared/clock/clock.port";
import { BlockedTargetError, type SafeFetchPort, type SafeFetchResult, type SafeRequestOptions } from "@/shared/http/safe-fetch";
import type { ScriptInput, ScriptOutcome, ScriptSandboxPort } from "@/shared/scripts/script-sandbox";
import { DomainError } from "@/shared/errors/domain-error";
import type { Project } from "@/modules/projects/domain/model";
import type { Environment } from "@/modules/environments/domain/model";
import type { StoredProjectAuth } from "@/modules/projects/domain/project-auth";

import {
  InMemoryCookieJarRepository,
  InMemoryEnvironmentRepository,
  InMemoryProjectRepository,
  InMemorySessionTokenRepository,
} from "../support/in-memory-repositories";

const NOW = new Date("2026-03-01T10:00:00.000Z");
const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 7).toString("base64"));

type Reply = Partial<SafeFetchResult> | Error;
type Call = { url: string; options: SafeRequestOptions };

/** La red, guionizada: cada llamada se contesta con lo que diga `answer`, o revienta con su error. */
class ScriptedHttp implements SafeFetchPort {
  readonly calls: Call[] = [];
  constructor(private readonly answer: (url: string, options: SafeRequestOptions) => Reply) {}
  async get(url: string, options: { headers?: Record<string, string> } = {}): Promise<SafeFetchResult> {
    return this.request(url, { method: "GET", ...options });
  }
  async request(url: string, options: SafeRequestOptions): Promise<SafeFetchResult> {
    this.calls.push({ url, options });
    const reply = this.answer(url, options);
    if (reply instanceof Error) throw reply;
    return {
      status: 200,
      headers: {},
      setCookie: [],
      body: "",
      finalUrl: url,
      durationMs: 3,
      timing: { dnsMs: 0, ttfbMs: 2, downloadMs: 1 },
      ...reply,
    };
  }
}

const outcome = (fields: Partial<ScriptOutcome> = {}): ScriptOutcome => ({
  error: null,
  logs: [],
  tests: [],
  environmentSet: {},
  environmentUnset: [],
  variables: {},
  headers: null,
  visualization: null,
  durationMs: 1,
  ...fields,
});

class ScriptedSandbox implements ScriptSandboxPort {
  readonly inputs: ScriptInput[] = [];
  constructor(private readonly answer: (input: ScriptInput) => ScriptOutcome = () => outcome()) {}
  async run(input: ScriptInput): Promise<ScriptOutcome> {
    this.inputs.push(structuredClone(input));
    return this.answer(input);
  }
}

function makeProject(fields: Partial<Project> & { secrets?: Record<string, string> } = {}): Project {
  const { secrets, ...rest } = fields;
  const auth: StoredProjectAuth = rest.auth ?? { type: "none", settings: {}, secretCiphertext: null };
  return {
    id: "p1",
    organizationId: "o1",
    name: "Tienda",
    slug: "tienda",
    description: "",
    createdBy: "u1",
    createdAt: NOW,
    archivedAt: null,
    activeSpecVersionId: null,
    activeEnvironmentId: null,
    baseUrl: "http://api.test",
    tags: [],
    deletedAt: null,
    ...rest,
    auth: secrets ? { ...auth, secretCiphertext: cipher.encrypt(JSON.stringify(secrets)) } : auth,
  };
}

function makeEnvironment(fields: Partial<Environment> = {}): Environment {
  return {
    id: "env1",
    projectId: "p1",
    name: "local",
    baseUrl: "http://env.test",
    specUrl: null,
    variables: {},
    disabledVariables: {},
    writesAllowed: true,
    authEnforced: true,
    createdAt: NOW,
    archivedAt: null,
    deletedAt: null,
    ...fields,
  };
}

function setup(options: {
  project?: Project;
  environments?: Environment[];
  http?: (url: string, options: SafeRequestOptions) => Reply;
  sandbox?: (input: ScriptInput) => ScriptOutcome;
} = {}) {
  const projects = new InMemoryProjectRepository();
  const environments = new InMemoryEnvironmentRepository();
  const sessionTokens = new InMemorySessionTokenRepository();
  const cookieJar = new InMemoryCookieJarRepository();
  const clock = new FixedClock(NOW);
  const http = new ScriptedHttp(options.http ?? (() => ({ body: "{}" })));
  const sandbox = new ScriptedSandbox(options.sandbox);
  const project = options.project ?? makeProject();
  void projects.save(project);
  for (const environment of options.environments ?? []) void environments.save(environment);
  const handler = new SendEndpointRequestHandler(
    projects,
    environments,
    sessionTokens,
    cookieJar,
    cipher,
    http,
    sandbox,
    clock,
  );
  const send = (request: Record<string, unknown> | string, files: never[] = []): Promise<SentRequestView> =>
    handler.execute(
      new SendEndpointRequestCommand(
        "o1",
        project.id,
        typeof request === "string" ? request : JSON.stringify({ method: "GET", path: "/x", ...request }),
        files,
        "actor-1",
      ),
    );
  return { projects, environments, sessionTokens, cookieJar, clock, http, sandbox, send, project };
}

async function rejectsWith(promise: Promise<unknown>, kind: string, code?: string): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DomainError, `se esperaba un DomainError y llegó ${String(error)}`);
    assert.equal(error.kind, kind);
    if (code !== undefined) assert.equal(error.code, code);
    return error;
  }
  assert.fail("se esperaba un error");
}

describe("antes de salir", () => {
  test("una petición que no es JSON es un 422 que nombra `request`", async () => {
    const { send } = setup();
    const error = await rejectsWith(send("no-json"), "invalid");
    assert.deepEqual(error.fields.map((field) => field.field), ["request"]);
  });

  test("un entorno que no existe, o que es de otro proyecto, es un 404", async () => {
    const { send } = setup({ environments: [makeEnvironment({ id: "ajeno", projectId: "otro" })] });
    await rejectsWith(send({ environmentId: "no-existe" }), "not-found", "environment-not-found");
    await rejectsWith(send({ environmentId: "ajeno" }), "not-found", "environment-not-found");
  });

  test("sin URL base en ningún sitio y con una ruta relativa, no se adivina", async () => {
    const { send, http } = setup({ project: makeProject({ baseUrl: "" }) });
    await rejectsWith(send({}), "invalid", "base-url-missing");
    assert.equal(http.calls.length, 0);
  });

  test("un {{$hmacSha256}} se calcula con la clave y el texto", async () => {
    const { send, http } = setup();
    const sent = await send({ path: "/firma", headers: [{ name: "X-Firma", value: "{{$hmacSha256:clave:texto}}" }] });
    assert.equal(sent.error, null);
    const expected = (await import("node:crypto")).createHmac("sha256", "clave").update("texto").digest("hex");
    assert.equal(http.calls[0].options.headers?.["X-Firma"], expected);
  });
});

describe("de dónde sale la credencial", () => {
  test("una cabecera Authorization escrita gana y no se toca", async () => {
    const { send, http } = setup({ project: makeProject({ auth: { type: "bearer", settings: {}, secretCiphertext: null }, secrets: { token: "del-proyecto" } }) });
    const sent = await send({ headers: [{ name: "authorization", value: "Bearer mio" }] });
    assert.equal(sent.auth, "Cabecera Authorization escrita en la petición");
    assert.equal(http.calls[0].options.headers?.authorization, "Bearer mio");
    assert.equal(sent.request.headers.authorization, "••••••••");
  });

  test("un token de sesión caducado se dice, y se usa el del proyecto", async () => {
    const context = setup({
      project: makeProject({ auth: { type: "bearer", settings: {}, secretCiphertext: null }, secrets: { token: "tok-proyecto" } }),
    });
    await context.sessionTokens.save({
      actorId: "actor-1",
      projectId: "p1",
      tokenCiphertext: cipher.encrypt("viejo"),
      claims: null,
      expiresAt: new Date(NOW.getTime() - 1000),
      capturedAt: NOW,
      source: "login",
    });
    const sent = await context.send({});
    assert.equal(sent.auth, "Token del proyecto · el token de sesión caducó");
    assert.equal(context.http.calls[0].options.headers?.Authorization, "Bearer tok-proyecto");
  });

  test("un token de sesión vigente capturado por un script se nombra así", async () => {
    const context = setup();
    await context.sessionTokens.save({
      actorId: "actor-1",
      projectId: "p1",
      tokenCiphertext: cipher.encrypt("de-script"),
      claims: null,
      expiresAt: null,
      capturedAt: NOW,
      source: "script",
    });
    const sent = await context.send({});
    assert.equal(sent.auth, "Token de sesión (de un script)");
    assert.equal(context.http.calls[0].options.headers?.Authorization, "Bearer de-script");
  });

  test("bearer sin token ni login: sin autenticación, dicho", async () => {
    const { send, http } = setup({ project: makeProject({ auth: { type: "bearer", settings: {}, secretCiphertext: null } }) });
    const sent = await send({});
    assert.equal(sent.auth, "Sin autenticación: el proyecto no tiene token");
    assert.equal(http.calls[0].options.headers?.Authorization, undefined);
  });

  test("basic del proyecto: usuario y contraseña, sin nada si faltan", async () => {
    const withSecrets = setup({
      project: makeProject({ auth: { type: "basic", settings: { username: "ana" }, secretCiphertext: null }, secrets: { password: "pw" } }),
    });
    const sent = await withSecrets.send({});
    assert.equal(sent.auth, "Basic auth del proyecto");
    assert.equal(withSecrets.http.calls[0].options.headers?.Authorization, `Basic ${Buffer.from("ana:pw").toString("base64")}`);

    const bare = setup({ project: makeProject({ auth: { type: "basic", settings: {}, secretCiphertext: null } }) });
    await bare.send({});
    assert.equal(bare.http.calls[0].options.headers?.Authorization, `Basic ${Buffer.from(":").toString("base64")}`);
  });

  test("api key del proyecto con la cabecera por defecto y la clave vacía si no la hay", async () => {
    const { send, http } = setup({ project: makeProject({ auth: { type: "api_key", settings: {}, secretCiphertext: null } }) });
    const sent = await send({});
    assert.equal(sent.auth, "API key del proyecto");
    assert.equal(http.calls[0].options.headers?.["X-API-Key"], "");
  });

  test("sin autenticación de proyecto: la credencial primaria del entorno, si la hay", async () => {
    const environment = makeEnvironment();
    const context = setup({ environments: [environment] });
    const none = await context.send({ environmentId: "env1" });
    assert.equal(none.auth, "Sin autenticación");

    await context.environments.saveCredential({
      id: "c1",
      environmentId: "env1",
      name: "admin",
      role: "alternate",
      kind: "bearer",
      headerName: null,
      secretCiphertext: cipher.encrypt("alt"),
      scopes: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    const onlyAlternate = await context.send({ environmentId: "env1" });
    assert.equal(onlyAlternate.auth, "Sin autenticación");

    await context.environments.saveCredential({
      id: "c2",
      environmentId: "env1",
      name: "principal",
      role: "primary",
      kind: "api_key",
      headerName: "X-Key",
      secretCiphertext: cipher.encrypt("clave-entorno"),
      scopes: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    const primary = await context.send({ environmentId: "env1" });
    assert.equal(primary.auth, "Credencial «principal» del entorno");
    assert.equal(context.http.calls.at(-1)?.options.headers?.["X-Key"], "clave-entorno");
    assert.equal(context.http.calls.at(-1)?.url, "http://env.test/x");
  });
});

describe("el login del proyecto", () => {
  const bearerWithLogin = (settings: StoredProjectAuth["settings"], secrets: Record<string, string> = {}) =>
    makeProject({ auth: { type: "bearer", settings, secretCiphertext: null }, secrets });

  test("una URL de login relativa, con cuerpo, y el token en la ruta configurada", async () => {
    const { send, http } = setup({
      project: bearerWithLogin({ loginUrl: "/auth/login", tokenPath: "data.jwt" }, { loginBody: '{"u":"a"}' }),
      http: (url) => (url.endsWith("/auth/login") ? { body: JSON.stringify({ data: { jwt: "tok-login" } }) } : { body: "{}" }),
    });
    const sent = await send({});
    assert.equal(sent.auth, "Login del proyecto");
    assert.equal(http.calls[0].url, "http://api.test/auth/login");
    assert.equal(http.calls[0].options.method, "POST");
    assert.equal(http.calls[0].options.body, '{"u":"a"}');
    assert.equal(http.calls[1].options.headers?.Authorization, "Bearer tok-login");
  });

  test("absoluta y por GET: no lleva cuerpo, y el token se busca en las rutas de siempre", async () => {
    const { send, http } = setup({
      project: bearerWithLogin({ loginUrl: "http://idp.test/token", loginMethod: "GET" }, { loginBody: "ignorado" }),
      http: (url) => (url.startsWith("http://idp.test") ? { body: JSON.stringify({ access_token: "tok-idp" }) } : { body: "{}" }),
    });
    await send({});
    assert.equal(http.calls[0].url, "http://idp.test/token");
    assert.equal(http.calls[0].options.method, "GET");
    assert.equal("body" in http.calls[0].options, false);
    assert.equal(http.calls[1].options.headers?.Authorization, "Bearer tok-idp");
  });

  const failing: [string, (url: string) => Reply, StoredProjectAuth["settings"], RegExp][] = [
    ["la red falla", () => new Error("ECONNREFUSED"), { loginUrl: "/login" }, /ECONNREFUSED/],
    ["contesta 401", () => ({ status: 401, body: "no" }), { loginUrl: "/login" }, /POST http:\/\/api\.test\/login respondió 401/],
    ["no es JSON", () => ({ body: "<html>" }), { loginUrl: "/login" }, /no es JSON/],
    ["no trae la ruta pedida", () => ({ body: '{"x":1}' }), { loginUrl: "/login", tokenPath: "a.b" }, /no tiene a\.b/],
    ["no trae ninguna de las de siempre", () => ({ body: '{"x":1}' }), { loginUrl: "/login" }, /ninguno de token, access_token/],
  ];
  for (const [what, reply, settings, detail] of failing) {
    test(`si el login ${what}, es un 422 project-login-failed que lo dice`, async () => {
      const { send } = setup({ project: bearerWithLogin(settings), http: (url) => (url.endsWith("/login") ? reply(url) : { body: "{}" }) });
      const error = await rejectsWith(send({}), "invalid", "project-login-failed");
      assert.equal(error.fields[0].field, "auth");
      assert.match(error.fields[0].detail, detail);
    });
  }

  test("un throw que no es un Error se describe como «El login no respondió»", async () => {
    const project = bearerWithLogin({ loginUrl: "/login" });
    const context = setup({ project });
    (context.http as unknown as { request: SafeFetchPort["request"] }).request = async () => {
      throw "nada";
    };
    const error = await rejectsWith(context.send({}), "invalid", "project-login-failed");
    assert.equal(error.fields[0].detail, "El login no respondió");
  });
});

describe("capturar la sesión desde el login escrito a mano", () => {
  const project = (settings: StoredProjectAuth["settings"]) =>
    makeProject({ auth: { type: "bearer", settings, secretCiphertext: null }, secrets: { token: "fijo" } });

  test("la respuesta del login con la ruta configurada guarda el token", async () => {
    const context = setup({ project: project({ loginUrl: "/login", tokenPath: "session.key" }), http: () => ({ body: '{"session":{"key":"k1"}}' }) });
    const sent = await context.send({ method: "POST", path: "/login" });
    assert.equal(sent.sessionToken, "login");
    const saved = await context.sessionTokens.find("actor-1", "p1");
    assert.equal(saved && cipher.decrypt(saved.tokenCiphertext), "k1");
  });

  test("no se captura si el cuerpo no es JSON, si no trae token o si la URL de login no se puede leer", async () => {
    const notJson = setup({ project: project({ loginUrl: "/login" }), http: () => ({ body: "hola" }) });
    assert.equal((await notJson.send({ method: "POST", path: "/login" })).sessionToken, null);

    const noToken = setup({ project: project({ loginUrl: "/login" }), http: () => ({ body: '{"ok":true}' }) });
    assert.equal((await noToken.send({ method: "POST", path: "/login" })).sessionToken, null);

    const unreadable = setup({ project: project({ loginUrl: "http://[roto" }), http: () => ({ body: '{"token":"t"}' }) });
    assert.equal((await unreadable.send({ method: "POST", path: "/login" })).sessionToken, null);
    assert.equal(await unreadable.sessionTokens.find("actor-1", "p1"), null);
  });
});

describe("la firma escrita en la petición", () => {
  test("un secreto de una {{variable}} se tapa en la respuesta; uno escrito a mano no", async () => {
    const environment = makeEnvironment({ variables: { clave: { initial: "de-variable", current: "", sensitive: false } } });
    const { send } = setup({
      environments: [environment],
      http: (_url, options) => ({ body: `eco ${options.headers?.Authorization} de-variable` }),
    });
    const fromVariable = await send({ environmentId: "env1", auth: { type: "bearer", params: { token: "{{clave}}" } } });
    assert.equal(fromVariable.auth, "Bearer de esta petición");
    assert.equal(fromVariable.response?.body.includes("de-variable"), false);

    const typed = await send({ environmentId: "env1", auth: { type: "bearer", params: { token: "a-mano" } } });
    assert.match(typed.response?.body ?? "", /Bearer a-mano/);
  });

  test("un tipo que no se puede firmar lo dice y no inventa cabecera", async () => {
    const { send, http } = setup();
    const sent = await send({ auth: { type: "ntlm", params: {} } });
    assert.match(sent.auth, /^NTLM: NTLM necesita tres vueltas/);
    assert.equal(http.calls[0].options.headers?.Authorization, undefined);
  });

  describe("OAuth 2.0 sin token", () => {
    const oauth = (params: Record<string, string>) => ({
      auth: { type: "oauth2", params: { accessTokenUrl: "http://idp.test/token", clientId: "cli", clientSecret: "sec", ...params } },
    });

    test("se pide el token y se firma con él, en la query si así se dice, con & tras una query", async () => {
      const { send, http } = setup({
        http: (url) => (url.startsWith("http://idp.test") ? { body: '{"access_token":"nuevo"}' } : { body: "{}" }),
      });
      const sent = await send({ path: "/x?a=1", ...oauth({ addTokenTo: "queryParams" }) });
      assert.equal(sent.auth, "OAuth 2.0 de esta petición · token pedido ahora");
      assert.equal(http.calls[0].url, "http://idp.test/token");
      assert.equal(http.calls[1].url, "http://api.test/x?a=1&access_token=nuevo");
      assert.equal(sent.request.url, "http://api.test/x?a=1&access_token=nuevo");
    });

    test("con la cabecera, y ? si la URL no tenía query", async () => {
      const { send, http } = setup({
        http: (url) => (url.startsWith("http://idp.test") ? { body: '{"access_token":"nuevo"}' } : { body: "{}" }),
      });
      await send(oauth({ addTokenTo: "queryParams", queryParamKey: "t" }));
      assert.equal(http.calls[1].url, "http://api.test/x?t=nuevo");
    });

    const failures: [string, Record<string, string>, (url: string) => Reply, string][] = [
      ["un flujo con navegador", { grantType: "authorization_code" }, () => ({}), "OAuth 2.0: Solo se piden aquí los flujos que no necesitan navegador"],
      ["la red falla", {}, () => new Error("caído"), "OAuth 2.0: el servidor de token no respondió"],
      ["el servidor contesta 400", {}, () => ({ status: 400, body: "{}" }), "OAuth 2.0: el servidor de token contestó 400"],
      ["el servidor contesta 199", {}, () => ({ status: 199, body: "{}" }), "OAuth 2.0: el servidor de token contestó 199"],
      ["no es JSON", {}, () => ({ body: "<html>" }), "OAuth 2.0: la respuesta del servidor de token no es JSON"],
      ["no trae access_token", {}, () => ({ body: '{"token":"x"}' }), "OAuth 2.0: la respuesta no trae access_token"],
    ];
    for (const [what, params, reply, expected] of failures) {
      test(`si ${what}, la petición sale sin credencial y se dice por qué`, async () => {
        const { send, http } = setup({ http: (url) => (url.startsWith("http://idp.test") ? reply(url) : { body: "{}" }) });
        const sent = await send(oauth(params));
        assert.equal(sent.auth, expected);
        assert.equal(http.calls.at(-1)?.url, "http://api.test/x");
        assert.equal(http.calls.at(-1)?.options.headers?.Authorization, undefined);
      });
    }

    test("un servidor de token bloqueado por el guardia no se disimula: la excepción sube", async () => {
      const { send } = setup({
        http: (url) => (url.startsWith("http://idp.test") ? new BlockedTargetError(url, "privado") : { body: "{}" }),
      });
      await assert.rejects(send(oauth({})), BlockedTargetError);
    });
  });

  describe("Digest y su reto", () => {
    const digest = { auth: { type: "digest", params: { username: "ana", password: "pw" } } };

    test("sin cabecera de reto en la respuesta, se dice", async () => {
      const { send, http } = setup({ http: () => ({ status: 200, body: "{}" }) });
      const sent = await send(digest);
      assert.equal(sent.auth, "Digest: el servidor no pidió autenticación en su respuesta");
      assert.equal(http.calls.length, 2);
    });

    test("si pedir el reto falla, se dice; si el guardia lo bloquea, sube", async () => {
      let first = true;
      const failing = setup({
        http: () => {
          if (first) {
            first = false;
            return new Error("reset");
          }
          return { body: "{}" };
        },
      });
      const sent = await failing.send(digest);
      assert.equal(sent.auth, "Digest: no se pudo pedir el reto al servidor");

      const blocked = setup({ http: (url) => new BlockedTargetError(url, "privado") });
      await assert.rejects(blocked.send(digest), BlockedTargetError);
    });

    test("con el reto en `WWW-Authenticate` en mayúsculas, se firma con él", async () => {
      let first = true;
      const { send, http } = setup({
        http: () => {
          if (first) {
            first = false;
            return { status: 401, headers: { "WWW-Authenticate": 'Digest realm="r", nonce="n1", qop="auth"' } };
          }
          return { body: "{}" };
        },
      });
      const sent = await send(digest);
      assert.equal(sent.auth, "Digest de esta petición · con el reto del servidor");
      assert.match(http.calls[1].options.headers?.Authorization ?? "", /^Digest username="ana", realm="r", nonce="n1"/);
    });
  });
});

describe("la respuesta y sus cookies", () => {
  test("un destino bloqueado: sin respuesta, con el motivo y las cookies que se habrían presentado", async () => {
    const context = setup({ http: (url) => new BlockedTargetError(url, "red privada") });
    await context.cookieJar.save("actor-1", "p1", [
      {
        name: "sid",
        value: "valor-sid",
        domain: "api.test",
        path: "/",
        expiresAt: null,
        secure: false,
        httpOnly: true,
        sameSite: null,
        hostOnly: true,
        createdAt: NOW.getTime(),
      },
    ]);
    const sent = await context.send({});
    assert.equal(sent.response, null);
    assert.match(sent.error ?? "", /red privada/);
    assert.deepEqual(sent.cookies, { sent: ["sid=api.test/"], stored: [], rejected: [] });
  });

  test("cualquier otro fallo de la red no se convierte en respuesta: sube", async () => {
    const { send } = setup({ http: () => new TypeError("otra cosa") });
    await assert.rejects(send({}), TypeError);
  });

  test("una cookie con fecha pasada se borra del tarro y se dice; una nueva se guarda", async () => {
    const context = setup({
      http: () => ({
        body: "{}",
        setCookie: ["viejo=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT", "nuevo=1; Path=/"],
      }),
    });
    await context.cookieJar.save("actor-1", "p1", [
      {
        name: "viejo",
        value: "x",
        domain: "api.test",
        path: "/",
        expiresAt: null,
        secure: false,
        httpOnly: false,
        sameSite: null,
        hostOnly: true,
        createdAt: NOW.getTime() - 10,
      },
    ]);
    const sent = await context.send({});
    assert.deepEqual(sent.cookies.stored, ["nuevo=api.test/", "viejo (borrada)"]);
    const jar = await context.cookieJar.list("actor-1", "p1");
    assert.deepEqual(jar.map((cookie) => cookie.name), ["nuevo"]);
  });

  test("solo una cookie de borrado: nada que guardar, solo que se borró", async () => {
    const context = setup({ http: () => ({ body: "{}", setCookie: ["fuera=; Path=/; Max-Age=0"] }) });
    const sent = await context.send({});
    assert.deepEqual(sent.cookies.stored, ["fuera (borrada)"]);
  });
});

describe("cuerpos y cabeceras", () => {
  test("una cabecera apagada ni se envía ni la ve el script; el Content-Type escrito gana", async () => {
    const { send, http, sandbox } = setup();
    await send({
      method: "POST",
      headers: [
        { name: "X-Off", value: "1", enabled: false },
        { name: "content-type", value: "application/vnd+json" },
      ],
      body: { mode: "json", text: '{"a":1}' },
      preRequestScript: "pm.test('x', () => {})",
    });
    assert.deepEqual(sandbox.inputs[0].request.headers, { "content-type": "application/vnd+json" });
    assert.equal(sandbox.inputs[0].request.body, '{"a":1}');
    assert.equal(http.calls[0].options.headers?.["X-Off"], undefined);
    assert.equal(http.calls[0].options.headers?.["Content-Type"], undefined);
    assert.equal(http.calls[0].options.headers?.["content-type"], "application/vnd+json");
    assert.equal(http.calls[0].options.body, '{"a":1}');
  });

  test("un cuerpo en un GET no sale; un formulario sin texto lo ve el script como null", async () => {
    const { send, http, sandbox } = setup();
    await send({
      method: "GET",
      body: { mode: "x-www-form-urlencoded", fields: [{ name: "a", value: "1" }] },
      preRequestScript: "1",
    });
    assert.equal(sandbox.inputs[0].request.body, null);
    assert.equal("body" in http.calls[0].options, false);
  });
});

describe("los scripts", () => {
  test("sin entorno: lo que el script guarda solo vale para la petición, y se avisa", async () => {
    const { send, sandbox } = setup({
      sandbox: (input) =>
        input.phase === "pre"
          ? outcome({ environmentSet: { id: "7" }, environmentUnset: ["nada"] })
          : outcome({ environmentSet: { visto: input.environment.values.id ?? "" } }),
    });
    const sent = await send({ path: "/items/{{id}}", preRequestScript: "pre", postResponseScript: "post" });
    assert.equal(sent.request.url, "http://api.test/items/7");
    assert.equal(sandbox.inputs[0].environment.name, null);
    assert.deepEqual(sent.scripts.pre?.environmentUpdates, []);
    assert.equal(sent.scripts.pre?.logs.at(-1)?.level, "warn");
    assert.match(sent.scripts.pre?.logs.at(-1)?.text ?? "", /Sin entorno/);
    assert.equal(sandbox.inputs[1].environment.values.id, "7");
  });

  test("con entorno: se guarda, un unset lo borra y un valor escrito en una variable secreta se tapa", async () => {
    const environment = makeEnvironment({
      variables: {
        token: { initial: "", current: "", sensitive: true },
        borrar: { initial: "b", current: "", sensitive: false },
      },
      disabledVariables: { apagada: { initial: "", current: "", sensitive: true } },
    });
    const context = setup({
      environments: [environment],
      http: () => ({ body: "respuesta con s3cr3t0 y tambien apagada-secreta" }),
      sandbox: (input) =>
        input.phase === "pre"
          ? outcome({
              environmentSet: { token: "s3cr3t0", apagada: "apagada-secreta" },
              environmentUnset: ["borrar"],
              logs: [{ level: "log", text: "token=s3cr3t0" }],
            })
          : outcome({ environmentSet: { token: "" } }),
    });
    const sent = await context.send({ environmentId: "env1", preRequestScript: "pre", postResponseScript: "post" });
    assert.deepEqual(sent.scripts.pre?.environmentUpdates.sort(), ["apagada", "borrar", "token"]);
    assert.equal(sent.scripts.pre?.logs[0].text.includes("s3cr3t0"), false);
    assert.equal(sent.response?.body.includes("s3cr3t0"), false);
    assert.equal(sent.response?.body.includes("apagada-secreta"), false);
    assert.equal("borrar" in context.sandbox.inputs[1].environment.values, false);
    const stored = await context.environments.findById("env1");
    assert.ok(stored);
    assert.notEqual(stored.variables.token.current, "s3cr3t0");
    // Un script que captura `token` en blanco no deja sesión.
    assert.equal(sent.sessionToken, "script");
  });

  test("las cabeceras que deja el script previo sustituyen a las escritas", async () => {
    const { send, http } = setup({ sandbox: () => outcome({ headers: { "X-Firma": "del-script" } }) });
    await send({ headers: [{ name: "X-Escrita", value: "1" }], preRequestScript: "pm.request.headers.upsert(...)" });
    assert.equal(http.calls[0].options.headers?.["X-Firma"], "del-script");
    assert.equal(http.calls[0].options.headers?.["X-Escrita"], undefined);
  });

  test("un login configurado en la raíz no captura nada: toda petición acabaría en él", async () => {
    const context = setup({
      project: makeProject({ auth: { type: "bearer", settings: { loginUrl: "/" }, secretCiphertext: null }, secrets: { token: "t" } }),
      http: () => ({ body: '{"token":"no"}' }),
    });
    const sent = await context.send({ method: "POST", path: "/" });
    assert.equal(sent.sessionToken, null);
  });

  test("un script previo que falla no envía nada y dice qué pasó", async () => {
    const { send, http } = setup({ sandbox: () => outcome({ error: "TypeError: x (línea 1)" }) });
    const sent = await send({ preRequestScript: "x()" });
    assert.equal(http.calls.length, 0);
    assert.equal(sent.auth, "No se envió");
    assert.match(sent.error ?? "", /TypeError/);
  });
});
