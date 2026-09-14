import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { writableProject } from "@/modules/endpoints/application/commands/manage-endpoints";
import { ENDPOINT_REPOSITORY, type EndpointRepositoryPort } from "@/modules/endpoints/domain/ports";
import { CONFIG_REPOSITORY, type ConfigRepositoryPort } from "@/modules/config/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import { ROLE_COLORS, roleProblems, type Role, type RoleInput } from "../../domain/model";
import { ROLE_REPOSITORY, type RoleRepositoryPort } from "../../domain/ports";
import { syncAccessSection } from "../sync-access";

export class CreateRoleCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: RoleInput,
    readonly actorId: string,
  ) {}
}
export class UpdateRoleCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly roleId: string,
    readonly input: RoleInput,
    readonly actorId: string,
  ) {}
}
export class DeleteRoleCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly roleId: string,
    readonly actorId: string,
  ) {}
}

export async function ownedRole(roles: RoleRepositoryPort, projectId: string, roleId: string): Promise<Role> {
  const role = await roles.findById(projectId, roleId);
  if (!role) throw new NotFoundError("El rol no existe", "role-not-found");
  return role;
}

function assertValid(input: RoleInput, creating: boolean) {
  const problems = roleProblems(input, creating);
  if (problems.length) throw new InvalidInputError("El rol no es válido", problems);
}

/** Names compare exactly, the way a credential matches one: `Admin` and `admin` are two roles. */
async function assertFreeName(roles: RoleRepositoryPort, projectId: string, name: string, except?: string) {
  const clash = (await roles.list(projectId)).find((role) => role.name === name && role.id !== except);
  if (clash) throw new ConflictError(`Ya hay un rol «${name}» en este proyecto`, "role-name-taken");
}

abstract class RoleCommandBase {
  constructor(
    readonly projects: ProjectRepositoryPort,
    readonly roles: RoleRepositoryPort,
    readonly endpoints: EndpointRepositoryPort,
    readonly config: ConfigRepositoryPort,
    readonly environments: EnvironmentRepositoryPort,
    readonly clock: ClockPort,
  ) {}

  protected sync(projectId: string, actorId: string, renamed?: Record<string, string>) {
    return syncAccessSection(
      { roles: this.roles, endpoints: this.endpoints, config: this.config, clock: this.clock },
      projectId,
      actorId,
      renamed,
    );
  }
}

@CommandHandler(CreateRoleCommand)
export class CreateRoleHandler extends RoleCommandBase implements ICommandHandler<CreateRoleCommand, Role> {
  constructor(
    @Inject(PROJECT_REPOSITORY) projects: ProjectRepositoryPort,
    @Inject(ROLE_REPOSITORY) roles: RoleRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) endpoints: EndpointRepositoryPort,
    @Inject(CONFIG_REPOSITORY) config: ConfigRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) environments: EnvironmentRepositoryPort,
    @Inject(CLOCK) clock: ClockPort,
  ) {
    super(projects, roles, endpoints, config, environments, clock);
  }

  async execute(command: CreateRoleCommand): Promise<Role> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    assertValid(command.input, true);
    const name = command.input.name!.trim();
    await assertFreeName(this.roles, project.id, name);
    const existing = await this.roles.list(project.id);
    const now = this.clock.now();
    const role: Role = {
      id: randomUUID(),
      projectId: project.id,
      name,
      description: command.input.description?.trim() ?? "",
      // The next colour of the palette, so three roles created in a row are three colours.
      color: command.input.color ?? ROLE_COLORS[existing.length % ROLE_COLORS.length],
      sameRoleDataIsolation: command.input.sameRoleDataIsolation ?? false,
      position: existing.reduce((max, role) => Math.max(max, role.position + 1), 0),
      createdAt: now,
      updatedAt: now,
    };
    await this.roles.save(role);
    await this.sync(project.id, command.actorId);
    return role;
  }
}

/**
 * Renaming a role renames what refers to it by name: the credentials of every environment of the
 * project, and the rules of the `access` section. Leaving them would be a role whose credentials
 * silently stopped being found by the matrix.
 */
@CommandHandler(UpdateRoleCommand)
export class UpdateRoleHandler extends RoleCommandBase implements ICommandHandler<UpdateRoleCommand, Role> {
  constructor(
    @Inject(PROJECT_REPOSITORY) projects: ProjectRepositoryPort,
    @Inject(ROLE_REPOSITORY) roles: RoleRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) endpoints: EndpointRepositoryPort,
    @Inject(CONFIG_REPOSITORY) config: ConfigRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) environments: EnvironmentRepositoryPort,
    @Inject(CLOCK) clock: ClockPort,
  ) {
    super(projects, roles, endpoints, config, environments, clock);
  }

  async execute(command: UpdateRoleCommand): Promise<Role> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const role = await ownedRole(this.roles, project.id, command.roleId);
    assertValid(command.input, false);
    const name = command.input.name?.trim() ?? role.name;
    if (name !== role.name) await assertFreeName(this.roles, project.id, name, role.id);

    const updated: Role = {
      ...role,
      name,
      description: command.input.description === undefined ? role.description : command.input.description.trim(),
      color: command.input.color ?? role.color,
      sameRoleDataIsolation: command.input.sameRoleDataIsolation ?? role.sameRoleDataIsolation,
      updatedAt: this.clock.now(),
    };
    await this.roles.save(updated);

    if (name !== role.name) {
      for (const environment of await this.environments.listForProject(project.id)) {
        const credential = await this.environments.findCredential(environment.id, role.name);
        // An environment that already holds a credential under the new name keeps it; the old one
        // stays where it was rather than overwriting a secret somebody stored on purpose.
        if (!credential || (await this.environments.findCredential(environment.id, name))) continue;
        await this.environments.saveCredential({ ...credential, role: name, updatedAt: this.clock.now() });
        await this.environments.removeCredential(environment.id, role.name);
      }
    }
    await this.sync(project.id, command.actorId, name !== role.name ? { [role.name]: name } : {});
    return updated;
  }
}

/** `admin`, because it also deletes the credentials stored for the role in every environment. */
@CommandHandler(DeleteRoleCommand)
export class DeleteRoleHandler extends RoleCommandBase implements ICommandHandler<DeleteRoleCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) projects: ProjectRepositoryPort,
    @Inject(ROLE_REPOSITORY) roles: RoleRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) endpoints: EndpointRepositoryPort,
    @Inject(CONFIG_REPOSITORY) config: ConfigRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) environments: EnvironmentRepositoryPort,
    @Inject(CLOCK) clock: ClockPort,
  ) {
    super(projects, roles, endpoints, config, environments, clock);
  }

  async execute(command: DeleteRoleCommand): Promise<void> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const role = await ownedRole(this.roles, project.id, command.roleId);
    await this.roles.remove(project.id, role.id);
    // A credential for a role that no longer exists is a secret nothing will ever present, and
    // nothing on screen would list it to be revoked.
    for (const environment of await this.environments.listForProject(project.id))
      await this.environments.removeCredential(environment.id, role.name);
    await this.sync(project.id, command.actorId);
  }
}
