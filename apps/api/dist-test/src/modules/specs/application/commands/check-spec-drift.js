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
exports.CheckSpecDriftHandler = exports.CheckSpecDriftCommand = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const spec_import_1 = require("@eq/spec-import");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const ports_1 = require("../../../projects/domain/ports");
const update_project_1 = require("../../../projects/application/commands/update-project");
const ports_2 = require("../../domain/ports");
const import_spec_version_1 = require("./import-spec-version");
class CheckSpecDriftCommand {
    organizationId;
    projectId;
    source;
    checkedBy;
    constructor(organizationId, projectId, source, checkedBy) {
        this.organizationId = organizationId;
        this.projectId = projectId;
        this.source = source;
        this.checkedBy = checkedBy;
    }
}
exports.CheckSpecDriftCommand = CheckSpecDriftCommand;
/**
 * Fetches the contract again and reports what moved, **without activating anything**.
 *
 * This is the capability the coupled dashboard structurally could not have: its operation table
 * was compiled into the bundle, so "the contract changed" and "the contract is fine" produced
 * identical output — a green matrix. A drift detector that cannot detect its own drift is the
 * worst possible version of the tool, and this command is the answer to that.
 *
 * It imports the new document as an inactive version so the diff is against something durable
 * and the operator can activate it deliberately once they have read what changed.
 */
let CheckSpecDriftHandler = class CheckSpecDriftHandler {
    projects;
    specs;
    commandBus;
    constructor(projects, specs, commandBus) {
        this.projects = projects;
        this.specs = specs;
        this.commandBus = commandBus;
    }
    async execute(command) {
        const project = await (0, update_project_1.ownedProject)(this.projects, command.organizationId, command.projectId);
        if (!project.activeSpecVersionId)
            throw new domain_error_1.ConflictError("El proyecto no tiene contrato activo con el que comparar", "no-active-spec");
        const active = await this.specs.findVersionById(project.activeSpecVersionId);
        if (!active)
            throw new domain_error_1.NotFoundError("La versión activa no existe", "spec-version-not-found");
        const imported = await this.commandBus.execute(new import_spec_version_1.ImportSpecVersionCommand(command.organizationId, project.id, command.source, command.checkedBy, false));
        if (imported.specVersionId === active.id) {
            return { changes: [], breaking: [], uncovered: [], unchanged: true, activeVersionId: active.id, candidateVersionId: active.id };
        }
        const [before, after] = await Promise.all([this.specs.listOperations(active.id), this.specs.listOperations(imported.specVersionId)]);
        return { ...(0, spec_import_1.diffOperations)(before, after), unchanged: false, activeVersionId: active.id, candidateVersionId: imported.specVersionId };
    }
};
exports.CheckSpecDriftHandler = CheckSpecDriftHandler;
exports.CheckSpecDriftHandler = CheckSpecDriftHandler = __decorate([
    (0, cqrs_1.CommandHandler)(CheckSpecDriftCommand),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.SPEC_REPOSITORY)),
    __metadata("design:paramtypes", [Object, Object, cqrs_1.CommandBus])
], CheckSpecDriftHandler);
//# sourceMappingURL=check-spec-drift.js.map