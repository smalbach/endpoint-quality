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
exports.TypeOrmApiTokenRepository = exports.TypeOrmRefreshTokenRepository = exports.TypeOrmUserRepository = void 0;
/**
 * Postgres behind the auth ports.
 *
 * Nothing here has a policy: the decision that a reused refresh token closes its whole session
 * lives in the handler, and `revokeSession` only has to close it in **one statement**. Doing it
 * row by row leaves a window in which the party that stole the token refreshes again and gets a
 * fresh chain out of the one being revoked.
 */
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const entities_1 = require("../../../../shared/database/entities");
let TypeOrmUserRepository = class TypeOrmUserRepository {
    repository;
    constructor(repository) {
        this.repository = repository;
    }
    async findById(id) {
        return toUser(await this.repository.findOne({ where: { id } }));
    }
    async findByEmail(email) {
        return toUser(await this.repository.findOne({ where: { email: email.toLowerCase() } }));
    }
    async save(user) {
        await this.repository.save({ ...user, email: user.email.toLowerCase() });
    }
};
exports.TypeOrmUserRepository = TypeOrmUserRepository;
exports.TypeOrmUserRepository = TypeOrmUserRepository = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(entities_1.UserEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], TypeOrmUserRepository);
let TypeOrmRefreshTokenRepository = class TypeOrmRefreshTokenRepository {
    repository;
    constructor(repository) {
        this.repository = repository;
    }
    async findByHash(hash) {
        const row = await this.repository.findOne({ where: { tokenHash: hash } });
        return row ? { ...row } : null;
    }
    async save(token) {
        await this.repository.save(token);
    }
    async markUsed(id, at, replacedByHash) {
        await this.repository.update({ id }, { usedAt: at, replacedByHash });
    }
    async revokeSession(sessionId, at) {
        await this.repository.update({ sessionId, revokedAt: (0, typeorm_2.IsNull)() }, { revokedAt: at });
    }
    async revokeAllForUser(userId, at) {
        await this.repository.update({ userId, revokedAt: (0, typeorm_2.IsNull)() }, { revokedAt: at });
    }
};
exports.TypeOrmRefreshTokenRepository = TypeOrmRefreshTokenRepository;
exports.TypeOrmRefreshTokenRepository = TypeOrmRefreshTokenRepository = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(entities_1.RefreshTokenEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], TypeOrmRefreshTokenRepository);
let TypeOrmApiTokenRepository = class TypeOrmApiTokenRepository {
    repository;
    constructor(repository) {
        this.repository = repository;
    }
    async findByHash(hash) {
        const row = await this.repository.findOne({ where: { tokenHash: hash } });
        return row ? { ...row } : null;
    }
    async findById(id) {
        const row = await this.repository.findOne({ where: { id } });
        return row ? { ...row } : null;
    }
    async listForOrganization(organizationId) {
        return (await this.repository.find({ where: { organizationId }, order: { createdAt: "DESC" } })).map((row) => ({ ...row }));
    }
    async save(token) {
        await this.repository.save(token);
    }
    async touch(id, at) {
        await this.repository.update({ id }, { lastUsedAt: at });
    }
};
exports.TypeOrmApiTokenRepository = TypeOrmApiTokenRepository;
exports.TypeOrmApiTokenRepository = TypeOrmApiTokenRepository = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(entities_1.ApiTokenEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], TypeOrmApiTokenRepository);
function toUser(row) {
    return row ? { ...row, status: row.status } : null;
}
//# sourceMappingURL=typeorm-repositories.js.map