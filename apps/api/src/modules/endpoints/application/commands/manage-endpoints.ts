import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import type { Project } from "@/modules/projects/domain/model";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "@/modules/specs/domain/ports";
import {
  applyEndpointInput,
  blankEndpoint,
  endpointKey,
  endpointProblems,
  viewEndpoint,
  type Endpoint,
  type EndpointInput,
  type EndpointStatus,
  type EndpointView,
} from "../../domain/model";
import { ENDPOINT_REPOSITORY, type EndpointRepositoryPort } from "../../domain/ports";
import { contractKeysOf } from "../queries/list-endpoints";

/** A project whose endpoints can still change. An archived one is read-only until restored. */
export async function writableProject(
  projects: ProjectRepositoryPort,
  organizationId: string,
  projectId: string,
): Promise<Project> {
  const project = await ownedProject(projects, organizationId, projectId);
  if (project.archivedAt) throw new ConflictError("El proyecto está archivado", "project-archived");
  return project;
}

/** 409 when another live endpoint of the project already is this method and path. */
export async function assertUnique(
  endpoints: EndpointRepositoryPort,
  projectId: string,
  candidate: Pick<Endpoint, "id" | "method" | "path">,
): Promise<void> {
  const key = endpointKey(candidate.method, candidate.path);
  const clash = (await endpoints.listAll(projectId)).find(
    (row) => row.id !== candidate.id && endpointKey(row.method, row.path) === key,
  );
  if (clash) throw new ConflictError(`Ya hay un endpoint ${clash.method} ${clash.path}`, "endpoint-duplicate");
}

export class CreateEndpointCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: EndpointInput,
    readonly actorId: string,
  ) {}
}

@CommandHandler(CreateEndpointCommand)
export class CreateEndpointHandler implements ICommandHandler<CreateEndpointCommand, EndpointView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: CreateEndpointCommand): Promise<EndpointView> {
    const problems = endpointProblems(command.input);
    if (command.input.path === undefined) problems.push({ field: "path", detail: "Falta la ruta" });
    if (problems.length) throw new InvalidInputError("El endpoint no es válido", problems);

    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const endpoint = applyEndpointInput(
      blankEndpoint({
        id: randomUUID(),
        projectId: project.id,
        origin: "manual",
        orderIndex: await this.endpoints.nextOrderIndex(project.id),
        now: this.clock.now(),
        actorId: command.actorId,
      }),
      command.input,
    );
    await assertUnique(this.endpoints, project.id, endpoint);
    await this.endpoints.save(endpoint);
    return viewEndpoint(endpoint, await contractKeysOf(this.specs, project));
  }
}

export class UpdateEndpointCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly endpointId: string,
    readonly input: EndpointInput,
    readonly actorId: string,
  ) {}
}

@CommandHandler(UpdateEndpointCommand)
export class UpdateEndpointHandler implements ICommandHandler<UpdateEndpointCommand, EndpointView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: UpdateEndpointCommand): Promise<EndpointView> {
    const problems = endpointProblems(command.input);
    if (problems.length) throw new InvalidInputError("El endpoint no es válido", problems);

    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const current = await this.endpoints.findById(project.id, command.endpointId);
    if (!current) throw new NotFoundError("El endpoint no existe", "endpoint-not-found");

    const next: Endpoint = {
      ...applyEndpointInput(current, command.input),
      updatedAt: this.clock.now(),
      updatedBy: command.actorId,
    };
    if (next.method !== current.method || next.path !== current.path)
      await assertUnique(this.endpoints, project.id, next);
    await this.endpoints.save(next);
    return viewEndpoint(next, await contractKeysOf(this.specs, project));
  }
}

export class DeleteEndpointsCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly endpointIds: string[],
    /** A single delete answers 404 for an id that is not there; a bulk one reports how many went. */
    readonly single: boolean,
    /** El definitivo, y solo sobre lo que ya está en la papelera. */
    readonly purge = false,
  ) {}
}

/** Devolver a la lista lo que está en la papelera. */
export class RestoreEndpointsCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly endpointIds: string[],
    readonly single: boolean,
  ) {}
}

@CommandHandler(DeleteEndpointsCommand)
export class DeleteEndpointsHandler implements ICommandHandler<DeleteEndpointsCommand, { deleted: number }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: DeleteEndpointsCommand): Promise<{ deleted: number }> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const ids = [...new Set(command.endpointIds)];
    const deleted = command.purge
      ? await this.endpoints.purge(project.id, ids)
      : await this.endpoints.softDelete(project.id, ids, this.clock.now());
    if (command.single && deleted === 0) throw new NotFoundError("El endpoint no existe", "endpoint-not-found");
    return { deleted };
  }
}

/**
 * Restaurar endpoints de la papelera.
 *
 * El índice único de método y ruta es parcial —solo cuenta lo vivo—, así que mientras uno estaba
 * fuera alguien pudo crear otro `GET /users`. Eso es un 409: dos filas iguales en la lista no son
 * una restauración, son un problema nuevo.
 */
@CommandHandler(RestoreEndpointsCommand)
export class RestoreEndpointsHandler implements ICommandHandler<RestoreEndpointsCommand, { restored: number }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: RestoreEndpointsCommand): Promise<{ restored: number }> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const ids = [...new Set(command.endpointIds)];
    const live = await this.endpoints.listAll(project.id);
    const taken = new Set(live.map((row) => endpointKey(row.method, row.path)));
    const trashed = (
      await this.endpoints.list(project.id, {
        status: "all",
        search: "",
        deleted: true,
        offset: 0,
        limit: ids.length || 1,
      })
    ).rows.filter((row) => ids.includes(row.id));
    const clash = trashed.find((row) => taken.has(endpointKey(row.method, row.path)));
    if (clash)
      throw new ConflictError(
        `Ya hay un endpoint ${clash.method} ${clash.path} en el proyecto`,
        "endpoint-duplicate",
      );

    const restored = await this.endpoints.restore(project.id, ids, this.clock.now());
    if (command.single && restored === 0) throw new NotFoundError("El endpoint no existe", "endpoint-not-found");
    return { restored };
  }
}

export class SetEndpointStatusCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly endpointIds: string[],
    readonly status: EndpointStatus,
    readonly actorId: string,
  ) {}
}

@CommandHandler(SetEndpointStatusCommand)
export class SetEndpointStatusHandler implements ICommandHandler<SetEndpointStatusCommand, { updated: number }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: SetEndpointStatusCommand): Promise<{ updated: number }> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const updated = await this.endpoints.setStatus(
      project.id,
      [...new Set(command.endpointIds)],
      command.status,
      this.clock.now(),
      command.actorId,
    );
    return { updated };
  }
}

/** The keys already taken in a project, for importers that must not duplicate. */
export async function takenKeys(endpoints: EndpointRepositoryPort, projectId: string): Promise<Map<string, Endpoint>> {
  return new Map((await endpoints.listAll(projectId)).map((row) => [endpointKey(row.method, row.path), row]));
}
