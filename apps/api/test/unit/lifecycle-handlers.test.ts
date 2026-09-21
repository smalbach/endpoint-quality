/**
 * Los bordes de archivar, restaurar y borrar del todo, recurso a recurso.
 *
 * Aquí están los casos que una prueba por HTTP no puede montar sin trampas: un tope lleno, un id
 * que se fue entre dos llamadas, restaurar lo que nunca se borró. Lo que sí se prueba por HTTP es
 * el guion feliz y los códigos de estado, en `test/http/lifecycle.test.ts`.
 */
import "reflect-metadata";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { FixedClock } from "@/shared/clock/clock.port";
import { ConflictError, NotFoundError } from "@/shared/errors/domain-error";
import type { Project } from "@/modules/projects/domain/model";
import {
  InMemoryProjectRepository,
  InMemoryWorkflowRepository,
  InMemoryEnvironmentRepository,
} from "../support/in-memory-repositories";
import { InMemoryMockRepository } from "../support/in-memory-mocks";
import { InMemoryDocSiteRepository } from "../support/in-memory-doc-sites";
import { InMemoryMonitorRepository } from "../support/in-memory-monitors";
import { InMemoryChannelRepository } from "../support/in-memory-channels";
import {
  CreateMockCommand,
  CreateMockHandler,
  RestoreMockCommand,
  RestoreMockHandler,
  SetMockArchivedCommand,
  SetMockArchivedHandler,
} from "@/modules/mocks/application/commands/manage-mocks";
import { MAX_MOCKS_PER_PROJECT } from "@/modules/mocks/domain/model";
import {
  CreateDocSiteCommand,
  CreateDocSiteHandler,
  RestoreDocSiteCommand,
  RestoreDocSiteHandler,
  SetDocSiteArchivedCommand,
  SetDocSiteArchivedHandler,
} from "@/modules/docs/application/commands/manage-doc-sites";
import { MAX_DOC_SITES_PER_PROJECT } from "@/modules/docs/domain/model";
import {
  CreateMonitorCommand,
  CreateMonitorHandler,
  DeleteMonitorCommand,
  DeleteMonitorHandler,
  RestoreMonitorCommand,
  RestoreMonitorHandler,
  SetMonitorArchivedCommand,
  SetMonitorArchivedHandler,
} from "@/modules/monitors/application/commands/manage-monitors";
import { MAX_MONITORS_PER_PROJECT } from "@/modules/monitors/domain/model";
import {
  CreateChannelCommand,
  CreateChannelHandler,
  RestoreChannelCommand,
  RestoreChannelHandler,
} from "@/modules/channels/application/commands/manage-channels";
import { MAX_CHANNELS_PER_PROJECT, type Channel } from "@/modules/channels/domain/model";
import {
  CreateDatasetCommand,
  CreateDatasetHandler,
  RestoreDatasetCommand,
  RestoreDatasetHandler,
  SetDatasetArchivedCommand,
  SetDatasetArchivedHandler,
} from "@/modules/workflows/application/commands/manage-dataset";
import {
  CreateSuiteCommand,
  CreateSuiteHandler,
  RestoreSuiteCommand,
  RestoreSuiteHandler,
  SetSuiteArchivedCommand,
  SetSuiteArchivedHandler,
} from "@/modules/workflows/application/commands/manage-suite";
import {
  CreateWorkflowCommand,
  CreateWorkflowHandler,
  DeleteWorkflowCommand,
  DeleteWorkflowHandler,
  RestoreWorkflowCommand,
  RestoreWorkflowHandler,
} from "@/modules/workflows/application/commands/manage-workflow";
import {
  DeleteEnvironmentCommand,
  DeleteEnvironmentHandler,
  environmentStore,
  promoteActive,
  RestoreEnvironmentCommand,
  RestoreEnvironmentHandler,
  SetEnvironmentArchivedCommand,
  SetEnvironmentArchivedHandler,
} from "@/modules/environments/application/commands/manage-environment";
import type { Environment } from "@/modules/environments/domain/model";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";
const clock = new FixedClock(new Date("2026-03-01T10:00:00.000Z"));

/** El proyecto de siempre: ni archivado ni borrado, que es lo que pide `writableProject`. */
async function projects(): Promise<InMemoryProjectRepository> {
  const repository = new InMemoryProjectRepository();
  await repository.save({
    id: PROJECT,
    organizationId: ORG,
    name: "p",
    slug: "p",
    archivedAt: null,
    deletedAt: null,
    activeEnvironmentId: null,
  } as unknown as Project);
  return repository;
}

const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof ConflictError || error instanceof NotFoundError, String(error));
  assert.equal((error as { code?: string }).code, expected);
  return true;
};

describe("un mock", () => {
  const world = async () => {
    const store = new InMemoryMockRepository();
    const owner = await projects();
    const create = (name: string) =>
      new CreateMockHandler(owner, store, clock).execute(
        new CreateMockCommand(ORG, PROJECT, name, "public", undefined, ACTOR),
      );
    return {
      store,
      create,
      archive: new SetMockArchivedHandler(owner, store, clock),
      restore: new RestoreMockHandler(owner, store, clock),
    };
  };

  test("archivar y restaurar lo que no existe es un 404", async () => {
    const { archive, restore } = await world();
    await assert.rejects(archive.execute(new SetMockArchivedCommand(ORG, PROJECT, "no", true)), code("mock-not-found"));
    await assert.rejects(restore.execute(new RestoreMockCommand(ORG, PROJECT, "no")), code("mock-not-found"));
  });

  test("restaurar choca con el nombre reutilizado, y con el tope del proyecto", async () => {
    const { store, create, restore } = await world();
    const first = await create("el del front");
    const row = store.rows.get(first.mock.id)!;
    await store.save({ ...row, deletedAt: clock.now() });

    await create("el del front");
    await assert.rejects(
      restore.execute(new RestoreMockCommand(ORG, PROJECT, first.mock.id)),
      code("mock-duplicate-name"),
    );

    // Con el nombre libre pero el proyecto lleno, el tope manda: no se cuela por la puerta de atrás.
    const clash = [...store.rows.values()].find((mock) => mock.name === "el del front" && !mock.deletedAt)!;
    await store.save({ ...clash, name: "otro" });
    for (let index = 1; index < MAX_MOCKS_PER_PROJECT; index += 1) await create(`m${index}`);
    await assert.rejects(restore.execute(new RestoreMockCommand(ORG, PROJECT, first.mock.id)), code("mocks-full"));
  });
});

describe("una documentación publicada", () => {
  const world = async () => {
    const store = new InMemoryDocSiteRepository();
    const owner = await projects();
    const create = (name: string) =>
      new CreateDocSiteHandler(owner, store, clock).execute(
        new CreateDocSiteCommand(ORG, PROJECT, name, "public", {}, ACTOR),
      );
    return {
      store,
      create,
      archive: new SetDocSiteArchivedHandler(owner, store, clock),
      restore: new RestoreDocSiteHandler(owner, store, clock),
    };
  };

  test("archivar y restaurar lo que no existe es un 404", async () => {
    const { archive, restore } = await world();
    await assert.rejects(
      archive.execute(new SetDocSiteArchivedCommand(ORG, PROJECT, "no", true)),
      code("doc-site-not-found"),
    );
    await assert.rejects(restore.execute(new RestoreDocSiteCommand(ORG, PROJECT, "no")), code("doc-site-not-found"));
  });

  test("restaurar respeta el nombre y el tope de páginas publicadas", async () => {
    const { store, create, restore } = await world();
    const first = await create("la pública");
    const row = store.rows.get(first.site.id)!;
    await store.save({ ...row, deletedAt: clock.now() });

    await create("la pública");
    await assert.rejects(
      restore.execute(new RestoreDocSiteCommand(ORG, PROJECT, first.site.id)),
      code("doc-site-duplicate-name"),
    );

    const clash = [...store.rows.values()].find((site) => site.name === "la pública" && !site.deletedAt)!;
    await store.save({ ...clash, name: "otra" });
    for (let index = 1; index < MAX_DOC_SITES_PER_PROJECT; index += 1) await create(`d${index}`);
    await assert.rejects(
      restore.execute(new RestoreDocSiteCommand(ORG, PROJECT, first.site.id)),
      code("doc-sites-full"),
    );
  });
});

describe("un monitor", () => {
  const HOURLY = { kind: "interval", minutes: 60 } as const;
  const world = async () => {
    const store = new InMemoryMonitorRepository();
    const owner = await projects();
    const create = (name: string) =>
      new CreateMonitorHandler(owner, store, clock, null).execute(
        new CreateMonitorCommand(
          ORG,
          PROJECT,
          { name, schedule: HOURLY as never, plan: { environmentId: "env-1" } as never },
          ACTOR,
        ),
      );
    return {
      store,
      create,
      remove: new DeleteMonitorHandler(owner, store, clock),
      archive: new SetMonitorArchivedHandler(owner, store, clock),
      restore: new RestoreMonitorHandler(owner, store, clock),
    };
  };

  test("lo que no existe es un 404 en las tres puertas", async () => {
    const { remove, archive, restore } = await world();
    await assert.rejects(remove.execute(new DeleteMonitorCommand(ORG, PROJECT, "no")), code("monitor-not-found"));
    await assert.rejects(
      archive.execute(new SetMonitorArchivedCommand(ORG, PROJECT, "no", true)),
      code("monitor-not-found"),
    );
    await assert.rejects(restore.execute(new RestoreMonitorCommand(ORG, PROJECT, "no")), code("monitor-not-found"));
  });

  test("borrar dos veces no es un error; archivar lo borrado sí; restaurar lo vivo no hace nada", async () => {
    const { store, create, remove, archive, restore } = await world();
    const monitor = await create("vigía");
    await remove.execute(new DeleteMonitorCommand(ORG, PROJECT, monitor.id));
    await remove.execute(new DeleteMonitorCommand(ORG, PROJECT, monitor.id));
    assert.equal(store.rows.get(monitor.id)!.nextRunAt, null);

    await assert.rejects(
      archive.execute(new SetMonitorArchivedCommand(ORG, PROJECT, monitor.id, true)),
      code("monitor-deleted"),
    );

    await restore.execute(new RestoreMonitorCommand(ORG, PROJECT, monitor.id));
    const same = await restore.execute(new RestoreMonitorCommand(ORG, PROJECT, monitor.id));
    assert.equal(same.deletedAt, null);
  });

  test("restaurar respeta el nombre y el tope de monitores", async () => {
    const { store, create, remove, restore } = await world();
    const monitor = await create("vigía");
    await remove.execute(new DeleteMonitorCommand(ORG, PROJECT, monitor.id));
    await create("vigía");
    await assert.rejects(
      restore.execute(new RestoreMonitorCommand(ORG, PROJECT, monitor.id)),
      code("monitor-duplicate-name"),
    );

    const clash = [...store.rows.values()].find((row) => row.name === "vigía" && !row.deletedAt)!;
    await store.save({ ...clash, name: "otro" });
    for (let index = 1; index < MAX_MONITORS_PER_PROJECT; index += 1) await create(`m${index}`);
    await assert.rejects(restore.execute(new RestoreMonitorCommand(ORG, PROJECT, monitor.id)), code("monitors-full"));
  });
});

describe("un canal", () => {
  const world = async () => {
    const store = new InMemoryChannelRepository();
    const owner = await projects();
    const ceilings = { maxMessages: 500, maxBytes: 5_000_000, maxMessageBytes: 200_000, maxDurationMs: 60_000 };
    const create = (name: string) =>
      new CreateChannelHandler(owner, store, clock, ceilings as never).execute(
        new CreateChannelCommand(
          ORG,
          PROJECT,
          { protocol: "ws", name, url: "wss://eco.example.test/socket" } as never,
          ACTOR,
        ),
      );
    return { store, create, restore: new RestoreChannelHandler(owner, store, clock) };
  };

  test("restaurar lo que no existe es un 404; con el proyecto lleno, un 409", async () => {
    const { store, create, restore } = await world();
    await assert.rejects(
      restore.execute(new RestoreChannelCommand(ORG, PROJECT, "no", ACTOR)),
      code("channel-not-found"),
    );

    const channel = await create("eco");
    const row = store.rows.get(channel.id) as Channel;
    await store.save({ ...row, deletedAt: clock.now() });
    for (let index = 0; index < MAX_CHANNELS_PER_PROJECT; index += 1) await create(`c${index}`);
    await assert.rejects(
      restore.execute(new RestoreChannelCommand(ORG, PROJECT, channel.id, ACTOR)),
      code("channels-full"),
    );
  });
});

describe("un conjunto de datos y una suite", () => {
  const world = async () => {
    const store = new InMemoryWorkflowRepository();
    const owner = await projects();
    const workflow = await new CreateWorkflowHandler(owner, store, clock, null).execute(
      new CreateWorkflowCommand(ORG, PROJECT, { name: "alta" }, ACTOR),
    );
    return {
      store,
      workflowId: workflow.workflowId,
      createDataset: (name: string) =>
        new CreateDatasetHandler(owner, store, clock).execute(
          new CreateDatasetCommand(ORG, PROJECT, workflow.workflowId, { name, rows: [] }, ACTOR),
        ),
      createSuite: (name: string) =>
        new CreateSuiteHandler(owner, store, clock).execute(new CreateSuiteCommand(ORG, PROJECT, { name }, ACTOR)),
      archiveDataset: new SetDatasetArchivedHandler(owner, store, clock),
      restoreDataset: new RestoreDatasetHandler(owner, store, clock),
      archiveSuite: new SetSuiteArchivedHandler(owner, store, clock),
      restoreSuite: new RestoreSuiteHandler(owner, store, clock),
      deleteWorkflow: new DeleteWorkflowHandler(owner, store, clock),
      restoreWorkflow: new RestoreWorkflowHandler(owner, store, clock),
    };
  };

  test("archivar y restaurar lo que no existe es un 404, en los dos", async () => {
    const { archiveDataset, restoreDataset, archiveSuite, restoreSuite } = await world();
    await assert.rejects(
      archiveDataset.execute(new SetDatasetArchivedCommand(ORG, PROJECT, "no", true)),
      code("dataset-not-found"),
    );
    await assert.rejects(
      restoreDataset.execute(new RestoreDatasetCommand(ORG, PROJECT, "no")),
      code("dataset-not-found"),
    );
    await assert.rejects(
      archiveSuite.execute(new SetSuiteArchivedCommand(ORG, PROJECT, "no", true)),
      code("suite-not-found"),
    );
    await assert.rejects(restoreSuite.execute(new RestoreSuiteCommand(ORG, PROJECT, "no")), code("suite-not-found"));
  });

  test("restaurar choca con el nombre reutilizado, en el conjunto y en la suite", async () => {
    const world_ = await world();
    const dataset = await world_.createDataset("clientes");
    const stored = (await world_.store.findDataset(PROJECT, dataset.datasetId))!;
    await world_.store.saveDataset({ ...stored, deletedAt: clock.now() });
    await world_.createDataset("clientes");
    await assert.rejects(
      world_.restoreDataset.execute(new RestoreDatasetCommand(ORG, PROJECT, dataset.datasetId)),
      code("dataset-name-taken"),
    );

    const suite = await world_.createSuite("humo");
    const savedSuite = (await world_.store.findSuite(PROJECT, suite.suiteId))!;
    await world_.store.saveSuite({ ...savedSuite, deletedAt: clock.now() });
    await world_.createSuite("humo");
    await assert.rejects(
      world_.restoreSuite.execute(new RestoreSuiteCommand(ORG, PROJECT, suite.suiteId)),
      code("suite-name-taken"),
    );
  });

  test("borrar el flujo dos veces no es un error, y restaurarlo choca si el nombre se reutilizó", async () => {
    const world_ = await world();
    await world_.deleteWorkflow.execute(new DeleteWorkflowCommand(ORG, PROJECT, world_.workflowId));
    await world_.deleteWorkflow.execute(new DeleteWorkflowCommand(ORG, PROJECT, world_.workflowId));

    await new CreateWorkflowHandler(await projects(), world_.store, clock, null).execute(
      new CreateWorkflowCommand(ORG, PROJECT, { name: "alta" }, ACTOR),
    );
    await assert.rejects(
      world_.restoreWorkflow.execute(new RestoreWorkflowCommand(ORG, PROJECT, world_.workflowId)),
      code("workflow-name-taken"),
    );
  });
});

describe("un entorno", () => {
  const environment = (patch: Partial<Environment> = {}): Environment =>
    ({
      id: "env-1",
      projectId: PROJECT,
      name: "staging",
      baseUrl: "https://api.example.com",
      specUrl: null,
      variables: {},
      disabledVariables: {},
      writesAllowed: false,
      authEnforced: false,
      createdAt: clock.now(),
      archivedAt: null,
      deletedAt: null,
      ...patch,
    }) as Environment;

  test("un id de otro proyecto no se alcanza ni para archivar ni para borrar", async () => {
    const store = new InMemoryEnvironmentRepository();
    const owner = await projects();
    await store.save(environment({ projectId: "de-otro" }));
    await assert.rejects(
      new SetEnvironmentArchivedHandler(owner, store, clock).execute(
        new SetEnvironmentArchivedCommand(ORG, PROJECT, "env-1", true),
      ),
      code("environment-not-found"),
    );
    await assert.rejects(
      new DeleteEnvironmentHandler(owner, store, clock).execute(new DeleteEnvironmentCommand(ORG, PROJECT, "env-1")),
      code("environment-not-found"),
    );
  });

  test("restaurar el que no está borrado lo deja igual", async () => {
    const store = new InMemoryEnvironmentRepository();
    const owner = await projects();
    await store.save(environment({ archivedAt: clock.now() }));
    await new RestoreEnvironmentHandler(owner, store, clock).execute(
      new RestoreEnvironmentCommand(ORG, PROJECT, "env-1"),
    );
    assert.ok((await store.findAnyById("env-1"))!.archivedAt, "lo archivado sigue archivado");
  });

  test("el almacén del ciclo de vida no alcanza un id que no está, y sin proyecto no se promueve nada", async () => {
    const store = new InMemoryEnvironmentRepository();
    await store.save(environment());
    // El id que no existe es `null` y no una excepción: quien lo pidió ya contesta su 404.
    assert.equal(await environmentStore(store).findById(PROJECT, "no-existe"), null);

    // El proyecto desaparece entre la lectura del entorno y la promoción del activo: no hay a
    // quién pasarle el puesto, y esto no puede reventar por eso.
    const vanished = {
      findById: async () => null,
      save: async () => {
        throw new Error("no debería guardar nada");
      },
    } as never;
    await promoteActive(vanished, store, environment());
  });
});
