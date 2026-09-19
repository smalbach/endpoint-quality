/**
 * «Enviar» con el manejador a pelo (la red y el sandbox guionizados, como en
 * authep-cov-send-request): la última palabra del servidor sobre una cookie y el login del
 * proyecto reconocido cuando no hay URL base.
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
import type { SafeFetchPort, SafeFetchResult, SafeRequestOptions } from "@/shared/http/safe-fetch";
import type { ScriptInput, ScriptOutcome, ScriptSandboxPort } from "@/shared/scripts/script-sandbox";
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

const EXPIRED = "Expires=Thu, 01 Jan 1970 00:00:00 GMT";

describe("las cookies: cuenta la última palabra del servidor", () => {
  test("puesta y borrada en la misma respuesta queda borrada, en el tarro y en lo que se dice", async () => {
    const context = setup({ http: () => ({ body: "{}", setCookie: ["sesion=1; Path=/", `sesion=; Path=/; ${EXPIRED}`] }) });
    const sent = await context.send({});
    assert.deepEqual(sent.cookies.stored, ["sesion (borrada)"]);
    assert.deepEqual(await context.cookieJar.list("actor-1", "p1"), []);
  });

  test("borrada y vuelta a poner queda puesta, una sola vez", async () => {
    const context = setup({ http: () => ({ body: "{}", setCookie: [`sesion=; Path=/; ${EXPIRED}`, "sesion=2; Path=/"] }) });
    const sent = await context.send({});
    assert.deepEqual(sent.cookies.stored, ["sesion=api.test/"]);
    const jar = await context.cookieJar.list("actor-1", "p1");
    assert.deepEqual(jar.map((cookie) => [cookie.name, cookie.value]), [["sesion", "2"]]);
  });

  test("renovar una cookie del tarro conserva su fecha de creación", async () => {
    const context = setup({ http: () => ({ body: "{}", setCookie: ["sesion=nueva; Path=/"] }) });
    const createdAt = NOW.getTime() - 60_000;
    await context.cookieJar.save("actor-1", "p1", [
      {
        name: "sesion",
        value: "vieja",
        domain: "api.test",
        path: "/",
        expiresAt: null,
        secure: false,
        httpOnly: false,
        sameSite: null,
        hostOnly: true,
        createdAt,
      },
    ]);
    await context.send({});
    const [cookie] = await context.cookieJar.list("actor-1", "p1");
    assert.equal(cookie.value, "nueva");
    assert.equal(cookie.createdAt, createdAt);
  });
});

describe("el login del proyecto escrito a mano, sin URL base", () => {
  test("una URL absoluta cuya ruta es la del login relativo captura el token", async () => {
    const context = setup({
      project: makeProject({
        baseUrl: "",
        auth: { type: "bearer", settings: { loginUrl: "/login" }, secretCiphertext: null },
        secrets: { token: "fijo" },
      }),
      http: () => ({ body: '{"token":"t-login"}' }),
    });
    const sent = await context.send({ method: "POST", path: "http://api.test/login" });
    assert.equal(context.http.calls[0].url, "http://api.test/login");
    assert.equal(sent.sessionToken, "login");
    const saved = await context.sessionTokens.find("actor-1", "p1");
    assert.equal(saved && cipher.decrypt(saved.tokenCiphertext), "t-login");
  });
});

