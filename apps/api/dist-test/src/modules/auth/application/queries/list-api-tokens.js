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
exports.ListApiTokensHandler = exports.ListApiTokensQuery = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const ports_1 = require("../../domain/ports");
class ListApiTokensQuery {
    organizationId;
    constructor(organizationId) {
        this.organizationId = organizationId;
    }
}
exports.ListApiTokensQuery = ListApiTokensQuery;
/** The token list an operator sees. `tokenHash` never appears in it — the hash is not the secret,
 * but publishing it turns an offline check of a guessed token into a free oracle. */
let ListApiTokensHandler = class ListApiTokensHandler {
    tokens;
    constructor(tokens) {
        this.tokens = tokens;
    }
    async execute(query) {
        return (await this.tokens.listForOrganization(query.organizationId)).map((token) => ({
            id: token.id,
            name: token.name,
            preview: token.preview,
            createdAt: token.createdAt,
            lastUsedAt: token.lastUsedAt,
            revokedAt: token.revokedAt,
        }));
    }
};
exports.ListApiTokensHandler = ListApiTokensHandler;
exports.ListApiTokensHandler = ListApiTokensHandler = __decorate([
    (0, cqrs_1.QueryHandler)(ListApiTokensQuery),
    __param(0, (0, common_1.Inject)(ports_1.API_TOKEN_REPOSITORY)),
    __metadata("design:paramtypes", [Object])
], ListApiTokensHandler);
//# sourceMappingURL=list-api-tokens.js.map