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
exports.TypeOrmConfigRepository = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const entities_1 = require("../../../../shared/database/entities");
let TypeOrmConfigRepository = class TypeOrmConfigRepository {
    repository;
    constructor(repository) {
        this.repository = repository;
    }
    async listSections(projectId) {
        // Ordered by section so the assembled configuration does not depend on row order. It should
        // not matter — the sections do not overlap — but a merge whose result depends on the order
        // rows come back in is a bug waiting for the day two sections do share a key.
        const rows = await this.repository.find({ where: { projectId }, order: { section: "ASC" } });
        return rows.map(toRow);
    }
    async findSection(projectId, section) {
        const row = await this.repository.findOne({ where: { projectId, section } });
        return row ? toRow(row) : null;
    }
    async saveSection(row) {
        await this.repository.save(row);
    }
    async deleteSection(projectId, section) {
        await this.repository.delete({ projectId, section });
    }
};
exports.TypeOrmConfigRepository = TypeOrmConfigRepository;
exports.TypeOrmConfigRepository = TypeOrmConfigRepository = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(entities_1.ProjectConfigEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], TypeOrmConfigRepository);
const toRow = (row) => ({ ...row, section: row.section });
//# sourceMappingURL=typeorm-config.repository.js.map