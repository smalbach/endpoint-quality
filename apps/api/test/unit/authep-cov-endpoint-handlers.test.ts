/**
 * Los manejadores de endpoints, ejemplos y permisos por rol, a pelo y con los repositorios de
 * memoria: los caminos de error que la validación de la API tapa antes de llegar —un `orderIndex`
 * negativo, un acceso que no existe— y los que ninguna prueba HTTP había pisado todavía —un
 * proyecto archivado, una ruta que choca al editarla, la lista de ejemplos llena—.
 */
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { FixedClock } from "@/shared/clock/clock.port";
import { DomainError } from "@/shared/errors/domain-error";
import type { Project } from "@/modules/projects/domain/model";
import { blankEndpoint, type Endpoint } from "@/modules/endpoints/domain/model";
import { blankExample, MAX_EXAMPLES_PER_ENDPOINT, type ExampleRequest, type ExampleResponse } from "@/modules/endpoints/domain/examples";
import {
  CreateEndpointCommand,
  CreateEndpointHandler,
  UpdateEndpointCommand,
  UpdateEndpointHandler,
} from "@/modules/endpoints/application/commands/manage-endpoints";
import {
  SaveExampleCommand,
  SaveExampleHandler,
  UpdateExampleCommand,
  UpdateExampleHandler,
} from "@/modules/endpoints/application/commands/manage-examples";
import {
  ReplaceRoleRulesCommand,
  ReplaceRoleRulesHandler,
  SetEndpointRoleAccessCommand,
  SetEndpointRoleAccessHandler,
  SetRolePermissionsCommand,
  SetRolePermissionsHandler,
} from "@/modules/roles/application/commands/permissions";
import type { Role } from "@/modules/roles/domain/model";
import { UpsertCredentialCommand, UpsertCredentialHandler } from "@/modules/environments/application/commands/manage-credential";
import { AesGcmSecretCipher } from "@/shared/crypto/secret-cipher";

import {
  InMemoryConfigRepository,
  InMemoryEnvironmentRepository,
  InMemoryProjectRepository,
  InMemoryRoleRepository,
  InMemorySpecRepository,
} from "../support/in-memory-repositories";
import { InMemoryEndpointRepository, InMemoryExampleRepository } from "../support/in-memory-endpoints";

const NOW = new Date("2026-03-01T10:00:00.000Z");

const project = (fields: Partial<Project> = {}): Project => ({
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
  auth: { type: "none", settings: {}, secretCiphertext: null },
  deletedAt: null,
  ...fields,
});

const endpoint = (id: string, fields: Partial<Endpoint> = {}): Endpoint => ({
  ...blankEndpoint({ id, projectId: "p1", origin: "manual", orderIndex: 0, now: NOW, actorId: "u1" }),
  ...fields,
});

const role = (id: string, name: string): Role => ({
  id,
  projectId: "p1",
  name,
  description: "",
  color: "#6366f1",
  sameRoleDataIsolation: false,
  position: 0,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  deletedAt: null,
});

const request: ExampleRequest = {
  method: "GET",
  url: "https://api.test/users",
  headers: [],
  body: { text: "", contentType: "application/json" },
};
const response: ExampleResponse = {
  status: 200,
  headers: [],
  body: "{}",
  contentType: "application/json",
  durationMs: 1,
};

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

let projects: InMemoryProjectRepository;
let endpoints: InMemoryEndpointRepository;
let examples: InMemoryExampleRepository;
let roles: InMemoryRoleRepository;
let config: InMemoryConfigRepository;
let specs: InMemorySpecRepository;
let clock: FixedClock;

beforeEach(async () => {
  projects = new InMemoryProjectRepository();
  endpoints = new InMemoryEndpointRepository();
  examples = new InMemoryExampleRepository();
  roles = new InMemoryRoleRepository();
  config = new InMemoryConfigRepository();
  specs = new InMemorySpecRepository();
  clock = new FixedClock(NOW);
  await projects.save(project());
  await endpoints.save(endpoint("e1", { method: "GET", path: "/users" }));
  await endpoints.save(endpoint("e2", { method: "GET", path: "/orders" }));
});

describe("endpoints", () => {
  test("crear sin ruta es un 422 que nombra la ruta, antes de mirar el proyecto", async () => {
    const create = new CreateEndpointHandler(projects, specs, endpoints, clock);
    const error = await rejectsWith(create.execute(new CreateEndpointCommand("o1", "nadie", { method: "GET" }, "u1")), "invalid");
    assert.deepEqual(error.fields, [{ field: "path", detail: "Falta la ruta" }]);
  });

  test("en un proyecto archivado no se escribe: 409 project-archived", async () => {
    await projects.save(project({ archivedAt: NOW }));
    const create = new CreateEndpointHandler(projects, specs, endpoints, clock);
    await rejectsWith(create.execute(new CreateEndpointCommand("o1", "p1", { path: "/nuevo" }, "u1")), "conflict", "project-archived");
    assert.equal(endpoints.rows.size, 2);
  });

  test("editar: 422 con datos malos, 404 si no existe, 409 si la ruta nueva ya es de otro", async () => {
    const update = new UpdateEndpointHandler(projects, specs, endpoints, clock);
    const invalid = await rejectsWith(update.execute(new UpdateEndpointCommand("o1", "p1", "e1", { path: "sin-barra" }, "u1")), "invalid");
    assert.deepEqual(invalid.fields.map((field) => field.field), ["path"]);

    await rejectsWith(update.execute(new UpdateEndpointCommand("o1", "p1", "no-existe", { description: "x" }, "u1")), "not-found", "endpoint-not-found");

    await rejectsWith(
      update.execute(new UpdateEndpointCommand("o1", "p1", "e1", { path: "/orders" }, "u1")),
      "conflict",
      "endpoint-duplicate",
    );
    assert.equal((await endpoints.findById("p1", "e1"))?.path, "/users");
  });

  test("editar a una ruta libre la guarda con quién y cuándo", async () => {
    clock.advance(60_000);
    const update = new UpdateEndpointHandler(projects, specs, endpoints, clock);
    const view = await update.execute(new UpdateEndpointCommand("o1", "p1", "e1", { method: "POST", path: "/users/:id" }, "u2"));
    assert.equal(view.path, "/users/{id}");
    const stored = await endpoints.findById("p1", "e1");
    assert.equal(stored?.method, "POST");
    assert.equal(stored?.updatedBy, "u2");
    assert.equal(stored?.updatedAt.getTime(), NOW.getTime() + 60_000);
  });
});

describe("ejemplos", () => {
  test("con nombre: se valida y se guarda con él", async () => {
    const save = new SaveExampleHandler(projects, endpoints, examples, clock);
    const long = await rejectsWith(
      save.execute(new SaveExampleCommand("o1", "p1", "e1", "x".repeat(500), request, response, "u1")),
      "invalid",
    );
    assert.deepEqual(long.fields.map((field) => field.field), ["name"]);
    const saved = await save.execute(new SaveExampleCommand("o1", "p1", "e1", "  Lista  ", request, response, "u1"));
    assert.equal(saved.example.name, "Lista");
  });

  test(`un endpoint con ${MAX_EXAMPLES_PER_ENDPOINT} ejemplos no admite otro: 409 examples-full`, async () => {
    for (let index = 0; index < MAX_EXAMPLES_PER_ENDPOINT; index += 1)
      await examples.save(
        blankExample({
          projectId: "p1",
          endpointId: "e1",
          name: `n${index}`,
          request,
          response,
          origin: "manual",
          orderIndex: index,
          now: NOW,
          actorId: "u1",
        }),
      );
    const save = new SaveExampleHandler(projects, endpoints, examples, clock);
    const error = await rejectsWith(save.execute(new SaveExampleCommand("o1", "p1", "e1", "", request, response, "u1")), "conflict", "examples-full");
    assert.match(error.message, /50 ejemplos/);
    assert.equal((await examples.listByEndpoint("p1", "e1")).length, MAX_EXAMPLES_PER_ENDPOINT);
  });

  test("editar: 404 si no existe; un orderIndex negativo es un 422 aunque la API ya lo pare antes", async () => {
    const saved = await new SaveExampleHandler(projects, endpoints, examples, clock).execute(
      new SaveExampleCommand("o1", "p1", "e1", "", request, response, "u1"),
    );
    const update = new UpdateExampleHandler(projects, examples, clock);
    await rejectsWith(update.execute(new UpdateExampleCommand("o1", "p1", "no-existe", { name: "x" })), "not-found", "example-not-found");
    const negative = await rejectsWith(update.execute(new UpdateExampleCommand("o1", "p1", saved.example.id, { orderIndex: -1 })), "invalid");
    assert.deepEqual(negative.fields, [{ field: "orderIndex", detail: "No puede ser negativo" }]);

    const moved = await update.execute(new UpdateExampleCommand("o1", "p1", saved.example.id, { orderIndex: 3 }));
    assert.equal(moved.example.orderIndex, 3);
    assert.equal(moved.example.name, saved.example.name);
  });
});

describe("permisos por rol", () => {
  beforeEach(async () => {
    await roles.save(role("r1", "admin"));
    await roles.save(role("r2", "cliente"));
  });

  test("un rol sobre sus endpoints: acceso y alcance que no existen, endpoint ajeno o repetido", async () => {
    const handler = new SetRolePermissionsHandler(projects, roles, endpoints, config, clock);
    const error = await rejectsWith(
      handler.execute(
        new SetRolePermissionsCommand(
          "o1",
          "p1",
          "r1",
          [
            { endpointId: "e1", access: "quizá" as never, dataScope: "algunos" as never },
            { endpointId: "e1", access: "allow" },
            { endpointId: "ajeno", access: "deny" },
          ],
          "u1",
        ),
      ),
      "invalid",
    );
    assert.deepEqual(
      error.fields.map((field) => field.field),
      ["permissions.0.access", "permissions.0.dataScope", "permissions.1.endpointId", "permissions.2.endpointId"],
    );
    assert.equal(roles.permissions.size, 0);
  });

  test("sin alcance se guarda «all»", async () => {
    const handler = new SetRolePermissionsHandler(projects, roles, endpoints, config, clock);
    assert.deepEqual(await handler.execute(new SetRolePermissionsCommand("o1", "p1", "r1", [{ endpointId: "e1", access: "allow" }], "u1")), { updated: 1 });
    assert.deepEqual([...roles.permissions.values()].map((cell) => [cell.roleId, cell.endpointId, cell.access, cell.dataScope]), [
      ["r1", "e1", "allow", "all"],
    ]);
  });

  test("desde un endpoint: 404 si no existe; rol ajeno o repetido es un 422", async () => {
    const handler = new SetEndpointRoleAccessHandler(projects, roles, endpoints, config, clock);
    await rejectsWith(
      handler.execute(new SetEndpointRoleAccessCommand("o1", "p1", "no-existe", [{ roleId: "r1", access: "allow" }], "u1")),
      "not-found",
      "endpoint-not-found",
    );
    const error = await rejectsWith(
      handler.execute(
        new SetEndpointRoleAccessCommand(
          "o1",
          "p1",
          "e1",
          [
            { roleId: "r1", access: "allow" },
            { roleId: "r1", access: "deny" },
            { roleId: "fantasma", access: "deny" },
          ],
          "u1",
        ),
      ),
      "invalid",
    );
    assert.deepEqual(error.fields.map((field) => field.field), ["permissions.1.roleId", "permissions.2.roleId"]);
  });

  test("desde un endpoint, sin alcance: «all», y el alcance que se diga si se dice", async () => {
    const handler = new SetEndpointRoleAccessHandler(projects, roles, endpoints, config, clock);
    const result = await handler.execute(
      new SetEndpointRoleAccessCommand(
        "o1",
        "p1",
        "e2",
        [
          { roleId: "r1", access: "allow" },
          { roleId: "r2", access: "allow", dataScope: "own" },
        ],
        "u1",
      ),
    );
    assert.deepEqual(result, { updated: 2 });
    const cells = [...roles.permissions.values()].sort((a, b) => a.roleId.localeCompare(b.roleId));
    assert.deepEqual(cells.map((cell) => cell.dataScope), ["all", "own"]);
  });

  test("reglas entre roles: origen y destino ajenos, un rol sobre sí mismo y un par repetido", async () => {
    const handler = new ReplaceRoleRulesHandler(projects, roles);
    const rule = (sourceRoleId: string, targetRoleId: string) => ({
      sourceRoleId,
      targetRoleId,
      canRead: true,
      canWrite: false,
      canDelete: false,
    });
    const error = await rejectsWith(
      handler.execute(new ReplaceRoleRulesCommand("o1", "p1", [rule("x", "y"), rule("r1", "r1"), rule("r1", "r2"), rule("r1", "r2")])),
      "invalid",
    );
    assert.deepEqual(error.fields.map((field) => field.field), [
      "rules.0.sourceRoleId",
      "rules.0.targetRoleId",
      "rules.1.targetRoleId",
      "rules.3",
    ]);
    assert.equal(roles.rules.size, 0);
  });
});

describe("credenciales de un entorno", () => {
  test("un secreto vacío es un 422 aunque la API ya lo pare antes, y no se guarda nada", async () => {
    const environments = new InMemoryEnvironmentRepository();
    await environments.save({
      id: "env1",
      projectId: "p1",
      name: "local",
      baseUrl: "http://api.test",
      specUrl: null,
      variables: {},
      disabledVariables: {},
      writesAllowed: false,
      authEnforced: false,
      createdAt: NOW,
      archivedAt: null,
      deletedAt: null,
    });
    const handler = new UpsertCredentialHandler(projects, environments, new AesGcmSecretCipher(Buffer.alloc(32, 3).toString("base64")), clock);
    const error = await rejectsWith(
      handler.execute(new UpsertCredentialCommand("o1", "p1", "env1", { name: "x", role: "primary", kind: "bearer", secret: "" })),
      "invalid",
    );
    assert.deepEqual(error.fields, [{ field: "secret", detail: "Requerido" }]);
    assert.deepEqual(await environments.listCredentials("env1"), []);
  });
});
