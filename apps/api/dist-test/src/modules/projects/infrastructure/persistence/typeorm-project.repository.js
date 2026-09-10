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
exports.TypeOrmProjectRepository = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const entities_1 = require("../../../../shared/database/entities");
let TypeOrmProjectRepository = class TypeOrmProjectRepository {
    repository;
    constructor(repository) {
        this.repository = repository;
    }
    async findById(id) {
        const row = await this.repository.findOne({ where: { id } });
        return row ? { ...row } : null;
    }
    async findBySlug(organizationId, slug) {
        const row = await this.repository.findOne({ where: { organizationId, slug } });
        return row ? { ...row } : null;
    }
    async listForOrganization(organizationId, includeArchived) {
        // The archived filter is a `where`, not a post-filter: an organization with hundreds of
        // archived projects would otherwise pull all of them across to drop them.
        const where = includeArchived ? { organizationId } : { organizationId, archivedAt: (0, typeorm_2.IsNull)() };
        return (await this.repository.find({ where, order: { createdAt: "DESC" } })).map((row) => ({ ...row }));
    }
    async save(project) {
        await this.repository.save(project);
    }
};
exports.TypeOrmProjectRepository = TypeOrmProjectRepository;
exports.TypeOrmProjectRepository = TypeOrmProjectRepository = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(entities_1.ProjectEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], TypeOrmProjectRepository);
//# sourceMappingURL=typeorm-project.repository.js.map