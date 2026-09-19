/**
 * Flows: a flow or a dataset created with no name at all, a Postman flow that converts into a
 * document the schema refuses, node ids for three requests with the same name, a HAR body whose
 * type has to be found in its headers, and the Postman assertions this reader must refuse.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { FixedClock } from "@/shared/clock/clock.port";
import type { DomainError } from "@/shared/errors/domain-error";
import type { Project } from "@/modules/projects/domain/model";
import { CreateDatasetCommand, CreateDatasetHandler } from "@/modules/workflows/application/commands/manage-dataset";
import { CreateWorkflowCommand, CreateWorkflowHandler } from "@/modules/workflows/application/commands/manage-workflow";
import {
  ImportPostmanFlowsCommand,
  ImportPostmanFlowsHandler,
} from "@/modules/workflows/application/commands/import-postman-flows";
import { freeId } from "@/modules/workflows/domain/postman-flows";
import { parseHar, shellSplit } from "@/modules/workflows/domain/import-requests";
import { translatePostmanScript } from "@/modules/workflows/domain/postman-scripts";
import {
  InMemoryProjectRepository,
  InMemorySpecRepository,
  InMemoryWorkflowRepository,
} from "@test/support/in-memory-repositories";

const ORG = "org-1";
const PROJECT = "proj-1";
const T0 = new Date("2026-01-01T00:00:00.000Z");

function world() {
  const projects = new InMemoryProjectRepository();
  void projects.save({
    id: PROJECT,
    organizationId: ORG,
    name: "P",
    slug: "p",
    activeSpecVersionId: null,
    deletedAt: null,
  } as unknown as Project);
  return {
    projects,
    workflows: new InMemoryWorkflowRepository(),
    specs: new InMemorySpecRepository(),
    clock: new FixedClock(T0),
  };
}

const nameRequired = (code?: string) => (error: DomainError) => {
  assert.equal(error.kind, "invalid");
  if (code) assert.equal(error.code, code);
  assert.equal(error.fields[0]?.field, "name");
  return true;
};

describe("crear sin nombre", () => {
  test("un flujo sin el campo nombre es un 422 sobre el nombre", async () => {
    const w = world();
    await assert.rejects(
      new CreateWorkflowHandler(w.projects, w.workflows, w.clock).execute(
        new CreateWorkflowCommand(ORG, PROJECT, {}, "u"),
      ),
      nameRequired("workflow-invalid"),
    );
    assert.equal((await w.workflows.listWorkflows(PROJECT)).length, 0);
  });

  test("un conjunto de datos sin el campo nombre es un 422 sobre el nombre", async () => {
    const w = world();
    await w.workflows.saveWorkflow({
      id: "wf-1",
      projectId: PROJECT,
      name: "Flujo",
      description: null,
      status: "ready",
      definition: { steps: [] },
      createdAt: T0,
      updatedAt: T0,
      updatedBy: "u",
    } as never);
    await assert.rejects(
      new CreateDatasetHandler(w.projects, w.workflows, w.clock).execute(
        new CreateDatasetCommand(ORG, PROJECT, "wf-1", {}, "u"),
      ),
      nameRequired(),
    );
  });
});

describe("importar flujos de Postman", () => {
  test("un flujo que sale de la colección y el esquema no acepta es un 422 y no se guarda nada", async () => {
    const w = world();
    // A header value past the schema's 4 000 characters: the reader keeps it, the flow document refuses it.
    const text = JSON.stringify({
      item: [
        {
          name: "Pedidos",
          item: [
            {
              name: "listar",
              request: {
                method: "GET",
                url: "https://api.test/x",
                header: [{ key: "X-Largo", value: "a".repeat(4_001) }],
              },
            },
          ],
        },
      ],
    });
    await assert.rejects(
      new ImportPostmanFlowsHandler(w.projects, w.specs, w.workflows, w.clock).execute(
        new ImportPostmanFlowsCommand(ORG, PROJECT, { text }, "u"),
      ),
      (error: DomainError) => {
        assert.equal(error.kind, "invalid");
        assert.equal(error.code, "workflow-invalid");
        assert.equal(error.message, "El flujo «Pedidos» que sale de la colección no es válido");
        assert.ok(error.fields.length > 0);
        return true;
      },
    );
    assert.equal((await w.workflows.listWorkflows(PROJECT)).length, 0);
  });

  test("tres peticiones con el mismo nombre reciben ids distintos y legibles", () => {
    const taken = new Set<string>();
    assert.deepEqual(
      ["Crear pedido", "Crear pedido", "Crear pedido"].map((name) => freeId(name, taken)),
      ["crear-pedido", "crear-pedido-2", "crear-pedido-3"],
    );
  });
});

describe("leer peticiones", () => {
  test("una línea de curl que acaba en espacio no deja un argumento vacío detrás", () => {
    assert.deepEqual(shellSplit("curl https://api.test/x   "), ["curl", "https://api.test/x"]);
  });

  test("un cuerpo HAR sin tipo declarado lo toma de su Content-Type, y sin ninguno lo lee como texto", () => {
    const entry = (headers: { name: string; value: string }[]) => ({
      request: { method: "POST", url: "https://api.test/pedidos", headers, postData: { text: "a=1&b=2" } },
      response: { status: 201, content: { mimeType: "application/json" } },
    });
    const har = (headers: { name: string; value: string }[]) =>
      parseHar(JSON.stringify({ log: { entries: [entry(headers)] } })).requests[0].body;
    assert.deepEqual(har([{ name: "content-type", value: "application/x-www-form-urlencoded" }]), {
      type: "x-www-form-urlencoded",
      fields: { a: "1", b: "2" },
      disabledFields: {},
    });
    assert.deepEqual(har([{ name: "X-Otro", value: "1" }]), {
      type: "raw",
      text: "a=1&b=2",
      contentType: "text/plain",
    });
  });

  test("una autorización vacía no se toma por un esquema conocido", () => {
    const out = parseHar(
      JSON.stringify({
        log: {
          entries: [
            {
              request: {
                method: "GET",
                url: "https://api.test/yo",
                headers: [{ name: "Authorization", value: "   " }],
              },
              response: { status: 200, content: { mimeType: "application/json" } },
            },
          ],
        },
      }),
    );
    assert.equal(out.requests[0].auth.type, "inherit");
  });
});

describe("los scripts de Postman que no se pueden leer", () => {
  const refused = (code: string) => translatePostmanScript(code).untranslatable;

  test("un pm.test anidado dentro de un bloque se queda como script", () => {
    assert.equal(
      refused('if (pm.response.code) { pm.test("a", function () { pm.response.to.have.status(200) }) }'),
      'if (pm.response.code) { pm.test("a", function () { pm.response.to.have.status(200) }) }',
    );
  });

  test("una función cuyas llaves quedan dentro de una comilla no se puede leer", () => {
    assert.equal(refused("pm.test(\"n\", function(a=') { x' })"), "pm.test «n» no lleva una función que se pueda leer");
  });

  test("una aserción de tipo o de valor sin su argumento no se traduce a una comprobación", () => {
    for (const code of [
      "pm.expect(pm.response.code).to.be.an",
      "pm.expect(pm.response.code).to.equal",
      "pm.expect(pm.response.text()).to.match",
    ]) {
      assert.deepEqual(translatePostmanScript(code), { checks: [], captures: [], untranslatable: code });
    }
  });
});
