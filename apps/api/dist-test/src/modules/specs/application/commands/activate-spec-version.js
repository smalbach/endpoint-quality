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
exports.ActivateSpecVersionHandler = exports.ActivateSpecVersionCommand = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const ports_1 = require("../../../projects/domain/ports");
const update_project_1 = require("../../../projects/application/commands/update-project");
const ports_2 = require("../../domain/ports");
class ActivateSpecVersionCommand {
    organizationId;
    projectId;
    specVersionId;
    constructor(organizationId, projectId, specVersionId) {
        this.organizationId = organizationId;
        this.projectId = projectId;
        this.specVersionId = specVersionId;
    }
}
exports.ActivateSpecVersionCommand = ActivateSpecVersionCommand;
/**
 * Points the project at a different snapshot.
 *
 * Rolling back to a previous contract is the reason this is a separate command: when v1.9 turns
 * the matrix red, the first question is whether the API broke or the contract moved, and
 * switching the active version answers it in one click instead of a re-import.
 */
let ActivateSpecVersionHandler = class ActivateSpecVersionHandler {
    projects;
    specs;
    constructor(projects, specs) {
        this.projects = projects;
        this.specs = specs;
    }
    async execute(command) {
        const project = await (0, update_project_1.ownedProject)(this.projects, command.organizationId, command.projectId);
        const version = await this.specs.findVersionById(command.specVersionId);
        // Belongs-to-this-project is part of the existence check: a version id from another
        // customer's project must be a 404 here, not a 403 that confirms it is real.
        if (!version || version.projectId !== project.id)
            throw new domain_error_1.NotFoundError("La versión no existe", "spec-version-not-found");
        await this.projects.save({ ...project, activeSpecVersionId: version.id });
    }
};
exports.ActivateSpecVersionHandler = ActivateSpecVersionHandler;
exports.ActivateSpecVersionHandler = ActivateSpecVersionHandler = __decorate([
    (0, cqrs_1.CommandHandler)(ActivateSpecVersionCommand),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.SPEC_REPOSITORY)),
    __metadata("design:paramtypes", [Object, Object])
], ActivateSpecVersionHandler);
//# sourceMappingURL=activate-spec-version.js.map