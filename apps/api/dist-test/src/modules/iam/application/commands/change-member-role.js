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
exports.ChangeMemberRoleHandler = exports.ChangeMemberRoleCommand = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const model_1 = require("../../domain/model");
const ports_1 = require("../../domain/ports");
class ChangeMemberRoleCommand {
    organizationId;
    targetUserId;
    role;
    actorId;
    constructor(organizationId, targetUserId, role, actorId) {
        this.organizationId = organizationId;
        this.targetUserId = targetUserId;
        this.role = role;
        this.actorId = actorId;
    }
}
exports.ChangeMemberRoleCommand = ChangeMemberRoleCommand;
/**
 * Three rules, each closing a way to end up somewhere nobody can get out of:
 *
 * - the actor must be an `admin` or above, and cannot grant a role above their own — otherwise
 *   an admin promotes themselves to owner in one call;
 * - the actor cannot change their **own** role, which is the same escalation with an extra step;
 * - the last owner cannot be demoted, because an organization with no owner has nobody who can
 *   appoint one, and everything inside it becomes unreachable.
 */
let ChangeMemberRoleHandler = class ChangeMemberRoleHandler {
    memberships;
    constructor(memberships) {
        this.memberships = memberships;
    }
    async execute(command) {
        const actor = await this.memberships.find(command.organizationId, command.actorId);
        if (!actor || !(0, model_1.atLeast)(actor.role, "admin"))
            throw new domain_error_1.ForbiddenError("No puedes gestionar miembros de esta organización");
        if (command.actorId === command.targetUserId)
            throw new domain_error_1.ForbiddenError("No puedes cambiar tu propio rol", "self-role-change");
        if (!(0, model_1.atLeast)(actor.role, command.role))
            throw new domain_error_1.ForbiddenError("No puedes otorgar un rol superior al tuyo", "role-escalation");
        const target = await this.memberships.find(command.organizationId, command.targetUserId);
        if (!target)
            throw new domain_error_1.NotFoundError("Esa persona no es miembro de la organización", "membership-not-found");
        // An admin cannot demote an owner either: the ladder has to hold in both directions or the
        // rank above yours is only a label.
        if (!(0, model_1.atLeast)(actor.role, target.role))
            throw new domain_error_1.ForbiddenError("No puedes modificar a alguien con un rol superior al tuyo", "role-escalation");
        const all = await this.memberships.listForOrganization(command.organizationId);
        if ((0, model_1.wouldOrphanOrganization)(all, command.targetUserId, command.role)) {
            throw new domain_error_1.ConflictError("La organización quedaría sin propietario", "last-owner");
        }
        await this.memberships.save({ ...target, role: command.role });
    }
};
exports.ChangeMemberRoleHandler = ChangeMemberRoleHandler;
exports.ChangeMemberRoleHandler = ChangeMemberRoleHandler = __decorate([
    (0, cqrs_1.CommandHandler)(ChangeMemberRoleCommand),
    __param(0, (0, common_1.Inject)(ports_1.MEMBERSHIP_REPOSITORY)),
    __metadata("design:paramtypes", [Object])
], ChangeMemberRoleHandler);
//# sourceMappingURL=change-member-role.js.map