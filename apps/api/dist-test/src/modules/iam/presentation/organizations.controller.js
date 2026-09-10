"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrganizationsController = void 0;
/**
 * Organizations, members and CI tokens.
 *
 * Every route below `:organizationId` carries `@RequireRole`, and the guard resolves the
 * caller's membership in *that* organization against the database. There is no route that reads
 * an organization id and trusts it — the id in the URL is a question, and membership is the
 * answer.
 */
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../shared/errors/domain-error");
const auth_guard_1 = require("../../auth/infrastructure/guards/auth.guard");
const issue_api_token_1 = require("../../auth/application/commands/issue-api-token");
const revoke_api_token_1 = require("../../auth/application/commands/revoke-api-token");
const list_api_tokens_1 = require("../../auth/application/queries/list-api-tokens");
const auth_dto_1 = require("../../auth/presentation/dto/auth.dto");
const create_organization_1 = require("../application/commands/create-organization");
const invite_member_1 = require("../application/commands/invite-member");
const accept_invitation_1 = require("../application/commands/accept-invitation");
const change_member_role_1 = require("../application/commands/change-member-role");
const remove_member_1 = require("../application/commands/remove-member");
const list_members_1 = require("../application/queries/list-members");
const iam_dto_1 = require("./dto/iam.dto");
/** Only a person creates organizations, accepts invitations or manages members. A CI token that
 * could do any of those turns a leaked build secret into an account takeover. */
function requireUser(principal) {
    if (principal.kind !== "user")
        throw new domain_error_1.UnauthenticatedError("Esta operación requiere una sesión de usuario", "user-session-required");
    return principal.userId;
}
let OrganizationsController = class OrganizationsController {
    commandBus;
    queryBus;
    constructor(commandBus, queryBus) {
        this.commandBus = commandBus;
        this.queryBus = queryBus;
    }
    async create(body, principal) {
        return this.commandBus.execute(new create_organization_1.CreateOrganizationCommand(body.name, requireUser(principal)));
    }
    async accept(body, principal) {
        return this.commandBus.execute(new accept_invitation_1.AcceptInvitationCommand(body.token, requireUser(principal)));
    }
    async members(organizationId) {
        return this.queryBus.execute(new list_members_1.ListMembersQuery(organizationId));
    }
    async invite(organizationId, body, principal) {
        return this.commandBus.execute(new invite_member_1.InviteMemberCommand(organizationId, body.email, body.role, requireUser(principal)));
    }
    async changeRole(organizationId, userId, body, principal) {
        await this.commandBus.execute(new change_member_role_1.ChangeMemberRoleCommand(organizationId, userId, body.role, requireUser(principal)));
    }
    // `viewer` and not `admin`: leaving an organization you were invited to must not require the
    // permission to manage the people in it. The handler distinguishes leaving from expelling.
    async removeMember(organizationId, userId, principal) {
        await this.commandBus.execute(new remove_member_1.RemoveMemberCommand(organizationId, userId, requireUser(principal)));
    }
    async listTokens(organizationId) {
        return this.queryBus.execute(new list_api_tokens_1.ListApiTokensQuery(organizationId));
    }
    async createToken(organizationId, body, principal) {
        return this.commandBus.execute(new issue_api_token_1.IssueApiTokenCommand(organizationId, body.name, requireUser(principal)));
    }
    async revokeToken(organizationId, tokenId) {
        await this.commandBus.execute(new revoke_api_token_1.RevokeApiTokenCommand(organizationId, tokenId));
    }
};
exports.OrganizationsController = OrganizationsController;
__decorate([
    (0, common_1.Post)("orgs"),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, auth_guard_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [iam_dto_1.CreateOrganizationDto, Object]),
    __metadata("design:returntype", Promise)
], OrganizationsController.prototype, "create", null);
__decorate([
    (0, common_1.Post)("invitations/accept"),
    (0, common_1.HttpCode)(200),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, auth_guard_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [iam_dto_1.AcceptInvitationDto, Object]),
    __metadata("design:returntype", Promise)
], OrganizationsController.prototype, "accept", null);
__decorate([
    (0, common_1.Get)("orgs/:organizationId/members"),
    (0, auth_guard_1.RequireRole)("viewer"),
    __param(0, (0, common_1.Param)("organizationId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], OrganizationsController.prototype, "members", null);
__decorate([
    (0, common_1.Post)("orgs/:organizationId/invitations"),
    (0, auth_guard_1.RequireRole)("admin"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, auth_guard_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, iam_dto_1.InviteMemberDto, Object]),
    __metadata("design:returntype", Promise)
], OrganizationsController.prototype, "invite", null);
__decorate([
    (0, common_1.Patch)("orgs/:organizationId/members/:userId"),
    (0, auth_guard_1.RequireRole)("admin"),
    (0, common_1.HttpCode)(204),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("userId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, auth_guard_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, iam_dto_1.ChangeRoleDto, Object]),
    __metadata("design:returntype", Promise)
], OrganizationsController.prototype, "changeRole", null);
__decorate([
    (0, common_1.Delete)("orgs/:organizationId/members/:userId"),
    (0, auth_guard_1.RequireRole)("viewer"),
    (0, common_1.HttpCode)(204),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("userId")),
    __param(2, (0, auth_guard_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], OrganizationsController.prototype, "removeMember", null);
__decorate([
    (0, common_1.Get)("orgs/:organizationId/tokens"),
    (0, auth_guard_1.RequireRole)("admin"),
    __param(0, (0, common_1.Param)("organizationId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], OrganizationsController.prototype, "listTokens", null);
__decorate([
    (0, common_1.Post)("orgs/:organizationId/tokens"),
    (0, auth_guard_1.RequireRole)("admin"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, auth_guard_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, auth_dto_1.CreateApiTokenDto, Object]),
    __metadata("design:returntype", Promise)
], OrganizationsController.prototype, "createToken", null);
__decorate([
    (0, common_1.Delete)("orgs/:organizationId/tokens/:tokenId"),
    (0, auth_guard_1.RequireRole)("admin"),
    (0, common_1.HttpCode)(204),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("tokenId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], OrganizationsController.prototype, "revokeToken", null);
exports.OrganizationsController = OrganizationsController = __decorate([
    (0, common_1.Controller)(),
    (0, common_1.UseGuards)(auth_guard_1.OrgRoleGuard),
    __metadata("design:paramtypes", [cqrs_1.CommandBus, cqrs_1.QueryBus])
], OrganizationsController);
//# sourceMappingURL=organizations.controller.js.map