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
exports.AcceptInvitationHandler = exports.AcceptInvitationCommand = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const clock_port_1 = require("../../../../shared/clock/clock.port");
const opaque_token_1 = require("../../../../shared/crypto/opaque-token");
const ports_1 = require("../../../auth/domain/ports");
const model_1 = require("../../../auth/domain/model");
const ports_2 = require("../../domain/ports");
class AcceptInvitationCommand {
    token;
    userId;
    constructor(token, userId) {
        this.token = token;
        this.userId = userId;
    }
}
exports.AcceptInvitationCommand = AcceptInvitationCommand;
/**
 * Joins the signed-in user to the organization the invitation names.
 *
 * The invitation is bound to the **address it was sent to**, and the check is here rather than
 * in the UI. Otherwise an invitation link is a bearer token for a role: anyone it is forwarded
 * to, deliberately or by a mail rule, can accept it with their own account.
 *
 * An existing member is answered idempotently instead of with a conflict — the second click on
 * the same link is the most likely way this endpoint is ever called twice.
 */
let AcceptInvitationHandler = class AcceptInvitationHandler {
    invitations;
    memberships;
    users;
    clock;
    constructor(invitations, memberships, users, clock) {
        this.invitations = invitations;
        this.memberships = memberships;
        this.users = users;
        this.clock = clock;
    }
    async execute(command) {
        const now = this.clock.now();
        const invitation = await this.invitations.findByHash((0, opaque_token_1.hashOpaqueToken)(command.token));
        if (!invitation || invitation.revokedAt || invitation.acceptedAt)
            throw new domain_error_1.NotFoundError("La invitación no es válida", "invitation-invalid");
        if (invitation.expiresAt.getTime() <= now.getTime())
            throw new domain_error_1.NotFoundError("La invitación ha caducado", "invitation-expired");
        const user = await this.users.findById(command.userId);
        if (!user)
            throw new domain_error_1.NotFoundError("El usuario no existe", "user-not-found");
        if ((0, model_1.normalizeEmail)(user.email) !== invitation.email) {
            throw new domain_error_1.ForbiddenError("Esta invitación es para otra dirección de correo", "invitation-wrong-recipient");
        }
        const existing = await this.memberships.find(invitation.organizationId, user.id);
        if (!existing)
            await this.memberships.save({ organizationId: invitation.organizationId, userId: user.id, role: invitation.role, createdAt: now });
        await this.invitations.save({ ...invitation, acceptedAt: now });
        return { organizationId: invitation.organizationId };
    }
};
exports.AcceptInvitationHandler = AcceptInvitationHandler;
exports.AcceptInvitationHandler = AcceptInvitationHandler = __decorate([
    (0, cqrs_1.CommandHandler)(AcceptInvitationCommand),
    __param(0, (0, common_1.Inject)(ports_2.INVITATION_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.MEMBERSHIP_REPOSITORY)),
    __param(2, (0, common_1.Inject)(ports_1.USER_REPOSITORY)),
    __param(3, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __metadata("design:paramtypes", [Object, Object, Object, Object])
], AcceptInvitationHandler);
//# sourceMappingURL=accept-invitation.js.map