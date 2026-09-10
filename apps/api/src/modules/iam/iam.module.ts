import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { InvitationEntity, MembershipEntity, OrganizationEntity } from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { INVITATION_REPOSITORY, MEMBERSHIP_REPOSITORY, ORGANIZATION_REPOSITORY } from "./domain/ports";
import {
  TypeOrmInvitationRepository,
  TypeOrmMembershipRepository,
  TypeOrmOrganizationRepository,
} from "./infrastructure/persistence/typeorm-repositories";
import { CreateOrganizationHandler } from "./application/commands/create-organization";
import { InviteMemberHandler } from "./application/commands/invite-member";
import { AcceptInvitationHandler } from "./application/commands/accept-invitation";
import { ChangeMemberRoleHandler } from "./application/commands/change-member-role";
import { RemoveMemberHandler } from "./application/commands/remove-member";
import { ListMembersHandler } from "./application/queries/list-members";
import { OrganizationsController } from "./presentation/organizations.controller";

export const IAM_COMMAND_HANDLERS = [
  CreateOrganizationHandler,
  InviteMemberHandler,
  AcceptInvitationHandler,
  ChangeMemberRoleHandler,
  RemoveMemberHandler,
];
export const IAM_QUERY_HANDLERS = [ListMembersHandler];
export const IAM_ADAPTERS = [
  { provide: ORGANIZATION_REPOSITORY, useClass: TypeOrmOrganizationRepository },
  { provide: MEMBERSHIP_REPOSITORY, useClass: TypeOrmMembershipRepository },
  { provide: INVITATION_REPOSITORY, useClass: TypeOrmInvitationRepository },
];

/**
 * `forwardRef` because the two modules genuinely need each other: registration creates an
 * organization, and accepting an invitation reads the user it is addressed to. Splitting a
 * shared "identity" module out to break the cycle would move the coupling without removing it.
 */
@Module({
  imports: [
    CqrsModule,
    TypeOrmModule.forFeature([OrganizationEntity, MembershipEntity, InvitationEntity]),
    forwardRef(() => AuthModule),
  ],
  controllers: [OrganizationsController],
  providers: [...IAM_ADAPTERS, ...IAM_COMMAND_HANDLERS, ...IAM_QUERY_HANDLERS],
  exports: [ORGANIZATION_REPOSITORY, MEMBERSHIP_REPOSITORY, INVITATION_REPOSITORY],
})
export class IamModule {}
