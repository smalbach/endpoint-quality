/**
 * Los comandos y consultas de flujos, peticiones guardadas, datos y suites, ejecutados sobre los
 * repositorios en memoria: cada rechazo (404 de tenant, 409 de nombre o de uso, 422 de forma) y lo
 * que queda guardado cuando no se rechaza.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { WorkflowDocument } from "@eq/runner-core";
import { FixedClock } from "@/shared/clock/clock.port";
import type { DomainError } from "@/shared/errors/domain-error";
import type { Project } from "@/modules/projects/domain/model";
import type { SpecOperation } from "@/modules/specs/domain/model";
import {
  CreateRequestTemplateCommand,
  CreateRequestTemplateHandler,
  DeleteRequestTemplateCommand,
  DeleteRequestTemplateHandler,
  UpdateRequestTemplateCommand,
  UpdateRequestTemplateHandler,
} from "@/modules/workflows/application/commands/manage-request-template";
import {
  CreateDatasetCommand,
  CreateDatasetHandler,
  DeleteDatasetCommand,
  DeleteDatasetHandler,
  UpdateDatasetCommand,
  UpdateDatasetHandler,
  RestoreDatasetCommand,
  RestoreDatasetHandler,
} from "@/modules/workflows/application/commands/manage-dataset";
import {
  CreateSuiteCommand,
  CreateSuiteHandler,
  DeleteSuiteCommand,
  DeleteSuiteHandler,
  UpdateSuiteCommand,
  UpdateSuiteHandler,
  RestoreSuiteCommand,
  RestoreSuiteHandler,
} from "@/modules/workflows/application/commands/manage-suite";
import {
  CreateWorkflowCommand,
  CreateWorkflowHandler,
  DeleteWorkflowCommand,
  DeleteWorkflowHandler,
  DuplicateWorkflowCommand,
  DuplicateWorkflowHandler,
  UpdateWorkflowCommand,
  UpdateWorkflowHandler,
  RestoreWorkflowCommand,
  RestoreWorkflowHandler,
} from "@/modules/workflows/application/commands/manage-workflow";
import {
  ImportRequestTemplatesCommand,
  ImportRequestTemplatesHandler,
  uniqueName,
} from "@/modules/workflows/application/commands/import-request-templates";
import {
  ImportPostmanFlowsCommand,
  ImportPostmanFlowsHandler,
} from "@/modules/workflows/application/commands/import-postman-flows";
import { GetDatasetHandler, GetDatasetQuery } from "@/modules/workflows/application/queries/get-dataset";
import { templateView } from "@/modules/workflows/application/queries/list-workflows";
import { scenarioFor, type RequestTemplateRow, type WorkflowRow } from "@/modules/workflows/domain/model";
import {
  InMemoryProjectRepository,
  InMemorySpecRepository,
  InMemoryWorkflowRepository,
} from "../support/in-memory-repositories";

const ORG = "org-1";
const PROJECT = "proj-1";
const ACTOR = "user-1";
const T0 = new Date("2026-01-01T00:00:00.000Z");

function world(options: { spec?: Partial<SpecOperation>[] } = {}) {
  const projects = new InMemoryProjectRepository();
  const workflows = new InMemoryWorkflowRepository();
  const specs = new InMemorySpecRepository();
  const clock = new FixedClock(T0);
  const project = {
    id: PROJECT,
    organizationId: ORG,
    name: "P",
    slug: "p",
    description: "",
    createdBy: ACTOR,
    createdAt: T0,
    archivedAt: null,
    activeSpecVersionId: options.spec ? "spec-1" : null,
    activeEnvironmentId: null,
    baseUrl: "",
    tags: [],
    auth: {},
    deletedAt: null,
  } as unknown as Project;
  void projects.save(project);
  if (options.spec) {
    specs.operations.set(
      "spec-1",
      options.spec.map((operation, position) => ({
        rowId: `row-${position}`,
        specVersionId: "spec-1",
        position,
        summary: "",
        tag: "",
        parameters: [],
        statuses: [200],
        ...operation,
      })) as SpecOperation[],
    );
  }
  return { projects, workflows, specs, clock };
}

const rejectsWith = (promise: Promise<unknown>, kind: string, code?: string) =>
  assert.rejects(promise, (error: DomainError) => {
    assert.equal(error.kind, kind, error.message);
    if (code) assert.equal(error.code, code);
    return true;
  });

const templateRow = (overrides: Partial<RequestTemplateRow> = {}): RequestTemplateRow => ({
  id: "tpl-1",
  projectId: PROJECT,
  name: "Crear",
  operationId: "createThing",
  description: "desc",
  expectedStatus: 201,
  parameters: { id: "1" },
  disabledParameters: { off: "x" },
  headers: { "X-A": "1" },
  disabledHeaders: { "X-B": "2" },
  body: { type: "json", json: { a: 1 } },
  auth: "none",
  createdAt: T0,
  updatedAt: T0,
  updatedBy: "someone",
  ...overrides,
});

const workflowRow = (overrides: Partial<WorkflowRow> = {}): WorkflowRow => ({
  id: "wf-1",
  projectId: PROJECT,
  name: "Flujo",
  description: "d",
  status: "ready",
  definition: { steps: [] },
  createdAt: T0,
  updatedAt: T0,
  updatedBy: "someone",
  deletedAt: null,
  ...overrides,
});

describe("request templates", () => {
  test("create: another organization's project is a 404", async () => {
    const { projects, workflows, clock } = world();
    await rejectsWith(
      new CreateRequestTemplateHandler(projects, workflows, clock).execute(
        new CreateRequestTemplateCommand("other-org", PROJECT, { name: "x" }, ACTOR),
      ),
      "not-found",
      "project-not-found",
    );
  });

  test("create: the same name enabled and disabled is refused, parameters and headers alike", async () => {
    const { projects, workflows, clock } = world();
    const handler = new CreateRequestTemplateHandler(projects, workflows, clock);
    await assert.rejects(
      handler.execute(
        new CreateRequestTemplateCommand(
          ORG,
          PROJECT,
          { name: "x", operationId: "o", expectedStatus: 200, parameters: { id: "1" }, disabledParameters: { id: "2" } },
          ACTOR,
        ),
      ),
      (error: DomainError) => {
        assert.equal(error.code, "request-template-invalid");
        assert.deepEqual(error.fields, [{ field: "parameters", detail: "id" }]);
        return true;
      },
    );
    await assert.rejects(
      handler.execute(
        new CreateRequestTemplateCommand(
          ORG,
          PROJECT,
          { name: "x", operationId: "o", expectedStatus: 200, headers: { A: "1", B: "2" }, disabledHeaders: { B: "", A: "" } },
          ACTOR,
        ),
      ),
      (error: DomainError) => {
        assert.match(error.message, /cabecera encendido y apagado a la vez: A, B/);
        assert.deepEqual(
          error.fields.map((field) => field.field),
          ["headers", "headers"],
        );
        return true;
      },
    );
  });

  test("create: a shape the engine refuses is a 422, defaults are filled, a blank description is null", async () => {
    const { projects, workflows, clock } = world();
    const handler = new CreateRequestTemplateHandler(projects, workflows, clock);
    await rejectsWith(
      handler.execute(new CreateRequestTemplateCommand(ORG, PROJECT, {}, ACTOR)),
      "invalid",
      "request-template-invalid",
    );
    const { requestTemplateId } = await handler.execute(
      new CreateRequestTemplateCommand(
        ORG,
        PROJECT,
        { name: "  Listar  ", operationId: "listThings", expectedStatus: 200, description: "" },
        ACTOR,
      ),
    );
    const saved = await workflows.findTemplate(PROJECT, requestTemplateId);
    assert.ok(saved);
    assert.equal(saved.name, "Listar");
    assert.equal(saved.description, null);
    assert.deepEqual(saved.body, { type: "none" });
    assert.equal(saved.auth, "default");
    assert.deepEqual(saved.parameters, {});
    assert.equal(saved.updatedBy, ACTOR);
    await rejectsWith(
      handler.execute(
        new CreateRequestTemplateCommand(ORG, PROJECT, { name: "Listar", operationId: "x", expectedStatus: 200 }, ACTOR),
      ),
      "conflict",
      "request-template-name-taken",
    );
  });

  test("update: unknown id is a 404; an empty patch keeps every field; description is set or cleared", async () => {
    const { projects, workflows, clock } = world();
    const handler = new UpdateRequestTemplateHandler(projects, workflows, clock);
    await rejectsWith(
      handler.execute(new UpdateRequestTemplateCommand(ORG, PROJECT, "nope", {}, ACTOR)),
      "not-found",
      "request-template-not-found",
    );
    await workflows.saveTemplate(templateRow());
    clock.advance(60_000);
    await handler.execute(new UpdateRequestTemplateCommand(ORG, PROJECT, "tpl-1", {}, ACTOR));
    const kept = await workflows.findTemplate(PROJECT, "tpl-1");
    assert.deepEqual({ ...kept, updatedAt: undefined, updatedBy: undefined }, {
      ...templateRow(),
      updatedAt: undefined,
      updatedBy: undefined,
    });
    assert.equal(kept?.updatedAt.getTime(), T0.getTime() + 60_000);
    assert.equal(kept?.updatedBy, ACTOR);
    assert.equal(kept?.createdAt.getTime(), T0.getTime());

    await handler.execute(new UpdateRequestTemplateCommand(ORG, PROJECT, "tpl-1", { description: "" }, ACTOR));
    assert.equal((await workflows.findTemplate(PROJECT, "tpl-1"))?.description, null);
    await handler.execute(new UpdateRequestTemplateCommand(ORG, PROJECT, "tpl-1", { description: "nueva" }, ACTOR));
    assert.equal((await workflows.findTemplate(PROJECT, "tpl-1"))?.description, "nueva");
  });

  test("update: renaming onto another template is a 409, onto itself is fine", async () => {
    const { projects, workflows, clock } = world();
    await workflows.saveTemplate(templateRow());
    await workflows.saveTemplate(templateRow({ id: "tpl-2", name: "Otra" }));
    const handler = new UpdateRequestTemplateHandler(projects, workflows, clock);
    await rejectsWith(
      handler.execute(new UpdateRequestTemplateCommand(ORG, PROJECT, "tpl-2", { name: "Crear" }, ACTOR)),
      "conflict",
      "request-template-name-taken",
    );
    await handler.execute(new UpdateRequestTemplateCommand(ORG, PROJECT, "tpl-2", { name: "Otra" }, ACTOR));
    assert.equal((await workflows.findTemplate(PROJECT, "tpl-2"))?.name, "Otra");
  });

  test("delete: a template a flow uses is a 409 and stays; unused goes; unknown is a 404", async () => {
    const { projects, workflows } = world();
    const handler = new DeleteRequestTemplateHandler(projects, workflows);
    await workflows.saveTemplate(templateRow());
    await workflows.saveWorkflow(workflowRow({ definition: { steps: [{ id: "s", requestTemplateId: "tpl-1" }] } }));
    await rejectsWith(
      handler.execute(new DeleteRequestTemplateCommand(ORG, PROJECT, "tpl-1")),
      "conflict",
      "request-template-in-use",
    );
    assert.ok(await workflows.findTemplate(PROJECT, "tpl-1"));
    await workflows.deleteWorkflow(PROJECT, "wf-1");
    await handler.execute(new DeleteRequestTemplateCommand(ORG, PROJECT, "tpl-1"));
    assert.equal(await workflows.findTemplate(PROJECT, "tpl-1"), null);
    await rejectsWith(handler.execute(new DeleteRequestTemplateCommand(ORG, PROJECT, "tpl-1")), "not-found");
  });
});

describe("datasets", () => {
  test("create: unknown flow 404, blank name 422, bad rows 422, taken name 409, no rows is empty", async () => {
    const { projects, workflows, clock } = world();
    const handler = new CreateDatasetHandler(projects, workflows, clock);
    await rejectsWith(
      handler.execute(new CreateDatasetCommand(ORG, PROJECT, "wf-1", { name: "d" }, ACTOR)),
      "not-found",
      "workflow-not-found",
    );
    await workflows.saveWorkflow(workflowRow());
    await assert.rejects(
      handler.execute(new CreateDatasetCommand(ORG, PROJECT, "wf-1", { name: "   " }, ACTOR)),
      (error: DomainError) => error.kind === "invalid" && error.fields[0]?.field === "name",
    );
    await rejectsWith(
      handler.execute(new CreateDatasetCommand(ORG, PROJECT, "wf-1", { name: "d", rows: [{ "a b": "1" }] }, ACTOR)),
      "invalid",
      "dataset-invalid",
    );
    const { datasetId } = await handler.execute(new CreateDatasetCommand(ORG, PROJECT, "wf-1", { name: " d " }, ACTOR));
    const saved = await workflows.findDataset(PROJECT, datasetId);
    assert.equal(saved?.name, "d");
    assert.deepEqual(saved?.rows, []);
    await rejectsWith(
      handler.execute(new CreateDatasetCommand(ORG, PROJECT, "wf-1", { name: "d" }, ACTOR)),
      "conflict",
      "dataset-name-taken",
    );
  });

  test("update: unknown 404, rename clash 409, same name ok, omitted fields kept, rows replaced", async () => {
    const { projects, workflows, clock } = world();
    await workflows.saveWorkflow(workflowRow());
    const create = new CreateDatasetHandler(projects, workflows, clock);
    const first = await create.execute(
      new CreateDatasetCommand(ORG, PROJECT, "wf-1", { name: "uno", rows: [{ a: "1" }] }, ACTOR),
    );
    await create.execute(new CreateDatasetCommand(ORG, PROJECT, "wf-1", { name: "dos" }, ACTOR));
    const handler = new UpdateDatasetHandler(projects, workflows, clock);

    await rejectsWith(
      handler.execute(new UpdateDatasetCommand(ORG, PROJECT, "nope", {}, ACTOR)),
      "not-found",
      "dataset-not-found",
    );
    await rejectsWith(
      handler.execute(new UpdateDatasetCommand(ORG, PROJECT, first.datasetId, { name: "dos" }, ACTOR)),
      "conflict",
      "dataset-name-taken",
    );
    // Another organization cannot reach it either, even with the right id.
    await rejectsWith(
      handler.execute(new UpdateDatasetCommand("other", PROJECT, first.datasetId, {}, ACTOR)),
      "not-found",
    );

    await handler.execute(new UpdateDatasetCommand(ORG, PROJECT, first.datasetId, { name: "uno" }, ACTOR));
    await handler.execute(new UpdateDatasetCommand(ORG, PROJECT, first.datasetId, { name: "  " }, "editor-2"));
    let saved = await workflows.findDataset(PROJECT, first.datasetId);
    assert.equal(saved?.name, "uno");
    assert.deepEqual(saved?.rows, [{ a: "1" }]);
    assert.equal(saved?.updatedBy, "editor-2");

    await handler.execute(
      new UpdateDatasetCommand(ORG, PROJECT, first.datasetId, { name: "tres", rows: [{ b: "2" }, { b: "3" }] }, ACTOR),
    );
    saved = await workflows.findDataset(PROJECT, first.datasetId);
    assert.equal(saved?.name, "tres");
    assert.deepEqual(saved?.rows, [{ b: "2" }, { b: "3" }]);
    await rejectsWith(
      handler.execute(new UpdateDatasetCommand(ORG, PROJECT, first.datasetId, { rows: "no" }, ACTOR)),
      "invalid",
      "dataset-invalid",
    );
  });

  test("delete and get: unknown is a 404, uno de otra organización es un 404, y borrar lo saca de la lista", async () => {
    const { projects, workflows, clock } = world();
    await workflows.saveWorkflow(workflowRow());
    const { datasetId } = await new CreateDatasetHandler(projects, workflows, clock).execute(
      new CreateDatasetCommand(ORG, PROJECT, "wf-1", { name: "d", rows: [{ a: "1" }] }, ACTOR),
    );
    const get = new GetDatasetHandler(projects, workflows);
    assert.deepEqual(await get.execute(new GetDatasetQuery(ORG, PROJECT, datasetId)), {
      id: datasetId,
      name: "d",
      rows: [{ a: "1" }],
    });
    const handler = new DeleteDatasetHandler(projects, workflows, clock);
    await rejectsWith(handler.execute(new DeleteDatasetCommand(ORG, PROJECT, "nope")), "not-found", "dataset-not-found");
    await rejectsWith(handler.execute(new DeleteDatasetCommand("other", PROJECT, datasetId)), "not-found");
    await handler.execute(new DeleteDatasetCommand(ORG, PROJECT, datasetId));
    // Borrado blando: fuera de la lista activa, dentro de la papelera, y sus filas se siguen
    // pudiendo leer —es lo que dice si merece la pena restaurarlo.
    assert.deepEqual(await workflows.listDatasets(PROJECT), []);
    assert.equal((await workflows.listDatasets(PROJECT, "deleted")).length, 1);
    assert.deepEqual((await get.execute(new GetDatasetQuery(ORG, PROJECT, datasetId))).rows, [{ a: "1" }]);

    // Restaurarlo lo devuelve a la lista; el definitivo se lo lleva de verdad.
    await new RestoreDatasetHandler(projects, workflows, clock).execute(
      new RestoreDatasetCommand(ORG, PROJECT, datasetId),
    );
    assert.equal((await workflows.listDatasets(PROJECT)).length, 1);
    await rejectsWith(
      handler.execute(new DeleteDatasetCommand(ORG, PROJECT, datasetId, true)),
      "conflict",
      "dataset-not-deleted",
    );
    await handler.execute(new DeleteDatasetCommand(ORG, PROJECT, datasetId));
    await handler.execute(new DeleteDatasetCommand(ORG, PROJECT, datasetId, true));
    assert.equal(await workflows.findDataset(PROJECT, datasetId), null);
  });
});

describe("suites", () => {
  test("create: blank name 422, defaults, taken name 409", async () => {
    const { projects, workflows, clock } = world();
    const handler = new CreateSuiteHandler(projects, workflows, clock);
    await rejectsWith(handler.execute(new CreateSuiteCommand(ORG, PROJECT, {}, ACTOR)), "invalid");
    const { suiteId } = await handler.execute(new CreateSuiteCommand(ORG, PROJECT, { name: "s" }, ACTOR));
    const saved = await workflows.findSuite(PROJECT, suiteId);
    assert.equal(saved?.description, null);
    assert.deepEqual(saved?.workflowIds, []);
    await rejectsWith(
      handler.execute(new CreateSuiteCommand(ORG, PROJECT, { name: "s" }, ACTOR)),
      "conflict",
      "suite-name-taken",
    );
  });

  test("update: unknown 404, clash 409, omitted fields kept, flows revalidated", async () => {
    const { projects, workflows, clock } = world();
    await workflows.saveWorkflow(workflowRow());
    await workflows.saveWorkflow(workflowRow({ id: "wf-2", name: "Otro" }));
    const create = new CreateSuiteHandler(projects, workflows, clock);
    const { suiteId } = await create.execute(
      new CreateSuiteCommand(ORG, PROJECT, { name: "a", description: "d", workflowIds: ["wf-1"] }, ACTOR),
    );
    await create.execute(new CreateSuiteCommand(ORG, PROJECT, { name: "b" }, ACTOR));
    const handler = new UpdateSuiteHandler(projects, workflows, clock);

    await rejectsWith(handler.execute(new UpdateSuiteCommand(ORG, PROJECT, "nope", {}, ACTOR)), "not-found", "suite-not-found");
    await rejectsWith(
      handler.execute(new UpdateSuiteCommand(ORG, PROJECT, suiteId, { name: "b" }, ACTOR)),
      "conflict",
      "suite-name-taken",
    );
    await handler.execute(new UpdateSuiteCommand(ORG, PROJECT, suiteId, { name: "a" }, ACTOR));
    let saved = await workflows.findSuite(PROJECT, suiteId);
    assert.equal(saved?.name, "a");
    assert.equal(saved?.description, "d");
    assert.deepEqual(saved?.workflowIds, ["wf-1"]);

    await handler.execute(
      new UpdateSuiteCommand(ORG, PROJECT, suiteId, { name: "c", description: null, workflowIds: ["wf-2", "wf-1"] }, ACTOR),
    );
    saved = await workflows.findSuite(PROJECT, suiteId);
    assert.equal(saved?.name, "c");
    assert.equal(saved?.description, null);
    assert.deepEqual(saved?.workflowIds, ["wf-2", "wf-1"]);

    await assert.rejects(
      handler.execute(new UpdateSuiteCommand(ORG, PROJECT, suiteId, { workflowIds: ["wf-1", "ghost"] }, ACTOR)),
      (error: DomainError) => {
        assert.equal(error.code, "workflow-not-found");
        assert.deepEqual(error.fields, [{ field: "workflowIds", detail: "No hay ningún flujo con el id ghost" }]);
        return true;
      },
    );
    await rejectsWith(
      handler.execute(new UpdateSuiteCommand(ORG, PROJECT, suiteId, { workflowIds: ["wf-1", "wf-1"] }, ACTOR)),
      "invalid",
    );
  });

  test("delete: unknown 404, known goes and its flows stay", async () => {
    const { projects, workflows, clock } = world();
    await workflows.saveWorkflow(workflowRow());
    const { suiteId } = await new CreateSuiteHandler(projects, workflows, clock).execute(
      new CreateSuiteCommand(ORG, PROJECT, { name: "s", workflowIds: ["wf-1"] }, ACTOR),
    );
    const handler = new DeleteSuiteHandler(projects, workflows, clock);
    await rejectsWith(handler.execute(new DeleteSuiteCommand(ORG, PROJECT, "nope")), "not-found", "suite-not-found");
    await handler.execute(new DeleteSuiteCommand(ORG, PROJECT, suiteId));
    // Fuera de la lista y en la papelera, con el flujo que nombraba intacto.
    assert.deepEqual(await workflows.listSuites(PROJECT), []);
    assert.equal((await workflows.listSuites(PROJECT, "deleted")).length, 1);
    assert.ok(await workflows.findWorkflow(PROJECT, "wf-1"));

    await new RestoreSuiteHandler(projects, workflows, clock).execute(new RestoreSuiteCommand(ORG, PROJECT, suiteId));
    assert.equal((await workflows.listSuites(PROJECT)).length, 1);
    await handler.execute(new DeleteSuiteCommand(ORG, PROJECT, suiteId));
    await handler.execute(new DeleteSuiteCommand(ORG, PROJECT, suiteId, true));
    assert.equal(await workflows.findSuite(PROJECT, suiteId), null);
  });
});

describe("workflows", () => {
  test("create: blank name 422, taken 409, unknown template 422 with its field, defaults", async () => {
    const { projects, workflows, clock } = world();
    const handler = new CreateWorkflowHandler(projects, workflows, clock);
    await assert.rejects(
      handler.execute(new CreateWorkflowCommand(ORG, PROJECT, { name: " " }, ACTOR)),
      (error: DomainError) => error.code === "workflow-invalid" && error.fields[0]?.field === "name",
    );
    await assert.rejects(
      handler.execute(
        new CreateWorkflowCommand(
          ORG,
          PROJECT,
          { name: "f", definition: { steps: [{ id: "a", requestTemplateId: "11111111-1111-4111-8111-111111111111" }] } },
          ACTOR,
        ),
      ),
      (error: DomainError) => {
        assert.deepEqual(error.fields, [
          { field: "definition.steps.0.requestTemplateId", detail: "la prueba 11111111-1111-4111-8111-111111111111 no existe en este proyecto" },
        ]);
        return true;
      },
    );
    const { workflowId } = await handler.execute(
      new CreateWorkflowCommand(ORG, PROJECT, { name: " f ", description: "" }, ACTOR),
    );
    const saved = await workflows.findWorkflow(PROJECT, workflowId);
    assert.equal(saved?.name, "f");
    assert.equal(saved?.description, null);
    assert.equal(saved?.status, "draft");
    assert.deepEqual(saved?.definition, { steps: [] });
    await rejectsWith(
      handler.execute(new CreateWorkflowCommand(ORG, PROJECT, { name: "f" }, ACTOR)),
      "conflict",
      "workflow-name-taken",
    );
  });

  test("update: unknown 404, clash 409, omitted definition kept, description cleared", async () => {
    const { projects, workflows, clock } = world();
    await workflows.saveTemplate(templateRow());
    const steps: WorkflowDocument["steps"] = [{ id: "s", requestTemplateId: "tpl-1" }];
    await workflows.saveWorkflow(workflowRow({ definition: { steps } }));
    await workflows.saveWorkflow(workflowRow({ id: "wf-2", name: "Otro" }));
    const handler = new UpdateWorkflowHandler(projects, workflows, clock);

    await rejectsWith(
      handler.execute(new UpdateWorkflowCommand(ORG, PROJECT, "nope", {}, ACTOR)),
      "not-found",
      "workflow-not-found",
    );
    await rejectsWith(
      handler.execute(new UpdateWorkflowCommand(ORG, PROJECT, "wf-1", { name: "Otro" }, ACTOR)),
      "conflict",
      "workflow-name-taken",
    );
    await handler.execute(new UpdateWorkflowCommand(ORG, PROJECT, "wf-1", { description: "" }, ACTOR));
    const saved = await workflows.findWorkflow(PROJECT, "wf-1");
    assert.equal(saved?.name, "Flujo");
    assert.equal(saved?.description, null);
    assert.equal(saved?.status, "ready");
    assert.deepEqual(saved?.definition.steps, steps);
  });

  test("delete: in a suite 409, a subflow of another flow 409 naming it, otherwise gone", async () => {
    const { projects, workflows, clock } = world();
    await workflows.saveWorkflow(workflowRow());
    await workflows.saveWorkflow(
      workflowRow({
        id: "wf-parent",
        name: "Padre",
        definition: { steps: [{ id: "sub", kind: "subflow", subflow: { workflowId: "wf-1" } }] } as WorkflowDocument,
      }),
    );
    const handler = new DeleteWorkflowHandler(projects, workflows, clock);
    await assert.rejects(handler.execute(new DeleteWorkflowCommand(ORG, PROJECT, "wf-1")), (error: DomainError) => {
      assert.equal(error.code, "workflow-in-use");
      assert.equal(error.message, "«Padre» usa este flujo como sub-flujo");
      return true;
    });
    await workflows.deleteWorkflow(PROJECT, "wf-parent");
    const { suiteId } = await new CreateSuiteHandler(projects, workflows, clock).execute(
      new CreateSuiteCommand(ORG, PROJECT, { name: "s", workflowIds: ["wf-1"] }, ACTOR),
    );
    await assert.rejects(
      handler.execute(new DeleteWorkflowCommand(ORG, PROJECT, "wf-1")),
      (error: DomainError) => error.code === "workflow-in-use" && /suite/.test(error.message),
    );
    await workflows.deleteSuite(PROJECT, suiteId);
    await handler.execute(new DeleteWorkflowCommand(ORG, PROJECT, "wf-1"));
    // Blando: sale de la lista y espera en la papelera.
    assert.deepEqual(await workflows.listWorkflows(PROJECT), []);
    assert.equal((await workflows.listWorkflows(PROJECT, "deleted")).length, 1);

    await new RestoreWorkflowHandler(projects, workflows, clock).execute(
      new RestoreWorkflowCommand(ORG, PROJECT, "wf-1"),
    );
    assert.equal((await workflows.listWorkflows(PROJECT)).length, 1);
    await handler.execute(new DeleteWorkflowCommand(ORG, PROJECT, "wf-1"));
    await handler.execute(new DeleteWorkflowCommand(ORG, PROJECT, "wf-1", true));
    assert.equal(await workflows.findWorkflow(PROJECT, "wf-1"), null);
  });

  test("duplicate: next free «(copia N)», datasets copied as new rows, a draft", async () => {
    const { projects, workflows, clock } = world();
    await workflows.saveWorkflow(workflowRow());
    await workflows.saveWorkflow(workflowRow({ id: "wf-c", name: "Flujo (copia)" }));
    await new CreateDatasetHandler(projects, workflows, clock).execute(
      new CreateDatasetCommand(ORG, PROJECT, "wf-1", { name: "datos", rows: [{ a: "1" }] }, ACTOR),
    );
    const handler = new DuplicateWorkflowHandler(projects, workflows, clock);
    const { workflowId } = await handler.execute(new DuplicateWorkflowCommand(ORG, PROJECT, "wf-1", ACTOR));
    const copy = await workflows.findWorkflow(PROJECT, workflowId);
    assert.equal(copy?.name, "Flujo (copia 2)");
    assert.equal(copy?.status, "draft");
    const datasets = (await workflows.listDatasets(PROJECT)).filter((row) => row.workflowId === workflowId);
    assert.equal(datasets.length, 1);
    assert.equal(datasets[0].name, "datos");
    assert.deepEqual(datasets[0].rows, [{ a: "1" }]);
    // The original's dataset is untouched and distinct.
    assert.equal((await workflows.listDatasets(PROJECT)).length, 2);
  });

  test("duplicate: a name too long for any «(copia)» falls back to a unique suffix", async () => {
    const { projects, workflows, clock } = world();
    const long = "n".repeat(118);
    await workflows.saveWorkflow(workflowRow({ name: long }));
    const { workflowId } = await new DuplicateWorkflowHandler(projects, workflows, clock).execute(
      new DuplicateWorkflowCommand(ORG, PROJECT, "wf-1", ACTOR),
    );
    const copy = await workflows.findWorkflow(PROJECT, workflowId);
    assert.match(copy?.name ?? "", new RegExp(`^${"n".repeat(100)} [0-9a-f]{8}$`));
  });
});

describe("import request templates", () => {
  test("without an active contract it is a 409", async () => {
    const { projects, specs, workflows, clock } = world();
    await rejectsWith(
      new ImportRequestTemplatesHandler(projects, specs, workflows, clock).execute(
        new ImportRequestTemplatesCommand(ORG, PROJECT, { format: "curl", text: "curl https://x/a" }, ACTOR),
      ),
      "conflict",
      "no-active-spec",
    );
  });

  test("text with nothing to read is a 422", async () => {
    const { projects, specs, workflows, clock } = world({ spec: [{ id: "list", method: "GET", path: "/a" }] });
    await rejectsWith(
      new ImportRequestTemplatesHandler(projects, specs, workflows, clock).execute(
        new ImportRequestTemplatesCommand(ORG, PROJECT, { format: "curl", text: "no hay nada" }, ACTOR),
      ),
      "invalid",
      "nothing-to-import",
    );
  });

  test("uniqueName defaults a blank name and numbers collisions", () => {
    assert.equal(uniqueName("   ", new Set()), "Petición importada");
    assert.equal(uniqueName("a", new Set(["a", "a (2)"])), "a (3)");
    const all = new Set(["a", ...Array.from({ length: 998 }, (_, index) => `a (${index + 2})`)]);
    assert.match(uniqueName("a", all), /^a [0-9a-f]{8}$/);
  });
});

describe("import Postman flows", () => {
  const collection = (items: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ item: items, ...extra });
  const run = (w: ReturnType<typeof world>, text: string, flows?: string[]) =>
    new ImportPostmanFlowsHandler(w.projects, w.specs, w.workflows, w.clock).execute(
      new ImportPostmanFlowsCommand(ORG, PROJECT, { text, ...(flows ? { flows } : {}) }, ACTOR),
    );

  test("not JSON, no requests, and chosen folders that do not exist are each a 422", async () => {
    const w = world();
    await rejectsWith(run(w, "{"), "invalid", "postman-invalid");
    await rejectsWith(run(w, collection([])), "invalid", "nothing-to-import");
    await assert.rejects(
      run(w, collection([{ name: "A", item: [{ name: "r", request: { url: "/x" } }] }]), ["B"]),
      (error: DomainError) => {
        assert.equal(error.code, "nothing-to-import");
        assert.deepEqual(error.fields, [{ field: "flows", detail: "La colección trae: A" }]);
        return true;
      },
    );
  });

  test("when every request is refused the error lists why", async () => {
    const w = world();
    await assert.rejects(
      run(
        w,
        collection([
          { name: "raro", request: { method: "PROPFIND", url: "/x" } },
          { name: "gql", request: { method: "POST", url: "", body: { mode: "graphql", graphql: { query: "{a}" } } } },
        ]),
      ),
      (error: DomainError) => {
        assert.equal(error.code, "nothing-to-import");
        assert.deepEqual(
          error.fields.map((field) => field.detail),
          [
            "gql: la petición no lleva URL",
            "raro: el método PROPFIND no se puede enviar",
            "Colección importada: no quedó ninguna petición que importar",
          ],
        );
        return true;
      },
    );
    assert.deepEqual(await w.workflows.listWorkflows(PROJECT), []);
  });

  test("graphql nodes, dropped credentials, collection scripts and a nameless collection", async () => {
    const w = world();
    const outcome = await run(
      w,
      collection(
        [
          {
            name: "Consulta",
            request: {
              method: "POST",
              url: "{{base}}/graphql",
              header: [{ key: "Authorization", value: "Bearer literal" }],
              body: { mode: "graphql", graphql: { query: "{ me { id } }", variables: "" } },
            },
          },
          {
            name: "Mala",
            request: {
              method: "POST",
              url: "{{base}}/graphql",
              body: { mode: "graphql", graphql: { query: "{ a }", variables: "[1]" } },
            },
          },
          {
            name: "Llamada",
            request: { method: "GET", url: "{{base}}/x", header: [{ key: "Cookie", value: "sid=1" }] },
          },
        ],
        { event: [{ listen: "prerequest", script: { exec: ["console.log(1)"] } }] },
      ),
    );
    assert.equal(outcome.collection, "");
    assert.equal(outcome.flows.length, 1);
    assert.deepEqual(
      { ...outcome.flows[0], id: undefined },
      { id: undefined, name: "Colección importada", action: "created", steps: 2, requests: 0, calls: 2, scripts: 0 },
    );
    assert.deepEqual(outcome.skipped, [
      { name: "Mala", method: "POST", url: "{{base}}/graphql", reason: "sus variables de GraphQL no son un objeto JSON" },
    ]);
    assert.ok(outcome.notes.some((note) => note.startsWith("La colección trae scripts propios")));
    assert.ok(outcome.notes.some((note) => note.startsWith("«Consulta»: llevaba una credencial")));
    assert.ok(outcome.notes.some((note) => note.startsWith("«Llamada»: llevaba una credencial")));
    const saved = await w.workflows.findWorkflowByName(PROJECT, "Colección importada");
    assert.equal(saved?.description, "Importado de la colección «Postman»");
    assert.equal(saved?.definition.steps[0].kind, "graphql");
    assert.equal(saved?.definition.steps[0].graphql?.useSession, true);
  });

  test("a matched request becomes a template; importing again updates it and keeps the flow's status", async () => {
    const w = world({ spec: [{ id: "getThing", method: "GET", path: "/things/{id}", statuses: [200, 404] }] });
    const text = collection([
      {
        name: "Tienda",
        item: [
          {
            name: "Leer",
            request: { method: "GET", url: "{{base}}/things/7?full=1", header: [{ key: "X-Trace", value: "1" }] },
            event: [{ listen: "test", script: { exec: ["pm.response.to.have.status(200)"] } }],
          },
        ],
      },
    ]);
    const first = await run(w, text);
    assert.deepEqual(first.templates, { created: 1, updated: 0 });
    const template = await w.workflows.findTemplateByName(PROJECT, "Tienda / Leer");
    assert.ok(template);
    assert.deepEqual(template.parameters, { id: "7", full: "1" });
    assert.deepEqual(template.headers, { "X-Trace": "1" });
    assert.equal(template.expectedStatus, 200);

    const flow = await w.workflows.findWorkflowByName(PROJECT, "Tienda");
    assert.ok(flow);
    await w.workflows.saveWorkflow({ ...flow, status: "ready", description: "mía" });
    w.clock.advance(1000);
    const second = await run(w, text, ["Tienda"]);
    assert.deepEqual(second.templates, { created: 0, updated: 1 });
    assert.equal(second.flows[0].action, "updated");
    const again = await w.workflows.findWorkflowByName(PROJECT, "Tienda");
    assert.equal(again?.id, flow.id);
    assert.equal(again?.status, "ready");
    assert.equal(again?.description, "mía");
    assert.equal((await w.workflows.findTemplateByName(PROJECT, "Tienda / Leer"))?.id, template.id);
  });
});

describe("views and scenarios", () => {
  test("templateView fills absent maps with their empty values", () => {
    const view = templateView({
      ...templateRow(),
      parameters: undefined,
      disabledParameters: undefined,
      headers: undefined,
      disabledHeaders: undefined,
      body: undefined,
      auth: undefined,
    } as unknown as RequestTemplateRow);
    assert.deepEqual(
      [view.parameters, view.disabledParameters, view.headers, view.disabledHeaders, view.body, view.auth],
      [{}, {}, {}, {}, { type: "none" }, "default"],
    );
  });

  test("scenarioFor leaves out absent parameters and headers, and names a default description", () => {
    const scenario = scenarioFor({
      id: "t",
      name: "n",
      description: null,
      expectedStatus: 200,
      parameters: undefined,
      headers: undefined,
      body: { type: "none" },
      auth: "default",
    } as unknown as Parameters<typeof scenarioFor>[0]);
    assert.equal(scenario.description, "Paso de un flujo reutilizable");
    assert.equal("parameters" in scenario, false);
    assert.equal("headers" in scenario, false);
  });
});
