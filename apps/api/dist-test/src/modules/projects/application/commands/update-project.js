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
exports.SetProjectArchivedHandler = exports.UpdateProjectHandler = exports.SetProjectArchivedCommand = exports.UpdateProjectCommand = void 0;
exports.ownedProject = ownedProject;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const clock_port_1 = require("../../../../shared/clock/clock.port");
const ports_1 = require("../../domain/ports");
class UpdateProjectCommand {
    organizationId;
    projectId;
    changes;
    constructor(organizationId, projectId, changes) {
        this.organizationId = organizationId;
        this.projectId = projectId;
        this.changes = changes;
    }
}
exports.UpdateProjectCommand = UpdateProjectCommand;
class SetProjectArchivedCommand {
    organizationId;
    projectId;
    archived;
    constructor(organizationId, projectId, archived) {
        this.organizationId = organizationId;
        this.projectId = projectId;
        this.archived = archived;
    }
}
exports.SetProjectArchivedCommand = SetProjectArchivedCommand;
/** Loads a project and refuses to admit it exists to anyone outside its organization. The check
 * is folded into the 404 rather than answered with a 403, which would confirm the id is real. */
async function ownedProject(projects, organizationId, projectId) {
    const project = await projects.findById(projectId);
    if (!project || project.organizationId !== organizationId)
        throw new domain_error_1.NotFoundError("El proyecto no existe", "project-not-found");
    return project;
}
let UpdateProjectHandler = class UpdateProjectHandler {
    projects;
    constructor(projects) {
        this.projects = projects;
    }
    async execute(command) {
        const project = await ownedProject(this.projects, command.organizationId, command.projectId);
        if (project.archivedAt)
            throw new domain_error_1.ConflictError("El proyecto está archivado", "project-archived");
        // The slug is **not** recomputed from a new name: it is in URLs the team has bookmarked and
        // in whatever CI job launches their runs. Renaming a project should not break either.
        await this.projects.save({
            ...project,
            name: command.changes.name?.trim() || project.name,
            description: command.changes.description?.trim() ?? project.description,
        });
    }
};
exports.UpdateProjectHandler = UpdateProjectHandler;
exports.UpdateProjectHandler = UpdateProjectHandler = __decorate([
    (0, cqrs_1.CommandHandler)(UpdateProjectCommand),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __metadata("design:paramtypes", [Object])
], UpdateProjectHandler);
let SetProjectArchivedHandler = class SetProjectArchivedHandler {
    projects;
    clock;
    constructor(projects, clock) {
        this.projects = projects;
        this.clock = clock;
    }
    async execute(command) {
        const project = await ownedProject(this.projects, command.organizationId, command.projectId);
        await this.projects.save({ ...project, archivedAt: command.archived ? this.clock.now() : null });
    }
};
exports.SetProjectArchivedHandler = SetProjectArchivedHandler;
exports.SetProjectArchivedHandler = SetProjectArchivedHandler = __decorate([
    (0, cqrs_1.CommandHandler)(SetProjectArchivedCommand),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __metadata("design:paramtypes", [Object, Object])
], SetProjectArchivedHandler);
//# sourceMappingURL=update-project.js.map