/**
 * Organizations, members and CI tokens.
 *
 * Every route below `:organizationId` carries `@RequireRole`, and the guard resolves the
 * caller's membership in *that* organization against the database. There is no route that reads
 * an organization id and trusts it — the id in the URL is a question, and membership is the
 * answer.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";

import { UnauthenticatedError } from "@/shared/errors/domain-error";
import { CurrentUser, OrgRoleGuard, RequireRole, type Principal } from "@/modules/auth/infrastructure/guards/auth.guard";
import { IssueApiTokenCommand } from "@/modules/auth/application/commands/issue-api-token";
import { RevokeApiTokenCommand } from "@/modules/auth/application/commands/revoke-api-token";
import { ListApiTokensQuery } from "@/modules/auth/application/queries/list-api-tokens";
import { CreateApiTokenDto } from "@/modules/auth/presentation/dto/auth.dto";
import { CreateOrganizationCommand } from "../application/commands/create-organization";
import { InviteMemberCommand } from "../application/commands/invite-member";
import { AcceptInvitationCommand } from "../application/commands/accept-invitation";
import { ChangeMemberRoleCommand } from "../application/commands/change-member-role";
import { RemoveMemberCommand } from "../application/commands/remove-member";
import { ListMembersQuery } from "../application/queries/list-members";
import { AcceptInvitationDto, ChangeRoleDto, CreateOrganizationDto, InviteMemberDto } from "./dto/iam.dto";

/** Only a person creates organizations, accepts invitations or manages members. A CI token that
 * could do any of those turns a leaked build secret into an account takeover. */
function requireUser(principal: Principal): string {
  if (principal.kind !== "user") throw new UnauthenticatedError("Esta operación requiere una sesión de usuario", "user-session-required");
  return principal.userId;
}

@Controller()
@UseGuards(OrgRoleGuard)
export class OrganizationsController {
  constructor(private readonly commandBus: CommandBus, private readonly queryBus: QueryBus) {}

  @Post("orgs")
  async create(@Body() body: CreateOrganizationDto, @CurrentUser() principal: Principal) {
    return this.commandBus.execute(new CreateOrganizationCommand(body.name, requireUser(principal)));
  }

  @Post("invitations/accept")
  @HttpCode(200)
  async accept(@Body() body: AcceptInvitationDto, @CurrentUser() principal: Principal) {
    return this.commandBus.execute(new AcceptInvitationCommand(body.token, requireUser(principal)));
  }

  @Get("orgs/:organizationId/members")
  @RequireRole("viewer")
  async members(@Param("organizationId") organizationId: string) {
    return this.queryBus.execute(new ListMembersQuery(organizationId));
  }

  @Post("orgs/:organizationId/invitations")
  @RequireRole("admin")
  async invite(@Param("organizationId") organizationId: string, @Body() body: InviteMemberDto, @CurrentUser() principal: Principal) {
    return this.commandBus.execute(new InviteMemberCommand(organizationId, body.email, body.role, requireUser(principal)));
  }

  @Patch("orgs/:organizationId/members/:userId")
  @RequireRole("admin")
  @HttpCode(204)
  async changeRole(
    @Param("organizationId") organizationId: string,
    @Param("userId") userId: string,
    @Body() body: ChangeRoleDto,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    await this.commandBus.execute(new ChangeMemberRoleCommand(organizationId, userId, body.role, requireUser(principal)));
  }

  // `viewer` and not `admin`: leaving an organization you were invited to must not require the
  // permission to manage the people in it. The handler distinguishes leaving from expelling.
  @Delete("orgs/:organizationId/members/:userId")
  @RequireRole("viewer")
  @HttpCode(204)
  async removeMember(@Param("organizationId") organizationId: string, @Param("userId") userId: string, @CurrentUser() principal: Principal): Promise<void> {
    await this.commandBus.execute(new RemoveMemberCommand(organizationId, userId, requireUser(principal)));
  }

  @Get("orgs/:organizationId/tokens")
  @RequireRole("admin")
  async listTokens(@Param("organizationId") organizationId: string) {
    return this.queryBus.execute(new ListApiTokensQuery(organizationId));
  }

  @Post("orgs/:organizationId/tokens")
  @RequireRole("admin")
  async createToken(@Param("organizationId") organizationId: string, @Body() body: CreateApiTokenDto, @CurrentUser() principal: Principal) {
    return this.commandBus.execute(new IssueApiTokenCommand(organizationId, body.name, requireUser(principal)));
  }

  @Delete("orgs/:organizationId/tokens/:tokenId")
  @RequireRole("admin")
  @HttpCode(204)
  async revokeToken(@Param("organizationId") organizationId: string, @Param("tokenId") tokenId: string): Promise<void> {
    await this.commandBus.execute(new RevokeApiTokenCommand(organizationId, tokenId));
  }
}
