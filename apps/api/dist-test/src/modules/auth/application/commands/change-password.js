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
exports.ChangePasswordHandler = exports.ChangePasswordCommand = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const clock_port_1 = require("../../../../shared/clock/clock.port");
const password_hasher_1 = require("../../../../shared/crypto/password-hasher");
const ports_1 = require("../../domain/ports");
class ChangePasswordCommand {
    userId;
    currentPassword;
    newPassword;
    constructor(userId, currentPassword, newPassword) {
        this.userId = userId;
        this.currentPassword = currentPassword;
        this.newPassword = newPassword;
    }
}
exports.ChangePasswordCommand = ChangePasswordCommand;
/**
 * Changes the password and **logs every session out**, including the one that asked.
 *
 * The reason a person changes a password is usually that they think someone else has it. A
 * change that leaves the attacker's session alive does the one thing the user was trying to
 * prevent. The cost is one re-login; the alternative is a false sense of having fixed it.
 */
let ChangePasswordHandler = class ChangePasswordHandler {
    users;
    refreshTokens;
    passwords;
    clock;
    constructor(users, refreshTokens, passwords, clock) {
        this.users = users;
        this.refreshTokens = refreshTokens;
        this.passwords = passwords;
        this.clock = clock;
    }
    async execute(command) {
        const user = await this.users.findById(command.userId);
        if (!user)
            throw new domain_error_1.UnauthenticatedError();
        if (!(await this.passwords.verify(command.currentPassword, user.passwordDigest))) {
            throw new domain_error_1.UnauthenticatedError("La contraseña actual no es correcta");
        }
        if (command.newPassword.length < 12) {
            throw new domain_error_1.InvalidInputError("La contraseña es demasiado corta", [{ field: "newPassword", detail: "Debe tener al menos 12 caracteres" }]);
        }
        await this.users.save({ ...user, passwordDigest: await this.passwords.hash(command.newPassword) });
        await this.refreshTokens.revokeAllForUser(user.id, this.clock.now());
    }
};
exports.ChangePasswordHandler = ChangePasswordHandler;
exports.ChangePasswordHandler = ChangePasswordHandler = __decorate([
    (0, cqrs_1.CommandHandler)(ChangePasswordCommand),
    __param(0, (0, common_1.Inject)(ports_1.USER_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_1.REFRESH_TOKEN_REPOSITORY)),
    __param(2, (0, common_1.Inject)(password_hasher_1.PASSWORD_HASHER)),
    __param(3, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __metadata("design:paramtypes", [Object, Object, Object, Object])
], ChangePasswordHandler);
//# sourceMappingURL=change-password.js.map