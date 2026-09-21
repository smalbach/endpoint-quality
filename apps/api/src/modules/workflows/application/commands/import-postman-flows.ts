import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import { safeParseWorkflowDocument, type Operation, type WorkflowDocument } from "@eq/runner-core";
import type { PostmanFlowsImportResult } from "@eq/contracts";

import { InvalidInputError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "@/modules/specs/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import {
  expectedStatusFor,
  matchOperation,
  queryOf,
  readPostmanCollection,
  type SkippedRequest,
} from "../../domain/import-requests";
import {
  definitionFrom,
  fetchCallFrom,
  graphqlCallFrom,
  flowsOf,
  readItemScripts,
  type PostmanStepDraft,
} from "../../domain/postman-flows";
import type { RequestTemplateRow, WorkflowRow } from "../../domain/model";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "../../domain/ports";
import { importableHeaders, uniqueName } from "./import-request-templates";

export class ImportPostmanFlowsCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: { text: string; flows?: string[] },
    readonly actorId: string,
  ) {}
}

/**
 * What the import answers, which is the published view and not a second copy of it.
 *
 * Declared in `@eq/contracts` so the browser and this handler cannot disagree about what came
 * back — the lesson `apps/web/src/lib/types.ts` is written over.
 */
export type ImportPostmanFlowsOutcome = PostmanFlowsImportResult;
export type ImportedFlow = PostmanFlowsImportResult["flows"][number];

/**
 * Las peticiones de una captura, como el flujo que describen.
 *
 * **Ya no es la puerta de «importar una colección».** Una colección de Postman entra como la
 * colección que es —`modules/collections`, su árbol tal cual, editable y ejecutable como allí—, y
 * esta ruta de aquí dejó de existir junto con su DTO: era la que partía el árbol de alguien en
 * grafos y producía algo que ya no se podía devolver a Postman.
 *
 * Lo que queda es el puente que usa la captura de tráfico: las peticiones grabadas se escriben
 * como una colección sintética y esta función las convierte en un flujo, que es lo que allí se
 * pidió —«haz un flujo con lo que acabo de grabar»— y no tiene fichero de nadie detrás. Por eso
 * sigue viva y por eso no la llama ningún controlador.
 *
 * **Nothing is written until the whole file has been read.** A collection of nine folders where the
 * seventh has a request nobody can parse must not leave six flows behind and an error; the graphs
 * are built and validated first, and only then does anything reach the repository.
 *
 * **Created or updated, by name.** Importing the same collection twice is the ordinary case — the
 * tests changed, the folder grew a step — and a second import that produced «Pedidos (copia 2)»
 * would leave somebody to work out which of three flows is the live one. So a flow whose name the
 * project already has is *rewritten*: its graph, and the saved requests its nodes name. What is not
 * touched is its status and its datasets, because those are decisions somebody made here and not
 * in Postman.
 *
 * The one thing this refuses to do is invent an operation. A request the active contract declares
 * becomes a node over a saved request of this project; one it does not becomes a `fetch` node with
 * the call written out. Both are honest about what they are, and the second is exactly what the
 * `fetch` node exists for.
 */
@CommandHandler(ImportPostmanFlowsCommand)
export class ImportPostmanFlowsHandler implements ICommandHandler<
  ImportPostmanFlowsCommand,
  ImportPostmanFlowsOutcome
> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: ImportPostmanFlowsCommand): Promise<ImportPostmanFlowsOutcome> {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    const collection = readPostmanCollection(command.input.text);
    if (!collection) {
      throw new InvalidInputError(
        "El fichero no es una colección de Postman",
        [{ field: "text", detail: "No es JSON. Exporta la colección como v2.1 y vuelve a intentarlo" }],
        "postman-invalid",
      );
    }
    if (!collection.items.length) {
      throw new InvalidInputError(
        "La colección no trae ninguna petición",
        [{ field: "text", detail: "Se leyó como Postman v2.1 y no contiene peticiones con URL" }],
        "nothing-to-import",
      );
    }

    const wanted = command.input.flows?.length ? new Set(command.input.flows) : null;
    const flows = flowsOf(collection).filter((flow) => !wanted || wanted.has(flow.name));
    if (!flows.length) {
      throw new InvalidInputError(
        "Ninguna de las carpetas elegidas está en la colección",
        [
          {
            field: "flows",
            detail: `La colección trae: ${flowsOf(collection)
              .map((flow) => flow.name)
              .join(", ")}`,
          },
        ],
        "nothing-to-import",
      );
    }

    const notes: string[] = [];
    const skipped: SkippedRequest[] = [...collection.skipped];
    if (collection.scripts.prerequest.trim() || collection.scripts.test.trim()) {
      // Postman runs the collection's own events around *every* request. Copying them onto every
      // node would bury each flow under the same forty lines, and dropping them in silence would
      // leave a flow that quietly asserts less than the collection did.
      notes.push(
        "La colección trae scripts propios (nivel colección) que Postman ejecuta en cada petición: no se importan, revísalos a mano.",
      );
    }

    const operations: Operation[] = project.activeSpecVersionId
      ? await this.specs.listOperations(project.activeSpecVersionId)
      : [];
    if (!operations.length) {
      notes.push(
        "El proyecto no tiene contrato activo, así que cada petición entra como nodo «fetch» (o «graphql», si lo es) con su URL escrita.",
      );
    }

    const existingTemplates = await this.workflows.listTemplates(project.id);
    const byName = new Map(existingTemplates.map((template) => [template.name, template]));
    const takenNames = new Set(existingTemplates.map((template) => template.name));
    const now = this.clock.now();

    /** Everything to write, gathered before anything is. */
    const templateWrites: RequestTemplateRow[] = [];
    const flowWrites: { row: WorkflowRow; outcome: ImportedFlow }[] = [];
    const counters = { created: 0, updated: 0 };

    for (const flow of flows) {
      const drafts: PostmanStepDraft[] = [];
      for (const item of flow.items) {
        const scripts = readItemScripts(item);
        if (scripts.reason) {
          notes.push(`«${item.label}»: el test se mantiene como nodo script (${scripts.reason}).`);
        }
        // Una operación GraphQL va a su nodo aunque el contrato declare `POST /graphql`: esa ruta es
        // la misma para todas las operaciones, y un nodo `request` sobre ella no lee `errors`.
        const match = item.request.graphql ? null : matchOperation(item.request, operations);

        if (match) {
          const previous = byName.get(item.label);
          const name = previous ? previous.name : uniqueName(item.label, takenNames);
          takenNames.add(name);
          const row: RequestTemplateRow = {
            id: previous?.id ?? randomUUID(),
            projectId: project.id,
            name,
            operationId: match.operation.id,
            description: previous?.description ?? null,
            // What the test asserted, when it asserted one; what the contract declares otherwise.
            expectedStatus: scripts.expectedStatus ?? expectedStatusFor(match.operation),
            parameters: { ...match.parameters, ...queryOf(item.request.url) },
            disabledParameters: {},
            headers: importableHeaders(item.request.headers),
            disabledHeaders: {},
            body: item.request.body,
            // `default`, always: an importer cannot tell «esta petición no llevaba token» from
            // «este caso prueba qué pasa sin él», and the three other selectors exist to be
            // rejected on purpose.
            auth: "default",
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
            updatedBy: command.actorId,
          };
          templateWrites.push(row);
          if (previous) counters.updated += 1;
          else counters.created += 1;
          byName.set(name, row);
          drafts.push({
            label: item.name,
            source: { kind: "request", requestTemplateId: row.id },
            checks: scripts.checks,
            captures: scripts.captures,
            prerequest: item.prerequest,
            test: scripts.test,
          });
          continue;
        }

        const graphql = graphqlCallFrom(item, scripts.expectedStatus);
        if (typeof graphql === "string") {
          skipped.push({ name: item.label, method: item.request.method, url: item.request.url, reason: graphql });
          continue;
        }
        if (graphql) {
          if (graphql.droppedCredential) {
            notes.push(
              `«${item.label}»: llevaba una credencial escrita a mano; se quitó y el nodo presenta la sesión de la corrida.`,
            );
          }
          drafts.push({
            label: item.name,
            source: { kind: "graphql", graphql: graphql.graphql },
            checks: scripts.checks,
            captures: scripts.captures,
            prerequest: item.prerequest,
            test: scripts.test,
          });
          continue;
        }

        const call = fetchCallFrom(item, scripts.expectedStatus);
        if (typeof call === "string") {
          skipped.push({ name: item.label, method: item.request.method, url: item.request.url, reason: call });
          continue;
        }
        if (call.droppedCredential) {
          notes.push(
            `«${item.label}»: llevaba una credencial escrita a mano; se quitó y el nodo presenta la sesión de la corrida.`,
          );
        }
        drafts.push({
          label: item.name,
          source: { kind: "fetch", fetch: call.fetch },
          checks: scripts.checks,
          captures: scripts.captures,
          prerequest: item.prerequest,
          test: scripts.test,
        });
      }

      if (!drafts.length) {
        skipped.push({ name: flow.name, method: "", url: "", reason: "no quedó ninguna petición que importar" });
        continue;
      }

      const definition = definitionFrom(drafts);
      const parsed = safeParseWorkflowDocument(definition);
      if (!parsed.ok) {
        throw new InvalidInputError(
          `El flujo «${flow.name}» que sale de la colección no es válido`,
          parsed.issues,
          "workflow-invalid",
        );
      }

      const previous = await this.workflows.findWorkflowByName(project.id, flow.name.slice(0, 120));
      const row: WorkflowRow = {
        id: previous?.id ?? randomUUID(),
        projectId: project.id,
        name: flow.name.slice(0, 120),
        description: previous?.description ?? `Importado de la colección «${collection.name || "Postman"}»`,
        // An existing flow keeps the state somebody decided here; a new one is a draft, like every
        // other new flow — its edges came out of a guess about somebody else's folder.
        status: previous?.status ?? "draft",
        definition,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        updatedBy: command.actorId,
        // Reimportar no resucita un flujo eliminado: `findWorkflowByName` solo mira los vivos, así
        // que `previous` nunca es uno de la papelera y esto siempre nace o sigue vivo.
        deletedAt: null,
      };
      flowWrites.push({
        row,
        outcome: {
          id: row.id,
          name: row.name,
          action: previous ? "updated" : "created",
          steps: definition.steps.length,
          requests: countKind(definition, "request"),
          calls: countKind(definition, "fetch") + countKind(definition, "graphql"),
          scripts: countKind(definition, "script"),
        },
      });
    }

    if (!flowWrites.length) {
      throw new InvalidInputError(
        "No se pudo montar ningún flujo con la colección",
        // Una carpeta que no deja ningún nodo se apunta arriba en `skipped`, así que si no se montó
        // ningún flujo hay al menos un motivo que contar: no hace falta uno genérico.
        skipped.slice(0, 5).map((entry) => ({ field: "text", detail: `${entry.name}: ${entry.reason}` })),
        "nothing-to-import",
      );
    }

    for (const row of templateWrites) await this.workflows.saveTemplate(row);
    for (const { row } of flowWrites) await this.workflows.saveWorkflow(row);

    return {
      collection: collection.name,
      flows: flowWrites.map(({ outcome }) => outcome),
      templates: counters,
      skipped,
      notes,
    };
  }
}

const countKind = (definition: WorkflowDocument, kind: "request" | "fetch" | "graphql" | "script"): number =>
  definition.steps.filter((step) => (step.kind ?? "request") === kind).length;
