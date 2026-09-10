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
exports.JwtAccessTokenService = void 0;
exports.parseDuration = parseDuration;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const env_1 = require("../../../shared/config/env");
/**
 * The signed half of a session.
 *
 * Short-lived on purpose: an access token cannot be revoked, so its lifetime *is* the revocation
 * window. Fifteen minutes is the default, and the refresh chain — which is revocable — carries
 * the long-lived part.
 */
let JwtAccessTokenService = class JwtAccessTokenService {
    jwt;
    env;
    constructor(jwt, env) {
        this.jwt = jwt;
        this.env = env;
    }
    async sign(claims) {
        // Seconds rather than the raw "15m": the string form is typed against `ms` and a value that
        // fails to parse would silently mint a token that never expires.
        return this.jwt.signAsync(claims, { secret: this.env.JWT_ACCESS_SECRET, expiresIn: this.ttlSeconds() });
    }
    async verify(token) {
        // `verifyAsync` and not `decode`: decoding parses the payload without checking the
        // signature, which accepts anything the caller cares to write.
        const payload = await this.jwt.verifyAsync(token, { secret: this.env.JWT_ACCESS_SECRET });
        return { sub: payload.sub, email: payload.email };
    }
    ttlSeconds() {
        return parseDuration(this.env.ACCESS_TOKEN_TTL);
    }
};
exports.JwtAccessTokenService = JwtAccessTokenService;
exports.JwtAccessTokenService = JwtAccessTokenService = __decorate([
    (0, common_1.Injectable)(),
    __param(1, (0, common_1.Inject)(env_1.ENV)),
    __metadata("design:paramtypes", [jwt_1.JwtService, Object])
], JwtAccessTokenService);
/** `15m`, `2h`, `900`. Returned in the login response so the client can schedule a refresh
 * rather than discovering the expiry as a failed request. */
function parseDuration(value) {
    const match = /^(\d+)([smhd])?$/.exec(value.trim());
    if (!match)
        return 900;
    const amount = Number(match[1]);
    const unit = match[2] ?? "s";
    return amount * { s: 1, m: 60, h: 3600, d: 86400 }[unit];
}
//# sourceMappingURL=jwt-access-token.service.js.map