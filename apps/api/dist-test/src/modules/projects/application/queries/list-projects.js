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
exports.GetProjectHandler = exports.ListProjectsHandler = exports.GetProjectQuery = exports.ListProjectsQuery = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const ports_1 = require("../../../specs/domain/ports");
const ports_2 = require("../../domain/ports");
class ListProjectsQuery {
    organizationId;
    includeArchived;
    constructor(organizationId, includeArchived) {
        this.organizationId = organizationId;
        this.includeArchived = includeArchived;
    }
}
exports.ListProjectsQuery = ListProjectsQuery;
class GetProjectQuery {
    organizationId;
    projectId;
    constructor(organizationId, projectId) {
        this.organizationId = organizationId;
        this.projectId = projectId;
    }
}
exports.GetProjectQuery = GetProjectQuery;
let ListProjectsHandler = class ListProjectsHandler {
    projects;
    specs;
    constructor(projects, specs) {
        this.projects = projects;
        this.specs = specs;
    }
    async execute(query) {
        const projects = await this.projects.listForOrganization(query.organizationId, query.includeArchived);
        return Promise.all(projects.map((project) => summarize(project, this.specs)));
    }
};
exports.ListProjectsHandler = ListProjectsHandler;
exports.ListProjectsHandler = ListProjectsHandler = __decorate([
    (0, cqrs_1.QueryHandler)(ListProjectsQuery),
    __param(0, (0, common_1.Inject)(ports_2.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_1.SPEC_REPOSITORY)),
    __metadata("design:paramtypes", [Object, Object])
], ListProjectsHandler);
let GetProjectHandler = class GetProjectHandler {
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
        return summarize(project, this.specs);
    }
};
exports.GetProjectHandler = GetProjectHandler;
exports.GetProjectHandler = GetProjectHandler = __decorate([
    (0, cqrs_1.QueryHandler)(GetProjectQuery),
    __param(0, (0, common_1.Inject)(ports_2.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_1.SPEC_REPOSITORY)),
    __metadata("design:paramtypes", [Object, Object])
], GetProjectHandler);
async function summarize(project, specs) {
    // `contract: null` is a real state and the UI has to render it: a project exists before its
    // first import, because importing can fail and losing the project with it helps nobody.
    const active = project.activeSpecVersionId ? await specs.findVersionById(project.activeSpecVersionId) : null;
    return {
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        archivedAt: project.archivedAt,
        contract: active ? { versionId: active.id, title: active.title, version: active.contractVersion, operationCount: active.operationCount, importedAt: active.importedAt } : null,
    };
}
//# sourceMappingURL=list-projects.js.map