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
exports.TypeOrmEnvironmentRepository = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const entities_1 = require("../../../../shared/database/entities");
let TypeOrmEnvironmentRepository = class TypeOrmEnvironmentRepository {
    environments;
    credentials;
    constructor(environments, credentials) {
        this.environments = environments;
        this.credentials = credentials;
    }
    async findById(id) {
        const row = await this.environments.findOne({ where: { id } });
        return row ? { ...row } : null;
    }
    async findByName(projectId, name) {
        const row = await this.environments.findOne({ where: { projectId, name } });
        return row ? { ...row } : null;
    }
    async listForProject(projectId) {
        return (await this.environments.find({ where: { projectId }, order: { createdAt: "ASC" } })).map((row) => ({ ...row }));
    }
    async save(environment) {
        await this.environments.save(environment);
    }
    async remove(id) {
        // The credentials go with it, by the cascade in the migration: an environment deleted with
        // its secrets left behind would leave a set of credentials nothing can reach to revoke.
        await this.environments.delete({ id });
    }
    async listCredentials(environmentId) {
        return (await this.credentials.find({ where: { environmentId }, order: { role: "ASC" } })).map(toCredential);
    }
    async findCredential(environmentId, role) {
        const row = await this.credentials.findOne({ where: { environmentId, role } });
        return row ? toCredential(row) : null;
    }
    async saveCredential(credential) {
        await this.credentials.save(credential);
    }
    async removeCredential(environmentId, role) {
        await this.credentials.delete({ environmentId, role });
    }
};
exports.TypeOrmEnvironmentRepository = TypeOrmEnvironmentRepository;
exports.TypeOrmEnvironmentRepository = TypeOrmEnvironmentRepository = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(entities_1.EnvironmentEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(entities_1.EnvironmentCredentialEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository])
], TypeOrmEnvironmentRepository);
const toCredential = (row) => ({ ...row, role: row.role, kind: row.kind });
//# sourceMappingURL=typeorm-environment.repository.js.map