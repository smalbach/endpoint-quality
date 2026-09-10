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
exports.TypeOrmSpecRepository = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const entities_1 = require("../../../../shared/database/entities");
let TypeOrmSpecRepository = class TypeOrmSpecRepository {
    versions;
    operations;
    sources;
    dataSource;
    constructor(versions, operations, sources, dataSource) {
        this.versions = versions;
        this.operations = operations;
        this.sources = sources;
        this.dataSource = dataSource;
    }
    async findVersionById(id) {
        return toVersion(await this.versions.findOne({ where: { id } }));
    }
    async findVersionByHash(projectId, hash) {
        return toVersion(await this.versions.findOne({ where: { projectId, hash } }));
    }
    async listVersions(projectId) {
        // `select` without `raw`: listing versions must not ship a copy of every contract document
        // to a browser that renders dates and counts.
        const rows = await this.versions.find({
            where: { projectId },
            order: { importedAt: "DESC" },
            select: ["id", "projectId", "sourceId", "hash", "format", "openapiVersion", "title", "contractVersion", "operationCount", "problems", "importedBy", "importedAt"],
        });
        return rows.map((row) => ({ ...row, problems: (row.problems ?? []) }));
    }
    /**
     * The version and its operations are written in **one transaction**.
     *
     * A version row with no operations is a contract the engine reads as empty — and an empty
     * matrix looks like full coverage of nothing rather than like a failed write.
     */
    async saveVersion(version, operations) {
        await this.dataSource.transaction(async (manager) => {
            await manager.getRepository(entities_1.SpecVersionEntity).save(version);
            if (operations.length) {
                const rows = operations.map((operation) => ({
                    id: operation.rowId,
                    specVersionId: operation.specVersionId,
                    position: operation.position,
                    operationId: operation.id,
                    method: operation.method,
                    path: operation.path,
                    summary: operation.summary,
                    tag: operation.tag,
                    statuses: operation.statuses,
                    parameters: operation.parameters,
                    security: operation.security,
                    derivedId: operation.derivedId,
                }));
                // Chunked: a contract with thousands of operations would otherwise build one statement
                // past what the driver will accept.
                await manager.getRepository(entities_1.SpecOperationEntity).save(rows, { chunk: 200 });
            }
        });
    }
    async listOperations(specVersionId) {
        // Ordered by the stored position, not by whatever order Postgres returns rows in: the
        // document order is the "contrato" ordering an operator can pick for a run.
        const rows = await this.operations.find({ where: { specVersionId }, order: { position: "ASC" } });
        return rows.map((row) => ({
            // `id` is the contract's operationId, `rowId` the primary key. Handing the engine the row
            // id would key every piece of configuration to one import and break it on the next.
            id: row.operationId,
            rowId: row.id,
            specVersionId: row.specVersionId,
            position: row.position,
            method: row.method,
            path: row.path,
            summary: row.summary,
            tag: row.tag,
            statuses: row.statuses,
            parameters: row.parameters,
            security: row.security,
            derivedId: row.derivedId,
        }));
    }
    async saveSource(source) {
        await this.sources.save(source);
    }
    async deleteVersion(id) {
        await this.versions.delete({ id });
    }
};
exports.TypeOrmSpecRepository = TypeOrmSpecRepository;
exports.TypeOrmSpecRepository = TypeOrmSpecRepository = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(entities_1.SpecVersionEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(entities_1.SpecOperationEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(entities_1.SpecSourceEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.DataSource])
], TypeOrmSpecRepository);
function toVersion(row) {
    return row ? { ...row, problems: (row.problems ?? []) } : null;
}
//# sourceMappingURL=typeorm-spec.repository.js.map