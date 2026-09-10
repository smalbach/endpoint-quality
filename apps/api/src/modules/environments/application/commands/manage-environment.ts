import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { VARIABLE_NAME } from "@eq/runner-core";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import type { Environment } from "../../domain/model";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "../../domain/ports";

export type EnvironmentInput = {
  name?: string;
  baseUrl?: string;
  specUrl?: string | null;
  variables?: Record<string, string>;
  disabledVariables?: Record<string, string>;
  writesAllowed?: boolean;
  authEnforced?: boolean;
};

export class CreateEnvironmentCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: EnvironmentInput,
  ) {}
}
export class UpdateEnvironmentCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly environmentId: string,
    readonly input: EnvironmentInput,
  ) {}
}
export class DeleteEnvironmentCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly environmentId: string,
  ) {}
}

/** Loads an environment and refuses to admit it exists outside its project. Folded into the 404
 * for the same reason as everywhere else: a 403 would confirm the id is real. */
export async function ownedEnvironment(
  projects: ProjectRepositoryPort,
  environments: EnvironmentRepositoryPort,
  organizationId: string,
  projectId: string,
  environmentId: string,
): Promise<Environment> {
  await ownedProject(projects, organizationId, projectId);
  const environment = await environments.findById(environmentId);
  if (!environment || environment.projectId !== projectId)
    throw new NotFoundError("El entorno no existe", "environment-not-found");
  return environment;
}

/** A base URL has to be absolute and http(s). The SSRF guard checks the address at request time;
 * this rejects the shape at write time so the mistake surfaces where it was made. */
function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidInputError("La URL base no es válida", [
      { field: "baseUrl", detail: "Debe ser una URL absoluta" },
    ]);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new InvalidInputError("La URL base no es válida", [
      { field: "baseUrl", detail: "Solo se admiten http y https" },
    ]);
  }
  // Trailing slash removed once, here, so every path join downstream is `${baseUrl}${path}` and
  // nothing has to guess whether it will produce a double slash.
  return url.toString().replace(/\/+$/, "");
}

function normalizeVariables(value: Record<string, string>, field = "variables"): Record<string, string> {
  const entries = Object.entries(value);
  const invalid = entries.find(([key, item]) => !VARIABLE_NAME.test(key.trim()) || typeof item !== "string");
  if (invalid)
    throw new InvalidInputError("Las variables del entorno no son válidas", [
      { field: `${field}.${invalid[0]}`, detail: "Use un nombre válido y un valor de texto" },
    ]);
  return Object.fromEntries(entries.map(([key, item]) => [key.trim(), item]));
}

/**
 * The two maps together, and disjoint.
 *
 * A switched-off variable is parked next to the map instead of flagged inside it, so that
 * `variables` stays exactly what a run substitutes and nothing downstream has to filter. The one
 * rule that buys is this: a name is in one map or in the other. Both would have to mean one of
 * the two, and whichever the code happened to pick would be a coin flip nobody could see.
 */
function normalizeBoth(
  variables: Record<string, string>,
  disabled: Record<string, string>,
): { variables: Record<string, string>; disabledVariables: Record<string, string> } {
  const active = normalizeVariables(variables);
  const parked = normalizeVariables(disabled, "disabledVariables");
  const both = Object.keys(parked).find((name) => name in active);
  if (both)
    throw new InvalidInputError("Una variable está activa y apagada a la vez", [
      { field: `disabledVariables.${both}`, detail: "Ya hay una variable activa con ese nombre" },
    ]);
  return { variables: active, disabledVariables: parked };
}

@CommandHandler(CreateEnvironmentCommand)
export class CreateEnvironmentHandler implements ICommandHandler<CreateEnvironmentCommand, { environmentId: string }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: CreateEnvironmentCommand) {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    const name = (command.input.name ?? "").trim();
    if (!name) throw new InvalidInputError("El entorno necesita un nombre", [{ field: "name", detail: "Requerido" }]);
    if (await this.environments.findByName(project.id, name))
      throw new ConflictError("Ya hay un entorno con ese nombre", "environment-name-taken");

    const environment: Environment = {
      id: randomUUID(),
      projectId: project.id,
      name,
      baseUrl: normalizeBaseUrl(command.input.baseUrl ?? ""),
      specUrl: command.input.specUrl ?? null,
      ...normalizeBoth(command.input.variables ?? {}, command.input.disabledVariables ?? {}),
      // Both default to off. A run that writes to a target, and a matrix of 401 cases against a
      // backend that grants everything, are each a decision — not something inherited by
      // creating an environment.
      writesAllowed: command.input.writesAllowed ?? false,
      authEnforced: command.input.authEnforced ?? false,
      createdAt: this.clock.now(),
    };
    await this.environments.save(environment);
    return { environmentId: environment.id };
  }
}

@CommandHandler(UpdateEnvironmentCommand)
export class UpdateEnvironmentHandler implements ICommandHandler<UpdateEnvironmentCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
  ) {}

  async execute(command: UpdateEnvironmentCommand): Promise<void> {
    const environment = await ownedEnvironment(
      this.projects,
      this.environments,
      command.organizationId,
      command.projectId,
      command.environmentId,
    );
    const name = command.input.name?.trim();
    if (name && name !== environment.name && (await this.environments.findByName(environment.projectId, name))) {
      throw new ConflictError("Ya hay un entorno con ese nombre", "environment-name-taken");
    }
    await this.environments.save({
      ...environment,
      name: name || environment.name,
      baseUrl: command.input.baseUrl ? normalizeBaseUrl(command.input.baseUrl) : environment.baseUrl,
      specUrl: command.input.specUrl === undefined ? environment.specUrl : command.input.specUrl,
      // Both or neither: they are one editor, and patching only half of a pair that has to stay
      // disjoint is how a name ends up in both.
      ...normalizeBoth(
        command.input.variables ?? environment.variables,
        command.input.disabledVariables ?? environment.disabledVariables,
      ),
      writesAllowed: command.input.writesAllowed ?? environment.writesAllowed,
      authEnforced: command.input.authEnforced ?? environment.authEnforced,
    });
  }
}

@CommandHandler(DeleteEnvironmentCommand)
export class DeleteEnvironmentHandler implements ICommandHandler<DeleteEnvironmentCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
  ) {}

  async execute(command: DeleteEnvironmentCommand): Promise<void> {
    const environment = await ownedEnvironment(
      this.projects,
      this.environments,
      command.organizationId,
      command.projectId,
      command.environmentId,
    );
    // The credentials go with it, by the cascade in the migration. Deleting an environment and
    // leaving its stored secrets behind would be a set of credentials nothing can reach to
    // revoke.
    await this.environments.remove(environment.id);
  }
}
