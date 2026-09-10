import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { ConflictError, ForbiddenError, NotFoundError } from "@/shared/errors/domain-error";
import { atLeast, wouldOrphanOrganization } from "../../domain/model";
import { MEMBERSHIP_REPOSITORY, type MembershipRepositoryPort } from "../../domain/ports";

export class RemoveMemberCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly targetUserId: string,
    readonly actorId: string,
  ) {}
}

/** Removing yourself is allowed — that is "leave the organization" — as long as you are not the
 * last owner. Removing somebody else needs `admin` and a rank at least as high as theirs. */
@CommandHandler(RemoveMemberCommand)
export class RemoveMemberHandler implements ICommandHandler<RemoveMemberCommand, void> {
  constructor(@Inject(MEMBERSHIP_REPOSITORY) private readonly memberships: MembershipRepositoryPort) {}

  async execute(command: RemoveMemberCommand): Promise<void> {
    const actor = await this.memberships.find(command.organizationId, command.actorId);
    if (!actor) throw new ForbiddenError("No perteneces a esta organización");

    const target = await this.memberships.find(command.organizationId, command.targetUserId);
    if (!target) throw new NotFoundError("Esa persona no es miembro de la organización", "membership-not-found");

    const leaving = command.actorId === command.targetUserId;
    if (!leaving) {
      if (!atLeast(actor.role, "admin")) throw new ForbiddenError("No puedes gestionar miembros de esta organización");
      if (!atLeast(actor.role, target.role))
        throw new ForbiddenError("No puedes expulsar a alguien con un rol superior al tuyo", "role-escalation");
    }

    const all = await this.memberships.listForOrganization(command.organizationId);
    if (wouldOrphanOrganization(all, command.targetUserId, null)) {
      throw new ConflictError("La organización quedaría sin propietario", "last-owner");
    }

    await this.memberships.remove(command.organizationId, command.targetUserId);
  }
}
