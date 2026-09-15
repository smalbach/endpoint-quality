import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import { CONFIG_SECTIONS, isConfigSection, type ConfigSection, type WorkflowDocument } from "@eq/runner-core";

import { InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { CONFIG_REPOSITORY, type ConfigRepositoryPort } from "@/modules/config/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import type { EnvironmentVariables } from "@/modules/environments/domain/model";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "../../domain/ports";
import { ownedProject } from "./update-project";

export type CopyFromProjectInput = {
  sourceProjectId: string;
  /** Which configuration sections to bring. Empty means none, which is what somebody copying only
   * the flows means. */
  sections: ConfigSection[];
  /** The saved requests and the flows built from them, together: a flow whose steps name requests
   * that did not come would be a graph pointing at nothing. */
  flows: boolean;
  environments: boolean;
};

export class CopyFromProjectCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: CopyFromProjectInput,
    readonly actorId: string,
  ) {}
}

/** What came across, and what was deliberately left behind. Both, because the second is the half
 * somebody has to act on. */
export type CopyOutcome = {
  sections: ConfigSection[];
  requestTemplates: number;
  workflows: number;
  suites: number;
  environments: number;
  /** Named, not counted: «3 cosas no se copiaron» is not something anybody can act on. */
  skipped: { what: string; detail: string }[];
};

/**
 * Starting a project from one that already works.
 *
 * The second project of a team is never a blank one. It has the same envelope, the same latency
 * budgets, the same words for the same cases and usually the same shape of flow — and until now
 * all of that was retyped, which is both an afternoon and a source of the differences that make
 * two projects disagree about what «pasó» means.
 *
 * Three rules hold it together.
 *
 * **The same organization, always.** The source is resolved through `ownedProject` exactly like
 * the target, so copying is not a way to read a project somebody is not a member of. A source in
 * another organization is a 404 and not a 403, like everywhere else here: a 403 would confirm the
 * id is real.
 *
 * **Ids are remade and references remapped.** A flow names its steps' requests by id inside a
 * `jsonb` document, so copying the rows verbatim would produce a graph in the new project pointing
 * at the old project's requests — which is a state no foreign key can refuse and that only fails
 * hours later, mid-run.
 *
 * **No secret crosses.** Credentials are not copied, and neither are the values of variables
 * marked sensitive. A credential is ciphertext belonging to one environment, and duplicating it
 * would put somebody's staging token in a second project silently — the exact thing the
 * credentials table exists to prevent. They come across as *named and empty*, and the outcome says
 * which, because an environment that looks configured and answers 401 is worse than one that
 * plainly needs filling in.
 */
@CommandHandler(CopyFromProjectCommand)
export class CopyFromProjectHandler implements ICommandHandler<CopyFromProjectCommand, CopyOutcome> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CONFIG_REPOSITORY) private readonly config: ConfigRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: CopyFromProjectCommand): Promise<CopyOutcome> {
    const target = await ownedProject(this.projects, command.organizationId, command.projectId);
    if (command.input.sourceProjectId === target.id) {
      throw new InvalidInputError(
        "El proyecto de origen es este mismo",
        [{ field: "sourceProjectId", detail: "Elige otro proyecto" }],
        "same-project",
      );
    }
    const source = await this.projects.findById(command.input.sourceProjectId);
    // Folded into the 404 like everywhere else. Copying must not become a way to learn that a
    // project id in another organization exists.
    if (!source || source.organizationId !== command.organizationId) {
      throw new NotFoundError("El proyecto de origen no existe", "source-project-not-found");
    }

    const unknown = command.input.sections.filter((section) => !isConfigSection(section));
    if (unknown.length) {
      throw new InvalidInputError(
        `No existe la sección ${unknown.join(", ")}`,
        unknown.map((section) => ({ field: "sections", detail: section })),
        "unknown-config-section",
      );
    }

    const now = this.clock.now();
    const skipped: CopyOutcome["skipped"] = [];
    const outcome: CopyOutcome = {
      sections: [],
      requestTemplates: 0,
      workflows: 0,
      suites: 0,
      environments: 0,
      skipped,
    };

    await this.copySections(command, source.id, target.id, now, outcome);
    if (command.input.flows) await this.copyFlows(source.id, target.id, command.actorId, now, outcome);
    if (command.input.environments) await this.copyEnvironments(source.id, target.id, now, outcome);
    return outcome;
  }

  /**
   * Sections are **replaced, not merged**.
   *
   * A section is written whole everywhere else in this product — the `PUT` takes the entire
   * document — and merging two of them here would invent a third state that no editor can produce
   * and that nobody asked for: half this project's budgets and half the other's, in an order
   * neither team chose.
   */
  private async copySections(
    command: CopyFromProjectCommand,
    sourceId: string,
    targetId: string,
    now: Date,
    outcome: CopyOutcome,
  ): Promise<void> {
    if (!command.input.sections.length) return;
    const wanted = new Set(command.input.sections);
    const stored = new Map((await this.config.listSections(sourceId)).map((row) => [row.section, row]));
    for (const section of CONFIG_SECTIONS.filter((name) => wanted.has(name))) {
      const row = stored.get(section);
      if (!row) {
        // The source never wrote it, so there is nothing to bring. Overwriting the target's with a
        // default would be this command deleting a section nobody mentioned.
        skippedPush(outcome, "sección", `${section}: el proyecto de origen no la tiene configurada`);
        continue;
      }
      await this.config.saveSection({
        projectId: targetId,
        section,
        data: row.data,
        updatedAt: now,
        updatedBy: command.actorId,
      });
      outcome.sections.push(section);
    }
  }

  /**
   * The requests, the flows and the suites, with every reference remapped.
   *
   * In that order, and in one pass, because each one names the one before it by id: a flow names
   * its requests, a suite names its flows. The maps are what turn a copy into a project rather
   * than into a graph pointing at somebody else's rows.
   *
   * Datasets are not copied. A dataset is the forty rows of real-looking data a flow is run once
   * per, and those belong to the project they were written for — the sku that exists, the customer
   * that is real. Carrying them into a second project produces a run whose every case fails over
   * data that was never meant to be there, which reads as a broken endpoint.
   */
  private async copyFlows(
    sourceId: string,
    targetId: string,
    actorId: string,
    now: Date,
    outcome: CopyOutcome,
  ): Promise<void> {
    const existingTemplates = new Set((await this.workflows.listTemplates(targetId)).map((row) => row.name));
    const templateIds = new Map<string, string>();
    for (const template of await this.workflows.listTemplates(sourceId)) {
      const name = uniqueName(template.name, existingTemplates);
      existingTemplates.add(name);
      const id = randomUUID();
      templateIds.set(template.id, id);
      await this.workflows.saveTemplate({
        ...template,
        id,
        projectId: targetId,
        name,
        createdAt: now,
        updatedAt: now,
        updatedBy: actorId,
      });
      outcome.requestTemplates += 1;
    }

    const existingWorkflows = new Set((await this.workflows.listWorkflows(targetId)).map((row) => row.name));
    const workflowIds = new Map<string, string>();
    for (const workflow of await this.workflows.listWorkflows(sourceId)) {
      const steps = workflow.definition.steps.map((step) =>
        // A branch node has no template to remap; leave it untouched.
        step.requestTemplateId
          ? { ...step, requestTemplateId: templateIds.get(step.requestTemplateId) ?? step.requestTemplateId }
          : step,
      );
      // A step naming a request that is not in the source either — a row somebody deleted around an
      // old flow — comes across unresolved rather than silently dropped: the flow is saved as it
      // was, and the editor already says which step points at nothing. Said out loud anyway,
      // because a flow that cannot run is worth hearing about now rather than at the first run.
      const dangling = workflow.definition.steps.filter(
        (step) => step.requestTemplateId && !templateIds.has(step.requestTemplateId),
      );
      if (dangling.length) {
        const ids = dangling.map((step) => step.id).join(", ");
        skippedPush(outcome, "paso", `${workflow.name}: ${ids} apunta a una prueba que no existe en el origen`);
      }
      const name = uniqueName(workflow.name, existingWorkflows);
      existingWorkflows.add(name);
      const id = randomUUID();
      workflowIds.set(workflow.id, id);
      await this.workflows.saveWorkflow({
        ...workflow,
        id,
        projectId: targetId,
        name,
        definition: { ...workflow.definition, steps } as WorkflowDocument,
        createdAt: now,
        updatedAt: now,
        updatedBy: actorId,
      });
      outcome.workflows += 1;
    }

    const existingSuites = new Set((await this.workflows.listSuites(targetId)).map((row) => row.name));
    for (const suite of await this.workflows.listSuites(sourceId)) {
      const name = uniqueName(suite.name, existingSuites);
      existingSuites.add(name);
      await this.workflows.saveSuite({
        ...suite,
        id: randomUUID(),
        projectId: targetId,
        name,
        // A suite whose flow is gone would be a suite that runs fewer flows than it says; the
        // filter keeps it honest about how many it actually has.
        workflowIds: suite.workflowIds.map((id) => workflowIds.get(id)).filter((id): id is string => Boolean(id)),
        createdAt: now,
        updatedAt: now,
        updatedBy: actorId,
      });
      outcome.suites += 1;
    }
  }

  /** The target and its variables, and nothing that is a secret. See the class comment. */
  private async copyEnvironments(sourceId: string, targetId: string, now: Date, outcome: CopyOutcome): Promise<void> {
    const existing = new Set((await this.environments.listForProject(targetId)).map((row) => row.name));
    for (const environment of await this.environments.listForProject(sourceId)) {
      const name = uniqueName(environment.name, existing);
      existing.add(name);
      const active = withoutSecrets(environment.variables);
      const parked = withoutSecrets(environment.disabledVariables);
      const emptied = [...active.emptied, ...parked.emptied];
      await this.environments.save({
        ...environment,
        id: randomUUID(),
        projectId: targetId,
        name,
        variables: active.variables,
        disabledVariables: parked.variables,
        // Deliberately reset, and not carried. Both flags are answers about *this* target, and an
        // environment that arrived with writes already allowed is one whose first run could be the
        // one that discovers it.
        writesAllowed: false,
        authEnforced: false,
        createdAt: now,
      });
      outcome.environments += 1;
      if (emptied.length) {
        skippedPush(outcome, "secreto", `${name}: hay que volver a escribir ${[...new Set(emptied)].join(", ")}`);
      }
      const credentials = await this.environments.listCredentials(environment.id);
      if (credentials.length) {
        const roles = credentials.map((credential) => credential.role).join(", ");
        skippedPush(outcome, "credencial", `${name}: hay que volver a crear las de ${roles}`);
      }
    }
  }
}

/** A sensitive variable keeps its name and loses its value: the name is the useful half — it is
 * what a `{{token}}` in a path refers to — and the value is the half that must not be duplicated. */
export function withoutSecrets(variables: EnvironmentVariables): {
  variables: EnvironmentVariables;
  emptied: string[];
} {
  const emptied: string[] = [];
  const copied = Object.fromEntries(
    Object.entries(variables).map(([name, variable]) => {
      if (!variable.sensitive) return [name, variable];
      emptied.push(name);
      return [name, { initial: "", current: "", sensitive: true }];
    }),
  );
  return { variables: copied, emptied };
}

const skippedPush = (outcome: CopyOutcome, what: string, detail: string) => outcome.skipped.push({ what, detail });

/** Names are unique per project, so a copy into a project that already has one has to resolve the
 * collision rather than fail on it — and numbering is what a person would do. */
export function uniqueName(name: string, taken: Set<string>): string {
  const base = name.trim().slice(0, 110) || "Copiado";
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base} (${suffix})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${randomUUID().slice(0, 8)}`;
}
