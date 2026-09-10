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
exports.InviteMemberHandler = exports.InviteMemberCommand = void 0;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const clock_port_1 = require("../../../../shared/clock/clock.port");
const opaque_token_1 = require("../../../../shared/crypto/opaque-token");
const model_1 = require("../../domain/model");
const ports_1 = require("../../domain/ports");
class InviteMemberCommand {
    organizationId;
    email;
    role;
    invitedBy;
    constructor(organizationId, email, role, invitedBy) {
        this.organizationId = organizationId;
        this.email = email;
        this.role = role;
        this.invitedBy = invitedBy;
    }
}
exports.InviteMemberCommand = InviteMemberCommand;
const INVITATION_TTL_DAYS = 7;
/**
 * Invites somebody, at a role the inviter is allowed to grant.
 *
 * **Nobody can invite above their own level.** Without that rule an `admin` invites a new
 * `owner`, and then either accepts the invitation themselves or asks the invitee for the link:
 * a one-step privilege escalation dressed as an ordinary feature.
 *
 * The token is returned so the caller can deliver it. Sending mail is not this handler's job and
 * is not P1's; what matters now is that only its hash is stored, so the invitation link cannot
 * be recovered from the database by an operator either.
 */
let InviteMemberHandler = class InviteMemberHandler {
    invitations;
    memberships;
    clock;
    constructor(invitations, memberships, clock) {
        this.invitations = invitations;
        this.memberships = memberships;
        this.clock = clock;
    }
    async execute(command) {
        const inviter = await this.memberships.find(command.organizationId, command.invitedBy);
        if (!inviter || !(0, model_1.atLeast)(inviter.role, "admin"))
            throw new domain_error_1.ForbiddenError("No puedes invitar a esta organización");
        if (!(0, model_1.atLeast)(inviter.role, command.role))
            throw new domain_error_1.ForbiddenError("No puedes invitar con un rol superior al tuyo", "role-escalation");
        const email = command.email.trim().toLowerCase();
        if (await this.invitations.findPending(command.organizationId, email)) {
            throw new domain_error_1.ConflictError("Esa dirección ya tiene una invitación pendiente", "invitation-pending");
        }
        const now = this.clock.now();
        const token = (0, opaque_token_1.generateOpaqueToken)();
        const invitation = {
            id: (0, node_crypto_1.randomUUID)(),
            organizationId: command.organizationId,
            email,
            role: command.role,
            tokenHash: (0, opaque_token_1.hashOpaqueToken)(token),
            invitedBy: command.invitedBy,
            createdAt: now,
            expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
            acceptedAt: null,
            revokedAt: null,
        };
        await this.invitations.save(invitation);
        return { invitationId: invitation.id, token, expiresAt: invitation.expiresAt };
    }
};
exports.InviteMemberHandler = InviteMemberHandler;
exports.InviteMemberHandler = InviteMemberHandler = __decorate([
    (0, cqrs_1.CommandHandler)(InviteMemberCommand),
    __param(0, (0, common_1.Inject)(ports_1.INVITATION_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_1.MEMBERSHIP_REPOSITORY)),
    __param(2, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __metadata("design:paramtypes", [Object, Object, Object])
], InviteMemberHandler);
//# sourceMappingURL=invite-member.js.map