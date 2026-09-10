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
var RefreshSessionHandler_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RefreshSessionHandler = exports.RefreshSessionCommand = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const clock_port_1 = require("../../../../shared/clock/clock.port");
const opaque_token_1 = require("../../../../shared/crypto/opaque-token");
const env_1 = require("../../../../shared/config/env");
const access_token_1 = require("../../domain/access-token");
const model_1 = require("../../domain/model");
const ports_1 = require("../../domain/ports");
const login_user_1 = require("./login-user");
class RefreshSessionCommand {
    refreshToken;
    constructor(refreshToken) {
        this.refreshToken = refreshToken;
    }
}
exports.RefreshSessionCommand = RefreshSessionCommand;
/**
 * Rotates a refresh token, and closes the session if the old one comes back.
 *
 * **Rotation on its own does not stop a stolen token.** The thief refreshes, gets a valid new
 * pair, and keeps going; the theft only surfaces when the legitimate user next refreshes and
 * presents a token that was already spent. So the spent tokens are *kept*, marked `usedAt`, and
 * presenting one again is treated as proof that two parties hold the chain.
 *
 * When that happens the entire session is revoked — not the one token. Revoking the presented
 * token alone leaves whichever party currently holds the newest one still logged in, and there
 * is no way to tell from here which of the two that is. Ending the session logs out both and
 * costs the legitimate user one login; leaving it open costs them the account.
 *
 * Deleting spent rows instead of marking them would erase the signal entirely: a token that is
 * gone is indistinguishable from one that never existed, and reuse would look like a typo.
 */
let RefreshSessionHandler = RefreshSessionHandler_1 = class RefreshSessionHandler {
    refreshTokens;
    users;
    accessTokens;
    clock;
    env;
    logger = new common_1.Logger(RefreshSessionHandler_1.name);
    constructor(refreshTokens, users, accessTokens, clock, env) {
        this.refreshTokens = refreshTokens;
        this.users = users;
        this.accessTokens = accessTokens;
        this.clock = clock;
        this.env = env;
    }
    async execute(command) {
        const now = this.clock.now();
        const stored = await this.refreshTokens.findByHash((0, opaque_token_1.hashOpaqueToken)(command.refreshToken));
        if (!stored)
            throw new domain_error_1.UnauthenticatedError("La sesión no es válida");
        const verdict = (0, model_1.verifyRefreshToken)(stored, now);
        if (!verdict.usable) {
            if (verdict.reason === "reused") {
                await this.refreshTokens.revokeSession(stored.sessionId, now);
                this.logger.warn(`Reuso de refresh token detectado; sesión ${stored.sessionId} revocada para el usuario ${stored.userId}`);
            }
            throw new domain_error_1.UnauthenticatedError("La sesión no es válida");
        }
        const user = await this.users.findById(stored.userId);
        // A disabled account keeps a valid refresh token until it expires. Checking the user here is
        // what makes disabling take effect on the next rotation instead of up to thirty days later.
        if (!user || !(0, model_1.isActive)(user)) {
            await this.refreshTokens.revokeSession(stored.sessionId, now);
            throw new domain_error_1.UnauthenticatedError("La sesión no es válida");
        }
        const issued = await (0, login_user_1.issueSession)({
            userId: user.id,
            email: user.email,
            // The new token joins the same session: that chain is what reuse detection walks.
            sessionId: stored.sessionId,
            now,
            ttlDays: this.env.REFRESH_TOKEN_TTL_DAYS,
            accessTokens: this.accessTokens,
            refreshTokens: this.refreshTokens,
        });
        await this.refreshTokens.markUsed(stored.id, now, (0, opaque_token_1.hashOpaqueToken)(issued.refreshToken));
        return issued;
    }
};
exports.RefreshSessionHandler = RefreshSessionHandler;
exports.RefreshSessionHandler = RefreshSessionHandler = RefreshSessionHandler_1 = __decorate([
    (0, cqrs_1.CommandHandler)(RefreshSessionCommand),
    __param(0, (0, common_1.Inject)(ports_1.REFRESH_TOKEN_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_1.USER_REPOSITORY)),
    __param(2, (0, common_1.Inject)(access_token_1.ACCESS_TOKEN_SERVICE)),
    __param(3, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __param(4, (0, common_1.Inject)(env_1.ENV)),
    __metadata("design:paramtypes", [Object, Object, Object, Object, Object])
], RefreshSessionHandler);
//# sourceMappingURL=refresh-session.js.map