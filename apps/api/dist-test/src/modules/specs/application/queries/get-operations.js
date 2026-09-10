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
exports.ListSpecVersionsHandler = exports.GetOperationsHandler = exports.ListSpecVersionsQuery = exports.GetOperationsQuery = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const ports_1 = require("../../../projects/domain/ports");
const ports_2 = require("../../domain/ports");
class GetOperationsQuery {
    organizationId;
    projectId;
    specVersionId;
    /** `specVersionId` absent means the project's active version, which is what every caller
     * wants except the drift view. */
    constructor(organizationId, projectId, specVersionId) {
        this.organizationId = organizationId;
        this.projectId = projectId;
        this.specVersionId = specVersionId;
    }
}
exports.GetOperationsQuery = GetOperationsQuery;
class ListSpecVersionsQuery {
    organizationId;
    projectId;
    constructor(organizationId, projectId) {
        this.organizationId = organizationId;
        this.projectId = projectId;
    }
}
exports.ListSpecVersionsQuery = ListSpecVersionsQuery;
let GetOperationsHandler = class GetOperationsHandler {
    projects;
    specs;
    constructor(projects, specs) {
        this.projects = projects;
        this.specs = specs;
    }
    async execute(query) {
        const project = await this.projects.findById(query.projectId);
        if (!project || project.organizationId !== query.organizationId)
            throw new domain_error_1.NotFoundError("El proyecto no existe", "project-not-found");
        const versionId = query.specVersionId ?? project.activeSpecVersionId;
        if (!versionId)
            throw new domain_error_1.ConflictError("El proyecto todavía no tiene contrato importado", "no-active-spec");
        const version = await this.specs.findVersionById(versionId);
        if (!version || version.projectId !== project.id)
            throw new domain_error_1.NotFoundError("La versión no existe", "spec-version-not-found");
        const operations = await this.specs.listOperations(version.id);
        return {
            specVersionId: version.id,
            contractVersion: version.contractVersion,
            operations,
            tags: [...new Set(operations.map((operation) => operation.tag).filter(Boolean))],
        };
    }
};
exports.GetOperationsHandler = GetOperationsHandler;
exports.GetOperationsHandler = GetOperationsHandler = __decorate([
    (0, cqrs_1.QueryHandler)(GetOperationsQuery),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.SPEC_REPOSITORY)),
    __metadata("design:paramtypes", [Object, Object])
], GetOperationsHandler);
let ListSpecVersionsHandler = class ListSpecVersionsHandler {
    projects;
    specs;
    constructor(projects, specs) {
        this.projects = projects;
        this.specs = specs;
    }
    async execute(query) {
        const project = await this.projects.findById(query.projectId);
        if (!project || project.organizationId !== query.organizationId)
            throw new domain_error_1.NotFoundError("El proyecto no existe", "project-not-found");
        // Summaries, never the raw documents: ten versions of a 120 KB contract is 1.2 MB the
        // browser has no use for.
        return { active: project.activeSpecVersionId, versions: await this.specs.listVersions(project.id) };
    }
};
exports.ListSpecVersionsHandler = ListSpecVersionsHandler;
exports.ListSpecVersionsHandler = ListSpecVersionsHandler = __decorate([
    (0, cqrs_1.QueryHandler)(ListSpecVersionsQuery),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.SPEC_REPOSITORY)),
    __metadata("design:paramtypes", [Object, Object])
], ListSpecVersionsHandler);
//# sourceMappingURL=get-operations.js.map