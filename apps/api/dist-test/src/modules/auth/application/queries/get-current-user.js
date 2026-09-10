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
exports.GetCurrentUserHandler = exports.GetCurrentUserQuery = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const ports_1 = require("../../../iam/domain/ports");
const ports_2 = require("../../domain/ports");
class GetCurrentUserQuery {
    userId;
    constructor(userId) {
        this.userId = userId;
    }
}
exports.GetCurrentUserQuery = GetCurrentUserQuery;
/**
 * The read model the front end boots from: who you are and which organizations you can act in.
 *
 * A query and not a command, and it reads across two modules on purpose. The alternative —
 * duplicating memberships into the auth module so this handler stays inside one boundary — buys
 * a cleaner import graph and pays for it with two copies of the fact that decides every
 * authorization check in the system.
 */
let GetCurrentUserHandler = class GetCurrentUserHandler {
    users;
    memberships;
    organizations;
    constructor(users, memberships, organizations) {
        this.users = users;
        this.memberships = memberships;
        this.organizations = organizations;
    }
    async execute(query) {
        const user = await this.users.findById(query.userId);
        if (!user)
            throw new domain_error_1.NotFoundError("El usuario no existe", "user-not-found");
        const memberships = await this.memberships.listForUser(user.id);
        const organizations = await Promise.all(memberships.map(async (membership) => {
            const organization = await this.organizations.findById(membership.organizationId);
            return organization ? { id: organization.id, name: organization.name, slug: organization.slug, role: membership.role } : null;
        }));
        return {
            id: user.id,
            email: user.email,
            name: user.name,
            organizations: organizations.filter((organization) => organization !== null),
        };
    }
};
exports.GetCurrentUserHandler = GetCurrentUserHandler;
exports.GetCurrentUserHandler = GetCurrentUserHandler = __decorate([
    (0, cqrs_1.QueryHandler)(GetCurrentUserQuery),
    __param(0, (0, common_1.Inject)(ports_2.USER_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_1.MEMBERSHIP_REPOSITORY)),
    __param(2, (0, common_1.Inject)(ports_1.ORGANIZATION_REPOSITORY)),
    __metadata("design:paramtypes", [Object, Object, Object])
], GetCurrentUserHandler);
//# sourceMappingURL=get-current-user.js.map