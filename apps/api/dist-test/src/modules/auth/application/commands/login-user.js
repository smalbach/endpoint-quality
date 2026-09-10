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
exports.LoginUserHandler = exports.LoginUserCommand = void 0;
exports.issueSession = issueSession;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const clock_port_1 = require("../../../../shared/clock/clock.port");
const password_hasher_1 = require("../../../../shared/crypto/password-hasher");
const opaque_token_1 = require("../../../../shared/crypto/opaque-token");
const env_1 = require("../../../../shared/config/env");
const access_token_1 = require("../../domain/access-token");
const model_1 = require("../../domain/model");
const ports_1 = require("../../domain/ports");
class LoginUserCommand {
    email;
    password;
    constructor(email, password) {
        this.email = email;
        this.password = password;
    }
}
exports.LoginUserCommand = LoginUserCommand;
/**
 * Exchanges an email and a password for a session.
 *
 * **Every failure answers the same thing and takes the same time.** An unknown email verifies
 * the password against a decoy digest before failing, so the response time does not say whether
 * the account exists; a disabled account fails with the identical message, so probing does not
 * reveal that either. The temptation is to return "esa cuenta está deshabilitada" because it is
 * more helpful — it is also a free list of valid addresses for anyone with a wordlist.
 */
let LoginUserHandler = class LoginUserHandler {
    users;
    refreshTokens;
    passwords;
    accessTokens;
    clock;
    env;
    /** A digest of a password nobody holds, hashed once, so the unknown-email path spends the
     * same work as the known-email one. */
    decoy = null;
    constructor(users, refreshTokens, passwords, accessTokens, clock, env) {
        this.users = users;
        this.refreshTokens = refreshTokens;
        this.passwords = passwords;
        this.accessTokens = accessTokens;
        this.clock = clock;
        this.env = env;
    }
    async execute(command) {
        const user = await this.users.findByEmail((0, model_1.normalizeEmail)(command.email));
        const digest = user?.passwordDigest ?? (await this.decoyDigest());
        const matches = await this.passwords.verify(command.password, digest);
        if (!user || !matches || !(0, model_1.isActive)(user))
            throw new domain_error_1.UnauthenticatedError();
        return issueSession({
            userId: user.id,
            email: user.email,
            sessionId: (0, node_crypto_1.randomUUID)(),
            now: this.clock.now(),
            ttlDays: this.env.REFRESH_TOKEN_TTL_DAYS,
            accessTokens: this.accessTokens,
            refreshTokens: this.refreshTokens,
        });
    }
    async decoyDigest() {
        this.decoy ??= await this.passwords.hash((0, node_crypto_1.randomUUID)());
        return this.decoy;
    }
};
exports.LoginUserHandler = LoginUserHandler;
exports.LoginUserHandler = LoginUserHandler = __decorate([
    (0, cqrs_1.CommandHandler)(LoginUserCommand),
    __param(0, (0, common_1.Inject)(ports_1.USER_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_1.REFRESH_TOKEN_REPOSITORY)),
    __param(2, (0, common_1.Inject)(password_hasher_1.PASSWORD_HASHER)),
    __param(3, (0, common_1.Inject)(access_token_1.ACCESS_TOKEN_SERVICE)),
    __param(4, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __param(5, (0, common_1.Inject)(env_1.ENV)),
    __metadata("design:paramtypes", [Object, Object, Object, Object, Object, Object])
], LoginUserHandler);
/**
 * Mints one access/refresh pair and records the refresh side.
 *
 * Shared by login and by rotation so the two cannot drift — a refresh that stored its token with
 * a different expiry or under a different session than login does is a bug that only shows up on
 * the second day of a session.
 */
async function issueSession(input) {
    const refreshToken = (0, opaque_token_1.generateOpaqueToken)();
    const refreshExpiresAt = new Date(input.now.getTime() + input.ttlDays * 24 * 60 * 60 * 1000);
    await input.refreshTokens.save({
        id: (0, node_crypto_1.randomUUID)(),
        userId: input.userId,
        sessionId: input.sessionId,
        tokenHash: (0, opaque_token_1.hashOpaqueToken)(refreshToken),
        expiresAt: refreshExpiresAt,
        createdAt: input.now,
        usedAt: null,
        revokedAt: null,
        replacedByHash: null,
    });
    return {
        userId: input.userId,
        accessToken: await input.accessTokens.sign({ sub: input.userId, email: input.email }),
        refreshToken,
        expiresIn: input.accessTokens.ttlSeconds(),
        refreshExpiresAt,
    };
}
//# sourceMappingURL=login-user.js.map