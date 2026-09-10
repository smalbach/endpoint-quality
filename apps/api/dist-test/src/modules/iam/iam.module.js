"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IamModule = exports.IAM_ADAPTERS = exports.IAM_QUERY_HANDLERS = exports.IAM_COMMAND_HANDLERS = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const typeorm_1 = require("@nestjs/typeorm");
const entities_1 = require("../../shared/database/entities");
const auth_module_1 = require("../auth/auth.module");
const ports_1 = require("./domain/ports");
const typeorm_repositories_1 = require("./infrastructure/persistence/typeorm-repositories");
const create_organization_1 = require("./application/commands/create-organization");
const invite_member_1 = require("./application/commands/invite-member");
const accept_invitation_1 = require("./application/commands/accept-invitation");
const change_member_role_1 = require("./application/commands/change-member-role");
const remove_member_1 = require("./application/commands/remove-member");
const list_members_1 = require("./application/queries/list-members");
const organizations_controller_1 = require("./presentation/organizations.controller");
exports.IAM_COMMAND_HANDLERS = [create_organization_1.CreateOrganizationHandler, invite_member_1.InviteMemberHandler, accept_invitation_1.AcceptInvitationHandler, change_member_role_1.ChangeMemberRoleHandler, remove_member_1.RemoveMemberHandler];
exports.IAM_QUERY_HANDLERS = [list_members_1.ListMembersHandler];
exports.IAM_ADAPTERS = [
    { provide: ports_1.ORGANIZATION_REPOSITORY, useClass: typeorm_repositories_1.TypeOrmOrganizationRepository },
    { provide: ports_1.MEMBERSHIP_REPOSITORY, useClass: typeorm_repositories_1.TypeOrmMembershipRepository },
    { provide: ports_1.INVITATION_REPOSITORY, useClass: typeorm_repositories_1.TypeOrmInvitationRepository },
];
/**
 * `forwardRef` because the two modules genuinely need each other: registration creates an
 * organization, and accepting an invitation reads the user it is addressed to. Splitting a
 * shared "identity" module out to break the cycle would move the coupling without removing it.
 */
let IamModule = class IamModule {
};
exports.IamModule = IamModule;
exports.IamModule = IamModule = __decorate([
    (0, common_1.Module)({
        imports: [cqrs_1.CqrsModule, typeorm_1.TypeOrmModule.forFeature([entities_1.OrganizationEntity, entities_1.MembershipEntity, entities_1.InvitationEntity]), (0, common_1.forwardRef)(() => auth_module_1.AuthModule)],
        controllers: [organizations_controller_1.OrganizationsController],
        providers: [...exports.IAM_ADAPTERS, ...exports.IAM_COMMAND_HANDLERS, ...exports.IAM_QUERY_HANDLERS],
        exports: [ports_1.ORGANIZATION_REPOSITORY, ports_1.MEMBERSHIP_REPOSITORY, ports_1.INVITATION_REPOSITORY],
    })
], IamModule);
//# sourceMappingURL=iam.module.js.map