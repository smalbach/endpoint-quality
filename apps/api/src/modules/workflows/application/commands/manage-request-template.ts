import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import { safeParseRequestTemplate, type RequestBody, type ScenarioAuth } from "@eq/runner-core";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import type { RequestTemplateRow } from "../../domain/model";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "../../domain/ports";

export type RequestTemplateInput = {
  name?: string;
  operationId?: string;
  description?: string | null;
  expectedStatus?: number;
  parameters?: Record<string, string>;
  disabledParameters?: Record<string, string>;
  headers?: Record<string, string>;
  disabledHeaders?: Record<string, string>;
  body?: RequestBody;
  auth?: ScenarioAuth;
};

export class CreateRequestTemplateCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: RequestTemplateInput,
    readonly actorId: string,
  ) {}
}
export class UpdateRequestTemplateCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly templateId: string,
    readonly input: RequestTemplateInput,
    readonly actorId: string,
  ) {}
}
export class DeleteRequestTemplateCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly templateId: string,
  ) {}
}

/** Folded into the 404 like everywhere else: a 403 here would confirm the id is real. */
async function ownedTemplate(
  projects: ProjectRepositoryPort,
  workflows: WorkflowRepositoryPort,
  organizationId: string,
  projectId: string,
  templateId: string,
): Promise<RequestTemplateRow> {
  await ownedProject(projects, organizationId, projectId);
  const template = await workflows.findTemplate(projectId, templateId);
  if (!template) throw new NotFoundError("La prueba no existe", "request-template-not-found");
  return template;
}

/**
 * The shape is checked by the engine's zod schema and not by a DTO.
 *
 * The rule about what a request may say belongs next to the code that will send it; a second,
 * weaker copy of it in a decorator is how the two end up disagreeing.
 *
 * `undefined` leaves a field as it was, which is what makes a PATCH that omits `body` keep the
 * payload somebody wrote. Clearing one is `{ type: "none" }` and not `null`: «sin cuerpo» is a
 * value the column holds, so there is one way to say it rather than two that can drift apart.
 */
type TemplateFields = {
  name: string;
  operationId: string;
  description: string | null;
  expectedStatus: number;
  parameters: Record<string, string>;
  disabledParameters: Record<string, string>;
  headers: Record<string, string>;
  disabledHeaders: Record<string, string>;
  body: RequestBody;
  auth: ScenarioAuth;
};

function validated(input: RequestTemplateInput, previous?: RequestTemplateRow): TemplateFields {
  const fields: TemplateFields = {
    name: (input.name ?? previous?.name ?? "").trim(),
    operationId: input.operationId ?? previous?.operationId ?? "",
    description: input.description === undefined ? (previous?.description ?? null) : input.description || null,
    expectedStatus: input.expectedStatus ?? previous?.expectedStatus ?? 0,
    parameters: input.parameters ?? previous?.parameters ?? {},
    disabledParameters: input.disabledParameters ?? previous?.disabledParameters ?? {},
    headers: input.headers ?? previous?.headers ?? {},
    disabledHeaders: input.disabledHeaders ?? previous?.disabledHeaders ?? {},
    body: input.body ?? previous?.body ?? { type: "none" },
    auth: input.auth ?? previous?.auth ?? "default",
  };
  // The same name on both sides of the switch would make «se envía» depend on which map a reader
  // happened to look at first. Refused rather than resolved: the editor never produces it, so a
  // request that carries it came from somewhere that has already lost track of what it means.
  for (const [enabled, disabled, what] of [
    [fields.parameters, fields.disabledParameters, "parámetro"],
    [fields.headers, fields.disabledHeaders, "cabecera"],
  ] as const) {
    const both = Object.keys(enabled).filter((name) => name in disabled);
    if (both.length) {
      throw new InvalidInputError(
        `Hay un ${what} encendido y apagado a la vez: ${both.join(", ")}`,
        both.map((name) => ({ field: what === "parámetro" ? "parameters" : "headers", detail: name })),
        "request-template-invalid",
      );
    }
  }

  const parsed = safeParseRequestTemplate({
    name: fields.name,
    operationId: fields.operationId,
    ...(fields.description ? { description: fields.description } : {}),
    expectedStatus: fields.expectedStatus,
    parameters: fields.parameters,
    disabledParameters: fields.disabledParameters,
    headers: fields.headers,
    disabledHeaders: fields.disabledHeaders,
    body: fields.body,
    auth: fields.auth,
  });
  if (!parsed.ok) throw new InvalidInputError("La prueba no es válida", parsed.issues, "request-template-invalid");
  return fields;
}

@CommandHandler(CreateRequestTemplateCommand)
export class CreateRequestTemplateHandler implements ICommandHandler<
  CreateRequestTemplateCommand,
  { requestTemplateId: string }
> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: CreateRequestTemplateCommand): Promise<{ requestTemplateId: string }> {
    await ownedProject(this.projects, command.organizationId, command.projectId);
    const fields = validated(command.input);
    if (await this.workflows.findTemplateByName(command.projectId, fields.name)) {
      throw new ConflictError("Ya existe una prueba con ese nombre", "request-template-name-taken");
    }
    const now = this.clock.now();
    const requestTemplateId = randomUUID();
    await this.workflows.saveTemplate({
      ...fields,
      id: requestTemplateId,
      projectId: command.projectId,
      createdAt: now,
      updatedAt: now,
      updatedBy: command.actorId,
    });
    return { requestTemplateId };
  }
}

@CommandHandler(UpdateRequestTemplateCommand)
export class UpdateRequestTemplateHandler implements ICommandHandler<UpdateRequestTemplateCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: UpdateRequestTemplateCommand): Promise<void> {
    const previous = await ownedTemplate(
      this.projects,
      this.workflows,
      command.organizationId,
      command.projectId,
      command.templateId,
    );
    const fields = validated(command.input, previous);
    const clash = await this.workflows.findTemplateByName(command.projectId, fields.name);
    if (clash && clash.id !== previous.id) {
      throw new ConflictError("Ya existe una prueba con ese nombre", "request-template-name-taken");
    }
    await this.workflows.saveTemplate({
      ...fields,
      id: previous.id,
      projectId: previous.projectId,
      createdAt: previous.createdAt,
      updatedAt: this.clock.now(),
      updatedBy: command.actorId,
    });
  }
}

@CommandHandler(DeleteRequestTemplateCommand)
export class DeleteRequestTemplateHandler implements ICommandHandler<DeleteRequestTemplateCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
  ) {}

  async execute(command: DeleteRequestTemplateCommand): Promise<void> {
    const template = await ownedTemplate(
      this.projects,
      this.workflows,
      command.organizationId,
      command.projectId,
      command.templateId,
    );
    // No foreign key can say this: the reference lives inside a jsonb document. Refusing is the
    // point — a flow whose step names a template that is gone fails at execution time, which is
    // hours later and somewhere else.
    if (await this.workflows.isTemplateReferenced(command.projectId, template.id)) {
      throw new ConflictError("La prueba se usa en algún flujo", "request-template-in-use");
    }
    await this.workflows.deleteTemplate(command.projectId, template.id);
  }
}
