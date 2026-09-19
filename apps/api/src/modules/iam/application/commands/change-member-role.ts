import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { ConflictError, ForbiddenError, NotFoundError } from "@/shared/errors/domain-error";
import { atLeast, wouldOrphanOrganization, type Role } from "../../domain/model";
import { MEMBERSHIP_REPOSITORY, type MembershipRepositoryPort } from "../../domain/ports";

export class ChangeMemberRoleCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly targetUserId: string,
    readonly role: Role,
    readonly actorId: string,
  ) {}
}

/**
 * Three rules, each closing a way to end up somewhere nobody can get out of:
 *
 * - the actor must be an `admin` or above, and cannot grant a role above their own — otherwise
 *   an admin promotes themselves to owner in one call;
 * - the actor cannot change their **own** role, which is the same escalation with an extra step;
 * - the last owner cannot be demoted, because an organization with no owner has nobody who can
 *   appoint one, and everything inside it becomes unreachable.
 */
@CommandHandler(ChangeMemberRoleCommand)
export class ChangeMemberRoleHandler implements ICommandHandler<ChangeMemberRoleCommand, void> {
  constructor(@Inject(MEMBERSHIP_REPOSITORY) private readonly memberships: MembershipRepositoryPort) {}

  async execute(command: ChangeMemberRoleCommand): Promise<void> {
    const actor = await this.memberships.find(command.organizationId, command.actorId);
    if (!actor || !atLeast(actor.role, "admin"))
      throw new ForbiddenError("No puedes gestionar miembros de esta organización");
    if (command.actorId === command.targetUserId)
      throw new ForbiddenError("No puedes cambiar tu propio rol", "self-role-change");
    if (!atLeast(actor.role, command.role))
      throw new ForbiddenError("No puedes otorgar un rol superior al tuyo", "role-escalation");

    const target = await this.memberships.find(command.organizationId, command.targetUserId);
    if (!target) throw new NotFoundError("Esa persona no es miembro de la organización", "membership-not-found");
    // An admin cannot demote an owner either: the ladder has to hold in both directions or the
    // rank above yours is only a label.
    if (!atLeast(actor.role, target.role))
      throw new ForbiddenError("No puedes modificar a alguien con un rol superior al tuyo", "role-escalation");

    const all = await this.memberships.listForOrganization(command.organizationId);
    if (wouldOrphanOrganization(all, command.targetUserId, command.role))
      // Unreachable while the two rules above hold: demoting an owner takes another owner, so there
      // are two. Kept as the guard that still holds if either rule is ever relaxed.
      /* node:coverage ignore next */
      throw new ConflictError("La organización quedaría sin propietario", "last-owner");

    await this.memberships.save({ ...target, role: command.role });
  }
}
