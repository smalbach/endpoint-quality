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
exports.RemoveMemberHandler = exports.RemoveMemberCommand = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const model_1 = require("../../domain/model");
const ports_1 = require("../../domain/ports");
class RemoveMemberCommand {
    organizationId;
    targetUserId;
    actorId;
    constructor(organizationId, targetUserId, actorId) {
        this.organizationId = organizationId;
        this.targetUserId = targetUserId;
        this.actorId = actorId;
    }
}
exports.RemoveMemberCommand = RemoveMemberCommand;
/** Removing yourself is allowed — that is "leave the organization" — as long as you are not the
 * last owner. Removing somebody else needs `admin` and a rank at least as high as theirs. */
let RemoveMemberHandler = class RemoveMemberHandler {
    memberships;
    constructor(memberships) {
        this.memberships = memberships;
    }
    async execute(command) {
        const actor = await this.memberships.find(command.organizationId, command.actorId);
        if (!actor)
            throw new domain_error_1.ForbiddenError("No perteneces a esta organización");
        const target = await this.memberships.find(command.organizationId, command.targetUserId);
        if (!target)
            throw new domain_error_1.NotFoundError("Esa persona no es miembro de la organización", "membership-not-found");
        const leaving = command.actorId === command.targetUserId;
        if (!leaving) {
            if (!(0, model_1.atLeast)(actor.role, "admin"))
                throw new domain_error_1.ForbiddenError("No puedes gestionar miembros de esta organización");
            if (!(0, model_1.atLeast)(actor.role, target.role))
                throw new domain_error_1.ForbiddenError("No puedes expulsar a alguien con un rol superior al tuyo", "role-escalation");
        }
        const all = await this.memberships.listForOrganization(command.organizationId);
        if ((0, model_1.wouldOrphanOrganization)(all, command.targetUserId, null)) {
            throw new domain_error_1.ConflictError("La organización quedaría sin propietario", "last-owner");
        }
        await this.memberships.remove(command.organizationId, command.targetUserId);
    }
};
exports.RemoveMemberHandler = RemoveMemberHandler;
exports.RemoveMemberHandler = RemoveMemberHandler = __decorate([
    (0, cqrs_1.CommandHandler)(RemoveMemberCommand),
    __param(0, (0, common_1.Inject)(ports_1.MEMBERSHIP_REPOSITORY)),
    __metadata("design:paramtypes", [Object])
], RemoveMemberHandler);
//# sourceMappingURL=remove-member.js.map