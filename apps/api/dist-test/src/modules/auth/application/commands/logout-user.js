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
exports.LogoutUserHandler = exports.LogoutUserCommand = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const clock_port_1 = require("../../../../shared/clock/clock.port");
const opaque_token_1 = require("../../../../shared/crypto/opaque-token");
const ports_1 = require("../../domain/ports");
class LogoutUserCommand {
    refreshToken;
    everywhere;
    userId;
    constructor(refreshToken, everywhere, userId) {
        this.refreshToken = refreshToken;
        this.everywhere = everywhere;
        this.userId = userId;
    }
}
exports.LogoutUserCommand = LogoutUserCommand;
/**
 * Ends a session, or every session the user has.
 *
 * Logging out revokes the **whole session** rather than the single token presented: the point of
 * the button is that the credential in this browser stops working, and revoking one link of a
 * rotation chain leaves the rest of the chain valid.
 *
 * A logout with no token, or with one that does not resolve, still answers success. There is
 * nothing for the caller to do about it and nothing to learn from it — telling them their token
 * was already unknown is an oracle with no upside.
 */
let LogoutUserHandler = class LogoutUserHandler {
    refreshTokens;
    clock;
    constructor(refreshTokens, clock) {
        this.refreshTokens = refreshTokens;
        this.clock = clock;
    }
    async execute(command) {
        const now = this.clock.now();
        if (command.everywhere) {
            await this.refreshTokens.revokeAllForUser(command.userId, now);
            return;
        }
        if (!command.refreshToken)
            return;
        const stored = await this.refreshTokens.findByHash((0, opaque_token_1.hashOpaqueToken)(command.refreshToken));
        if (stored && stored.userId === command.userId)
            await this.refreshTokens.revokeSession(stored.sessionId, now);
    }
};
exports.LogoutUserHandler = LogoutUserHandler;
exports.LogoutUserHandler = LogoutUserHandler = __decorate([
    (0, cqrs_1.CommandHandler)(LogoutUserCommand),
    __param(0, (0, common_1.Inject)(ports_1.REFRESH_TOKEN_REPOSITORY)),
    __param(1, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __metadata("design:paramtypes", [Object, Object])
], LogoutUserHandler);
//# sourceMappingURL=logout-user.js.map