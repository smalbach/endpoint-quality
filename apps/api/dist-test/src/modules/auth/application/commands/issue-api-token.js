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
exports.IssueApiTokenHandler = exports.IssueApiTokenCommand = void 0;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const clock_port_1 = require("../../../../shared/clock/clock.port");
const opaque_token_1 = require("../../../../shared/crypto/opaque-token");
const ports_1 = require("../../domain/ports");
class IssueApiTokenCommand {
    organizationId;
    name;
    createdBy;
    constructor(organizationId, name, createdBy) {
        this.organizationId = organizationId;
        this.name = name;
        this.createdBy = createdBy;
    }
}
exports.IssueApiTokenCommand = IssueApiTokenCommand;
/**
 * Mints a service credential for CI.
 *
 * The plaintext is returned **once**, from this call, and never stored — only its SHA-256 and a
 * six-character preview so an operator can tell two tokens apart in a list. A product that can
 * show you a token you created last month is a product whose database dump is a set of live
 * credentials.
 */
let IssueApiTokenHandler = class IssueApiTokenHandler {
    tokens;
    clock;
    constructor(tokens, clock) {
        this.tokens = tokens;
        this.clock = clock;
    }
    async execute(command) {
        // Prefixed so a leaked token is recognisable in a log or a public repository by automated
        // secret scanners, and by whoever finds it.
        const token = `eqt_${(0, opaque_token_1.generateOpaqueToken)()}`;
        const id = (0, node_crypto_1.randomUUID)();
        await this.tokens.save({
            id,
            organizationId: command.organizationId,
            name: command.name.trim() || "Token de CI",
            tokenHash: (0, opaque_token_1.hashOpaqueToken)(token),
            preview: (0, opaque_token_1.tokenPreview)(token),
            createdBy: command.createdBy,
            createdAt: this.clock.now(),
            lastUsedAt: null,
            revokedAt: null,
        });
        return { id, token, preview: (0, opaque_token_1.tokenPreview)(token) };
    }
};
exports.IssueApiTokenHandler = IssueApiTokenHandler;
exports.IssueApiTokenHandler = IssueApiTokenHandler = __decorate([
    (0, cqrs_1.CommandHandler)(IssueApiTokenCommand),
    __param(0, (0, common_1.Inject)(ports_1.API_TOKEN_REPOSITORY)),
    __param(1, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __metadata("design:paramtypes", [Object, Object])
], IssueApiTokenHandler);
//# sourceMappingURL=issue-api-token.js.map