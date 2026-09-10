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
exports.RevokeApiTokenHandler = exports.RevokeApiTokenCommand = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const clock_port_1 = require("../../../../shared/clock/clock.port");
const ports_1 = require("../../domain/ports");
class RevokeApiTokenCommand {
    organizationId;
    tokenId;
    constructor(organizationId, tokenId) {
        this.organizationId = organizationId;
        this.tokenId = tokenId;
    }
}
exports.RevokeApiTokenCommand = RevokeApiTokenCommand;
let RevokeApiTokenHandler = class RevokeApiTokenHandler {
    tokens;
    clock;
    constructor(tokens, clock) {
        this.tokens = tokens;
        this.clock = clock;
    }
    async execute(command) {
        const token = await this.tokens.findById(command.tokenId);
        // The organization check is inside the 404 rather than beside it: answering 403 for a token
        // that belongs to someone else confirms the id exists, which is a membership oracle across
        // tenants. To this caller it does not exist.
        if (!token || token.organizationId !== command.organizationId)
            throw new domain_error_1.NotFoundError("El token no existe", "api-token-not-found");
        if (token.revokedAt)
            return;
        await this.tokens.save({ ...token, revokedAt: this.clock.now() });
    }
};
exports.RevokeApiTokenHandler = RevokeApiTokenHandler;
exports.RevokeApiTokenHandler = RevokeApiTokenHandler = __decorate([
    (0, cqrs_1.CommandHandler)(RevokeApiTokenCommand),
    __param(0, (0, common_1.Inject)(ports_1.API_TOKEN_REPOSITORY)),
    __param(1, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __metadata("design:paramtypes", [Object, Object])
], RevokeApiTokenHandler);
//# sourceMappingURL=revoke-api-token.js.map