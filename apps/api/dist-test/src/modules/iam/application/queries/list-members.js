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
exports.ListMembersHandler = exports.ListMembersQuery = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const ports_1 = require("../../../auth/domain/ports");
const ports_2 = require("../../domain/ports");
class ListMembersQuery {
    organizationId;
    constructor(organizationId) {
        this.organizationId = organizationId;
    }
}
exports.ListMembersQuery = ListMembersQuery;
let ListMembersHandler = class ListMembersHandler {
    memberships;
    invitations;
    users;
    constructor(memberships, invitations, users) {
        this.memberships = memberships;
        this.invitations = invitations;
        this.users = users;
    }
    async execute(query) {
        const memberships = await this.memberships.listForOrganization(query.organizationId);
        const members = await Promise.all(memberships.map(async (membership) => {
            const user = await this.users.findById(membership.userId);
            return user ? { userId: user.id, email: user.email, name: user.name, role: membership.role, since: membership.createdAt } : null;
        }));
        const invitations = (await this.invitations.listForOrganization(query.organizationId))
            .filter((invitation) => !invitation.acceptedAt && !invitation.revokedAt)
            // The token hash never leaves the repository: this view is what the members page renders,
            // and a pending invitation is a live credential until it is accepted.
            .map((invitation) => ({ id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt }));
        return { members: members.filter((member) => member !== null), invitations };
    }
};
exports.ListMembersHandler = ListMembersHandler;
exports.ListMembersHandler = ListMembersHandler = __decorate([
    (0, cqrs_1.QueryHandler)(ListMembersQuery),
    __param(0, (0, common_1.Inject)(ports_2.MEMBERSHIP_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.INVITATION_REPOSITORY)),
    __param(2, (0, common_1.Inject)(ports_1.USER_REPOSITORY)),
    __metadata("design:paramtypes", [Object, Object, Object])
], ListMembersHandler);
//# sourceMappingURL=list-members.js.map