/**
 * Manejadores de endpoints y entornos a pelo, con los repositorios de memoria: la sincronización
 * del contrato con sus casos raros (proyecto que ya no apunta a esa versión, operaciones repetidas,
 * un fallo que se registra y no tumba nada), y los valores por defecto de entornos que la
 * validación HTTP no deja llegar.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Logger } from "@nestjs/common";

import { FixedClock } from "@/shared/clock/clock.port";
import { AesGcmSecretCipher } from "@/shared/crypto/secret-cipher";
import { DomainError } from "@/shared/errors/domain-error";
import type { Project } from "@/modules/projects/domain/model";
import type { SpecOperation } from "@/modules/specs/domain/model";
import { SpecVersionActivatedEvent } from "@/modules/specs/application/events/spec-version-activated.event";
import { blankEndpoint, type Endpoint } from "@/modules/endpoints/domain/model";
import {
  SyncContractEndpointsHandler,
  syncContractEndpoints,
} from "@/modules/endpoints/application/events/sync-contract-endpoints";
import { CreateEnvironmentCommand, CreateEnvironmentHandler } from "@/modules/environments/application/commands/manage-environment";
import {
  ImportPostmanEnvironmentCommand,
  ImportPostmanEnvironmentHandler,
} from "@/modules/environments/application/commands/import-postman-environment";
import { RevealVariablesHandler, RevealVariablesQuery } from "@/modules/environments/application/queries/reveal-variables";
import type { Environment } from "@/modules/environments/domain/model";

import {
  InMemoryEnvironmentRepository,
  InMemoryProjectRepository,
  InMemorySpecRepository,
} from "../support/in-memory-repositories";
import { InMemoryEndpointRepository } from "../support/in-memory-endpoints";

const NOW = new Date("2026-03-01T10:00:00.000Z");
const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 9).toString("base64"));

const project = (fields: Partial<Project> = {}): Project => ({
  id: "p1",
  organizationId: "o1",
  name: "Tienda",
  slug: "tienda",
  description: "",
  createdBy: "creador",
  createdAt: NOW,
  archivedAt: null,
  activeSpecVersionId: "v1",
  activeEnvironmentId: null,
  baseUrl: "http://api.test",
  tags: [],
  auth: { type: "none", settings: {}, secretCiphertext: null },
  deletedAt: null,
  ...fields,
});

const operation = (id: string, method: string, path: string, position: number): SpecOperation =>
  ({
    id,
    method,
    path,
    summary: "",
    tag: "",
    statuses: [200],
    parameters: [],
    security: [],
    derivedId: false,
    rowId: `row-${id}`,
    specVersionId: "v1",
    position,
  }) as unknown as SpecOperation;

function syncSetup(fields: Partial<Project> = {}) {
  const projects = new InMemoryProjectRepository();
  const specs = new InMemorySpecRepository();
  const endpoints = new InMemoryEndpointRepository();
  void projects.save(project(fields));
  const deps = { projects, specs, endpoints, clock: new FixedClock(NOW) };
  return { ...deps, deps };
}

describe("sincronizar los endpoints con el contrato activo", () => {
  test("una versión que ya no es la activa, o un proyecto que no existe, no cambia nada", async () => {
    const { deps, specs, endpoints } = syncSetup({ activeSpecVersionId: "v2" });
    specs.operations.set("v1", [operation("op1", "get", "/a", 0)]);
    assert.deepEqual(await syncContractEndpoints(deps, new SpecVersionActivatedEvent("p1", "v1", "u1")), {
      created: 0,
      linked: 0,
    });
    assert.deepEqual(await syncContractEndpoints(deps, new SpecVersionActivatedEvent("nadie", "v1", "u1")), {
      created: 0,
      linked: 0,
    });
    assert.equal(endpoints.rows.size, 0);
  });

  test("sin actor en el evento consta quien creó el proyecto; una operación repetida entra una vez", async () => {
    const { deps, specs, endpoints } = syncSetup();
    specs.operations.set("v1", [operation("op1", "get", "/a", 0), operation("op1-bis", "get", "/a", 1)]);
    const result = await syncContractEndpoints(deps, new SpecVersionActivatedEvent("p1", "v1", ""));
    assert.deepEqual(result, { created: 1, linked: 0 });
    const [row] = [...endpoints.rows.values()];
    assert.equal(row.updatedBy, "creador");
    assert.equal(row.operationId, "op1");
    assert.equal(row.origin, "contract");
  });

  test("un endpoint ya enlazado a esa operación se deja tal cual; uno de otra, se re-enlaza", async () => {
    const { deps, specs, endpoints } = syncSetup();
    const existing = (id: string, path: string, operationId: string | null): Endpoint => ({
      ...blankEndpoint({ id, projectId: "p1", origin: "manual", orderIndex: 0, now: NOW, actorId: "u1" }),
      method: "GET",
      path,
      operationId,
    });
    await endpoints.saveMany([existing("e1", "/a", "op1"), existing("e2", "/b", "viejo")]);
    specs.operations.set("v1", [operation("op1", "get", "/a", 0), operation("op2", "get", "/b", 1)]);
    const result = await syncContractEndpoints(deps, new SpecVersionActivatedEvent("p1", "v1", "u1"));
    assert.deepEqual(result, { created: 0, linked: 1 });
    assert.equal(endpoints.rows.get("e2")?.operationId, "op2");
    assert.equal(endpoints.rows.get("e1")?.operationId, "op1");
  });

  test("el manejador registra el fallo con el proyecto y no lo relanza", async (t) => {
    const { projects, specs, endpoints, clock } = syncSetup();
    specs.listOperations = async () => {
      throw new Error("se cayó la base");
    };
    const logged = t.mock.method(Logger.prototype, "error", () => undefined);
    const handler = new SyncContractEndpointsHandler(projects, specs, endpoints, clock);
    await handler.handle(new SpecVersionActivatedEvent("p1", "v1", "u1"));
    assert.equal(logged.mock.callCount(), 1);
    const [message, error] = logged.mock.calls[0].arguments as [string, Error];
    assert.equal(message, "No se pudieron sincronizar los endpoints del proyecto p1");
    assert.equal(error.message, "se cayó la base");
  });
});

async function rejectsWith(promise: Promise<unknown>, kind: string): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DomainError);
    assert.equal(error.kind, kind);
    return error;
  }
  assert.fail("se esperaba un error");
}

function envSetup() {
  const projects = new InMemoryProjectRepository();
  const environments = new InMemoryEnvironmentRepository();
  void projects.save(project());
  return { projects, environments, clock: new FixedClock(NOW) };
}

describe("entornos: valores por defecto", () => {
  test("crear sin nombre es un 422 sobre `name`; sin URL base, un 422 sobre `baseUrl`", async () => {
    const { projects, environments, clock } = envSetup();
    const handler = new CreateEnvironmentHandler(projects, environments, clock, cipher);
    const noName = await rejectsWith(handler.execute(new CreateEnvironmentCommand("o1", "p1", {})), "invalid");
    assert.deepEqual(noName.fields.map((field) => field.field), ["name"]);

    const noBase = await rejectsWith(handler.execute(new CreateEnvironmentCommand("o1", "p1", { name: "  local " })), "invalid");
    assert.deepEqual(noBase.fields, [{ field: "baseUrl", detail: "Debe ser una URL absoluta" }]);
    assert.equal(await environments.findByName("p1", "local"), null);

    const { environmentId } = await handler.execute(
      new CreateEnvironmentCommand("o1", "p1", { name: "  local ", baseUrl: "http://h.test/" }),
    );
    const stored = await environments.findById(environmentId);
    assert.equal(stored?.name, "local");
    assert.equal(stored?.baseUrl, "http://h.test");
  });

  test("importar de Postman sin nombre en ningún sitio lo llama «Entorno importado»", async () => {
    const { projects, environments, clock } = envSetup();
    const handler = new ImportPostmanEnvironmentHandler(projects, environments, clock, cipher);
    const text = JSON.stringify({ name: "  ", values: [{ key: "host", value: "http://h" }] });
    await handler.execute(new ImportPostmanEnvironmentCommand("o1", "p1", { text, name: "   " }));
    assert.ok(await environments.findByName("p1", "Entorno importado"));
  });

  test("revelar: el valor actual gana, si no el inicial, y sin ninguno queda vacío; lo no sensible no sale", async () => {
    const { projects, environments } = envSetup();
    const environment: Environment = {
      id: "env1",
      projectId: "p1",
      name: "local",
      baseUrl: "",
      specUrl: null,
      variables: {
        actual: { initial: cipher.encrypt("ini"), current: cipher.encrypt("cur"), sensitive: true },
        inicial: { initial: cipher.encrypt("solo-ini"), current: "", sensitive: true },
        visible: { initial: "abierto", current: "", sensitive: false },
      },
      disabledVariables: { vacia: { initial: "", current: "", sensitive: true } },
      writesAllowed: false,
      authEnforced: false,
      createdAt: NOW,
    };
    await environments.save(environment);
    const handler = new RevealVariablesHandler(projects, environments, cipher);
    assert.deepEqual(await handler.execute(new RevealVariablesQuery("o1", "p1", "env1")), {
      actual: "cur",
      inicial: "solo-ini",
      vacia: "",
    });
  });
});
