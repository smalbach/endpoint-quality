/**
 * Los manejadores de proyectos, contratos, roles e identidad en los bordes que la API no alcanza:
 * un correo que falla con algo que no es un `Error`, un slug ocupado mil veces, un contrato activo
 * que ya no está, una cabecera guardada que no se puede descifrar o un cifrador sin clave.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { FixedClock } from "@/shared/clock/clock.port";
import { loadEnv } from "@/shared/config/env";
import { DomainError } from "@/shared/errors/domain-error";
import type { MailerPort } from "@/shared/mail/mailer";
import type { User } from "@/modules/auth/domain/model";
import { passwordProblems } from "@/modules/auth/domain/password-policy";
import {
  RequestPasswordResetCommand,
  RequestPasswordResetHandler,
} from "@/modules/auth/application/commands/request-password-reset";
import { SendWelcomeMailHandler } from "@/modules/auth/application/events/send-welcome-mail";
import { UserRegisteredEvent } from "@/modules/auth/application/events/user-registered.event";
import { ChangeMemberRoleCommand, ChangeMemberRoleHandler } from "@/modules/iam/application/commands/change-member-role";
import { InviteMemberCommand, InviteMemberHandler } from "@/modules/iam/application/commands/invite-member";
import { freeSlug } from "@/modules/projects/application/commands/create-project";
import { ImportAnythingCommand, ImportAnythingHandler } from "@/modules/projects/application/commands/import-anything";
import { GetMergeRequestHandler, GetMergeRequestQuery } from "@/modules/projects/application/commands/merge-requests";
import { MergeRequestNotifier } from "@/modules/projects/application/merge-request-notifier";
import type { ForkMergeRequest } from "@/modules/projects/domain/merge-request";
import type { Project } from "@/modules/projects/domain/model";
import { MASK, NO_AUTH, projectAuthProblems, viewProjectAuth } from "@/modules/projects/domain/project-auth";
import { syncAccessSection } from "@/modules/roles/application/sync-access";
import { deriveAccess } from "@/modules/roles/domain/derive-access";
import { roleProblems, type Role } from "@/modules/roles/domain/model";
import { CheckSpecDriftCommand, CheckSpecDriftHandler } from "@/modules/specs/application/commands/check-spec-drift";
import {
  ImportSpecVersionCommand,
  ImportSpecVersionHandler,
} from "@/modules/specs/application/commands/import-spec-version";
import {
  GetOperationsHandler,
  GetOperationsQuery,
  ListSpecVersionsHandler,
  ListSpecVersionsQuery,
} from "@/modules/specs/application/queries/get-operations";
import type { SpecVersion } from "@/modules/specs/domain/model";

import { InMemoryEndpointRepository } from "../support/in-memory-endpoints";
import { InMemoryPasswordResetRepository } from "../support/in-memory-password-resets";
import {
  InMemoryConfigRepository,
  InMemoryInvitationRepository,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository,
  InMemoryProjectRepository,
  InMemoryRoleRepository,
  InMemorySpecRepository,
  InMemoryUserRepository,
} from "../support/in-memory-repositories";

const NOW = new Date("2026-03-01T10:00:00.000Z");
const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://unused/unused",
  JWT_ACCESS_SECRET: "a".repeat(48),
  JWT_REFRESH_SECRET: "b".repeat(48),
  APP_URL: "https://app.example.com/",
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

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

/** Replaces a handler's private Nest logger with one that records, so the test can read it. */
function recordLogs(instance: object): string[] {
  const lines: string[] = [];
  const record = (message: string) => lines.push(message);
  (instance as { logger: unknown }).logger = { error: record, warn: record, log: record };
  return lines;
}

/** A mail provider that fails the way some libraries do: rejecting with a bare string. */
const stringFailingMailer: MailerPort = {
  async send() {
    throw "buzón lleno";
  },
};

const user = (id: string): User => ({
  id,
  email: `${id}@example.com`,
  name: id,
  passwordDigest: "",
  status: "active",
  createdAt: NOW,
  failedLoginAttempts: 0,
  lockedUntil: null,
});

const project = (id: string, fields: Partial<Project> = {}): Project => ({
  id,
  organizationId: "o1",
  name: id,
  slug: id,
  description: "",
  createdBy: "u1",
  createdAt: NOW,
  archivedAt: null,
  activeSpecVersionId: null,
  activeEnvironmentId: null,
  baseUrl: "",
  tags: [],
  auth: NO_AUTH,
  deletedAt: null,
  ...fields,
});

const OPENAPI = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Pedidos", version: "1.0.0" },
  paths: { "/orders": { get: { operationId: "listOrders", responses: { "200": { description: "ok" } } } } },
});

describe("un correo que falla con algo que no es un Error se registra tal cual", () => {
  test("restablecer la contraseña", async () => {
    const users = new InMemoryUserRepository();
    await users.save(user("u1"));
    const handler = new RequestPasswordResetHandler(
      users,
      new InMemoryPasswordResetRepository(),
      stringFailingMailer,
      new FixedClock(NOW),
      env,
    );
    const logs = recordLogs(handler);
    await handler.execute(new RequestPasswordResetCommand("u1@example.com"));
    await tick();
    assert.deepEqual(logs, ["No se pudo enviar el correo de restablecer: buzón lleno"]);
  });

  test("la bienvenida", async () => {
    const handler = new SendWelcomeMailHandler(new InMemoryUserRepository(), stringFailingMailer, env);
    const logs = recordLogs(handler);
    await handler.handle(new UserRegisteredEvent("u1", "u1@example.com", "o1", NOW));
    assert.deepEqual(logs, ["No se pudo enviar el correo de bienvenida: buzón lleno"]);
  });

  test("la invitación", async () => {
    const memberships = new InMemoryMembershipRepository();
    await memberships.save({ organizationId: "o1", userId: "admin", role: "admin", createdAt: NOW });
    const handler = new InviteMemberHandler(
      new InMemoryInvitationRepository(),
      memberships,
      new InMemoryOrganizationRepository(),
      stringFailingMailer,
      new FixedClock(NOW),
      env,
    );
    const logs = recordLogs(handler);
    const { invitationId } = await handler.execute(new InviteMemberCommand("o1", "x@example.com", "viewer", "admin"));
    await tick();
    assert.deepEqual(logs, [`No se pudo enviar la invitación ${invitationId}: buzón lleno`]);
  });

  test("el aviso de una solicitud de fusión", async () => {
    const notifier = new MergeRequestNotifier(
      stringFailingMailer,
      { findById: async (id: string) => user(id) } as never,
      env,
      { list: async () => [] } as never,
    );
    const logs = recordLogs(notifier);
    notifier.notify({ id: "mr-1", createdBy: "autor", organizationId: "o1", parentProjectId: "p" } as ForkMergeRequest, "approved", "revisor");
    await tick();
    await tick();
    assert.deepEqual(logs, ["No se pudo avisar de la solicitud mr-1: buzón lleno"]);
  });
});

describe("identidad y miembros", () => {
  test("una contraseña sin minúsculas dice solo eso", () => {
    assert.deepEqual(passwordProblems("SOLO-MAYUSCULAS-1"), ["Debe incluir una minúscula"]);
  });

  test("un propietario cambia el rol de un editor y queda guardado", async () => {
    const memberships = new InMemoryMembershipRepository();
    await memberships.save({ organizationId: "o1", userId: "owner", role: "owner", createdAt: NOW });
    await memberships.save({ organizationId: "o1", userId: "editor", role: "editor", createdAt: NOW });
    await new ChangeMemberRoleHandler(memberships).execute(new ChangeMemberRoleCommand("o1", "editor", "viewer", "owner"));
    assert.equal((await memberships.find("o1", "editor"))?.role, "viewer");
    assert.equal((await memberships.find("o1", "owner"))?.role, "owner");
  });
});

describe("proyectos", () => {
  test("con el slug y sus 998 sucesores ocupados, el sufijo es aleatorio", async () => {
    const taken = { findBySlug: async () => project("x") };
    assert.match(await freeSlug(taken as never, "o1", "catalogo"), /^catalogo-[0-9a-f]{8}$/);
  });

  test("importar: un destino que falla con algo que no es un Error se nombra con un mensaje genérico", async () => {
    const projects = new InMemoryProjectRepository();
    await projects.save(project("p1"));
    const commandBus = { execute: () => Promise.reject("nada") };
    const handler = new ImportAnythingHandler(commandBus as never, projects, {} as never);
    const result = await handler.execute(
      new ImportAnythingCommand("o1", "p1", { sources: [{ name: "api.yaml", text: OPENAPI }] }, "u1"),
    );
    assert.deepEqual(result.items[0]!.results, [
      { target: "contract", name: "api.yaml", summary: null, error: "No se pudo importar" },
    ]);
  });

  test("una solicitud cuya comparación falla por algo inesperado no se lee a medias: el error sube", async () => {
    const views = { find: async () => ({ id: "mr-1", status: "open", forkProjectId: "fork" }) };
    const sync = {
      compare: async () => {
        throw new TypeError("la base de datos se fue");
      },
    };
    const handler = new GetMergeRequestHandler(views as never, sync as never);
    await assert.rejects(handler.execute(new GetMergeRequestQuery("o1", "p1", "mr-1", "u1")), {
      name: "TypeError",
      message: "la base de datos se fue",
    });
  });

  test("un login mal descrito dice qué campo falla: la URL, el método y un cuerpo que no es un objeto", () => {
    const fields = (input: Record<string, string>) =>
      projectAuthProblems({ type: "bearer", token: "t", ...input } as never, NO_AUTH).map((problem) => problem.field);
    assert.deepEqual(fields({ loginUrl: "ftp://x.test/login" }), ["auth.loginUrl"]);
    assert.deepEqual(fields({ loginUrl: "/login", loginMethod: "BREW" }), ["auth.loginMethod"]);
    assert.deepEqual(fields({ loginUrl: "/login", loginBody: "[1]" }), ["auth.loginBody"]);
    assert.deepEqual(fields({ loginUrl: "/login", loginMethod: "put", loginBody: '{"a":1}' }), []);
  });

  test("la autenticación guardada enseña la máscara en cada secreto que tiene, y nada en los que no", () => {
    const view = viewProjectAuth({
      type: "login",
      settings: { secretFields: ["password", "apiKey"] },
      secretCiphertext: "cifrado",
    } as never);
    assert.equal(view.password, MASK);
    assert.equal(view.apiKey, MASK);
    assert.equal(view.token, "");
    assert.equal(view.loginBody, "");
  });
});

describe("roles", () => {
  const role = (id: string, name: string, position = 0): Role => ({
    id,
    projectId: "p1",
    name,
    description: "",
    color: "#6366f1",
    sameRoleDataIsolation: false,
    position,
    createdAt: NOW,
    updatedAt: NOW,
  });

  test("al crear, un rol sin nombre y una descripción de 501 caracteres son dos problemas", () => {
    assert.deepEqual(
      roleProblems({ description: "x".repeat(501) }, true).map((problem) => problem.field),
      ["name", "description"],
    );
    assert.deepEqual(roleProblems({ description: "x".repeat(500) }, false), []);
  });

  test("una regla guardada sobre una operación sin endpoint conserva sus deny, renombrados y sin los roles que ya no están", () => {
    const access = deriveAccess(
      { rules: [{ operationId: "legacyOp", allow: [], deny: ["viejo", "borrado"] }] },
      [role("r1", "nuevo")],
      [],
      [],
      { viejo: "nuevo" },
    );
    assert.deepEqual(access.rules, [{ operationId: "legacyOp", allow: [], deny: ["nuevo"] }]);
  });

  test("sincronizar access: sin roles ni sección no se escribe nada; una sección que no valida es un error", async () => {
    const deps = {
      roles: new InMemoryRoleRepository(),
      endpoints: new InMemoryEndpointRepository(),
      config: new InMemoryConfigRepository(),
      clock: new FixedClock(NOW),
    };
    await syncAccessSection(deps, "p1", "u1");
    assert.equal(await deps.config.findSection("p1", "access"), null);

    await deps.roles.save(role("r1", "admin"));
    await deps.config.saveSection({
      projectId: "p1",
      section: "access",
      // 200 no es un rechazo: el esquema no acepta estados de rechazo fuera de 4xx.
      data: { access: { roles: [], deniedStatuses: [200], rules: [], crossRole: [] } },
      updatedAt: NOW,
      updatedBy: "u1",
    });
    await assert.rejects(syncAccessSection(deps, "p1", "u1"), /La sección access derivada de los roles no es válida/);
    const stored = (await deps.config.findSection("p1", "access"))!.data as { access: { roles: string[] } };
    assert.deepEqual(stored.access.roles, [], "lo que no valida no se guarda");
  });
});

describe("contratos", () => {
  const version = (id: string, projectId: string): SpecVersion => ({
    id,
    projectId,
    sourceId: null,
    hash: id,
    raw: OPENAPI,
    format: "json",
    openapiVersion: "3.0.3",
    title: "Pedidos",
    contractVersion: "1.0.0",
    operationCount: 0,
    problems: [],
    importedBy: "u1",
    importedAt: NOW,
  });

  test("las operaciones: proyecto ajeno o inexistente, sin contrato, y una versión que no existe o es de otro", async () => {
    const projects = new InMemoryProjectRepository();
    const specs = new InMemorySpecRepository();
    await projects.save(project("sin-contrato"));
    await projects.save(project("roto", { activeSpecVersionId: "no-existe" }));
    await projects.save(project("otro"));
    await specs.saveVersion(version("v-otro", "otro"), []);
    const handler = new GetOperationsHandler(projects, specs);

    await rejectsWith(handler.execute(new GetOperationsQuery("o1", "nadie")), "not-found", "project-not-found");
    await rejectsWith(handler.execute(new GetOperationsQuery("o2", "otro")), "not-found", "project-not-found");
    await rejectsWith(handler.execute(new GetOperationsQuery("o1", "sin-contrato")), "conflict", "no-active-spec");
    await rejectsWith(handler.execute(new GetOperationsQuery("o1", "roto")), "not-found", "spec-version-not-found");
    await rejectsWith(
      handler.execute(new GetOperationsQuery("o1", "sin-contrato", "v-otro")),
      "not-found",
      "spec-version-not-found",
    );

    const versions = new ListSpecVersionsHandler(projects, specs);
    await rejectsWith(versions.execute(new ListSpecVersionsQuery("o2", "otro")), "not-found", "project-not-found");
    assert.deepEqual(await versions.execute(new ListSpecVersionsQuery("o1", "sin-contrato")), { active: null, versions: [] });
  });

  test("la deriva: sin contrato activo es un 409; con uno que ya no está, un 404; y no se importa nada", async () => {
    const projects = new InMemoryProjectRepository();
    await projects.save(project("sin-contrato"));
    await projects.save(project("roto", { activeSpecVersionId: "no-existe" }));
    const executed: unknown[] = [];
    const handler = new CheckSpecDriftHandler(projects, new InMemorySpecRepository(), {
      execute: async (command: unknown) => executed.push(command),
    } as never);
    const source = { kind: "inline" as const, raw: OPENAPI };
    await rejectsWith(handler.execute(new CheckSpecDriftCommand("o1", "sin-contrato", source, "u1")), "conflict", "no-active-spec");
    await rejectsWith(
      handler.execute(new CheckSpecDriftCommand("o1", "roto", source, "u1")),
      "not-found",
      "spec-version-not-found",
    );
    assert.deepEqual(executed, []);
  });

  describe("importar", () => {
    const URL = "https://contracts.example.com/openapi.json";

    function setup(cipher: { encrypt(value: string): string; decrypt(value: string): string }) {
      const projects = new InMemoryProjectRepository();
      const specs = new InMemorySpecRepository();
      const requests: { url: string; headers?: Record<string, string> }[] = [];
      const http = {
        get: async (url: string, options: { headers?: Record<string, string> } = {}) => {
          requests.push({ url, headers: options.headers });
          return { status: 200, body: OPENAPI };
        },
      };
      const handler = new ImportSpecVersionHandler(
        projects,
        specs,
        http as never,
        cipher,
        new FixedClock(NOW),
        { publish: () => undefined } as never,
      );
      const logs = recordLogs(handler);
      return { projects, specs, requests, handler, logs };
    }
    const broken = {
      encrypt(): string {
        throw new Error("SECRETS_KEY no está configurada");
      },
      decrypt(): string {
        throw new Error("la clave no abre esto");
      },
    };

    test("sin fuente y con la última subida como fichero, dice que hay que adjuntarlo", async () => {
      const { projects, specs, handler } = setup(broken);
      await projects.save(project("p1"));
      await specs.saveSource({ id: "s1", projectId: "p1", kind: "upload", location: "api.yaml", headersCiphertext: null, createdAt: NOW });
      const error = await rejectsWith(
        handler.execute(new ImportSpecVersionCommand("o1", "p1", undefined, "u1", true)),
        "conflict",
        "spec-source-not-repeatable",
      );
      assert.match(error.message, /fue un fichero subido/);
    });

    test("unas cabeceras guardadas que no se descifran: se lee sin ellas y se avisa", async () => {
      const { projects, specs, requests, handler, logs } = setup(broken);
      await projects.save(project("p1"));
      await specs.saveSource({ id: "s1", projectId: "p1", kind: "url", location: URL, headersCiphertext: "basura", createdAt: NOW });
      const result = await handler.execute(new ImportSpecVersionCommand("o1", "p1", undefined, "u1", true));
      assert.equal(result.operationCount, 1);
      assert.deepEqual(requests, [{ url: URL, headers: undefined }]);
      assert.deepEqual(logs, [`Las cabeceras guardadas de ${URL} no se pudieron descifrar: ¿cambió SECRETS_KEY?`]);
    });

    test("sin clave para cifrar, el contrato se importa y las cabeceras no se guardan en claro", async () => {
      const { projects, specs, requests, handler, logs } = setup(broken);
      await projects.save(project("p1"));
      const result = await handler.execute(
        new ImportSpecVersionCommand("o1", "p1", { kind: "url", url: URL, headers: { Authorization: "Bearer x" } }, "u1", true),
      );
      assert.equal(result.activated, true);
      assert.deepEqual(requests[0]!.headers, { Authorization: "Bearer x" });
      const [source] = [...specs.sources.values()];
      assert.equal(source!.headersCiphertext, null);
      assert.equal(logs.length, 1);
      assert.match(logs[0]!, /SECRETS_KEY no está configurada/);
    });
  });
});
