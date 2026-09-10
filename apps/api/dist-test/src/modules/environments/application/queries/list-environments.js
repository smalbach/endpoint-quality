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
exports.ListEnvironmentsHandler = exports.ListEnvironmentsQuery = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const ports_1 = require("../../../projects/domain/ports");
const update_project_1 = require("../../../projects/application/commands/update-project");
const ports_2 = require("../../domain/ports");
class ListEnvironmentsQuery {
    organizationId;
    projectId;
    constructor(organizationId, projectId) {
        this.organizationId = organizationId;
        this.projectId = projectId;
    }
}
exports.ListEnvironmentsQuery = ListEnvironmentsQuery;
let ListEnvironmentsHandler = class ListEnvironmentsHandler {
    projects;
    environments;
    constructor(projects, environments) {
        this.projects = projects;
        this.environments = environments;
    }
    async execute(query) {
        const project = await (0, update_project_1.ownedProject)(this.projects, query.organizationId, query.projectId);
        const environments = await this.environments.listForProject(project.id);
        return Promise.all(environments.map(async (environment) => ({
            ...environment,
            credentials: (await this.environments.listCredentials(environment.id)).map((credential) => ({
                id: credential.id,
                name: credential.name,
                role: credential.role,
                kind: credential.kind,
                headerName: credential.headerName,
                scopes: credential.scopes,
                updatedAt: credential.updatedAt,
                // `secretCiphertext` is absent by construction rather than deleted afterwards: a view
                // that has to remember to strip a field is a view that will one day forget.
            })),
        })));
    }
};
exports.ListEnvironmentsHandler = ListEnvironmentsHandler;
exports.ListEnvironmentsHandler = ListEnvironmentsHandler = __decorate([
    (0, cqrs_1.QueryHandler)(ListEnvironmentsQuery),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.ENVIRONMENT_REPOSITORY)),
    __metadata("design:paramtypes", [Object, Object])
], ListEnvironmentsHandler);
//# sourceMappingURL=list-environments.js.map