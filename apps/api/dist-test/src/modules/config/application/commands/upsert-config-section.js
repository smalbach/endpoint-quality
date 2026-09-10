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
exports.ResetConfigSectionHandler = exports.UpsertConfigSectionHandler = exports.ResetConfigSectionCommand = exports.UpsertConfigSectionCommand = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const runner_core_1 = require("@eq/runner-core");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const clock_port_1 = require("../../../../shared/clock/clock.port");
const ports_1 = require("../../../projects/domain/ports");
const update_project_1 = require("../../../projects/application/commands/update-project");
const ports_2 = require("../../domain/ports");
class UpsertConfigSectionCommand {
    organizationId;
    projectId;
    section;
    data;
    updatedBy;
    constructor(organizationId, projectId, section, data, updatedBy) {
        this.organizationId = organizationId;
        this.projectId = projectId;
        this.section = section;
        this.data = data;
        this.updatedBy = updatedBy;
    }
}
exports.UpsertConfigSectionCommand = UpsertConfigSectionCommand;
class ResetConfigSectionCommand {
    organizationId;
    projectId;
    section;
    constructor(organizationId, projectId, section) {
        this.organizationId = organizationId;
        this.projectId = projectId;
        this.section = section;
    }
}
exports.ResetConfigSectionCommand = ResetConfigSectionCommand;
/**
 * Writes one section, whole, after validating it.
 *
 * The section is the unit of change on purpose: a half-applied edit — new budget rules saved,
 * their order not — is not a state that can exist. Postgres cannot check the shape of a JSONB
 * document, so the zod schema in `@eq/runner-core` does, and it lives beside the type it
 * describes rather than here, where it would drift.
 *
 * Validation failures come back as 422 with a **field path**, because "invalid config" over a
 * document with forty keys is not something anybody can act on.
 */
let UpsertConfigSectionHandler = class UpsertConfigSectionHandler {
    projects;
    config;
    clock;
    constructor(projects, config, clock) {
        this.projects = projects;
        this.config = config;
        this.clock = clock;
    }
    async execute(command) {
        const project = await (0, update_project_1.ownedProject)(this.projects, command.organizationId, command.projectId);
        const section = assertSection(command.section);
        const verdict = (0, runner_core_1.safeParseSection)(section, command.data);
        if (!verdict.ok)
            throw new domain_error_1.InvalidInputError(`La sección ${section} no es válida`, verdict.issues, "config-invalid");
        await this.config.saveSection({ projectId: project.id, section, data: command.data, updatedAt: this.clock.now(), updatedBy: command.updatedBy });
    }
};
exports.UpsertConfigSectionHandler = UpsertConfigSectionHandler;
exports.UpsertConfigSectionHandler = UpsertConfigSectionHandler = __decorate([
    (0, cqrs_1.CommandHandler)(UpsertConfigSectionCommand),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.CONFIG_REPOSITORY)),
    __param(2, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __metadata("design:paramtypes", [Object, Object, Object])
], UpsertConfigSectionHandler);
/** Removes a section so the project falls back to the engine's defaults. Deleting the row is the
 * only honest way to say "unset": writing the defaults into it would look like a decision. */
let ResetConfigSectionHandler = class ResetConfigSectionHandler {
    projects;
    config;
    constructor(projects, config) {
        this.projects = projects;
        this.config = config;
    }
    async execute(command) {
        const project = await (0, update_project_1.ownedProject)(this.projects, command.organizationId, command.projectId);
        await this.config.deleteSection(project.id, assertSection(command.section));
    }
};
exports.ResetConfigSectionHandler = ResetConfigSectionHandler;
exports.ResetConfigSectionHandler = ResetConfigSectionHandler = __decorate([
    (0, cqrs_1.CommandHandler)(ResetConfigSectionCommand),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.CONFIG_REPOSITORY)),
    __metadata("design:paramtypes", [Object, Object])
], ResetConfigSectionHandler);
function assertSection(value) {
    if (!(0, runner_core_1.isConfigSection)(value)) {
        throw new domain_error_1.InvalidInputError("Sección de configuración desconocida", [{ field: "section", detail: `"${value}" no es una sección válida` }], "config-section-unknown");
    }
    return value;
}
//# sourceMappingURL=upsert-config-section.js.map