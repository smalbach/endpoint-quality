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
exports.EnvironmentsController = void 0;
/**
 * Environments, their credentials, the project's configuration and the matrix it produces.
 *
 * **Credentials are `admin`, everything else is `editor`.** That line is where the role ladder
 * earns its keep: an editor curates the test matrix all day, and the two things that can damage
 * something outside this system — a stored credential for somebody's staging environment, and
 * the switch that lets a run write to a target — sit one rung above.
 */
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const auth_guard_1 = require("../../auth/infrastructure/guards/auth.guard");
const manage_environment_1 = require("../application/commands/manage-environment");
const manage_credential_1 = require("../application/commands/manage-credential");
const list_environments_1 = require("../application/queries/list-environments");
const upsert_config_section_1 = require("../../config/application/commands/upsert-config-section");
const get_project_config_1 = require("../../config/application/queries/get-project-config");
const get_scenarios_1 = require("../../config/application/queries/get-scenarios");
const environments_dto_1 = require("./dto/environments.dto");
const actorId = (principal) => (principal.kind === "user" ? principal.userId : principal.tokenId);
let EnvironmentsController = class EnvironmentsController {
    commandBus;
    queryBus;
    constructor(commandBus, queryBus) {
        this.commandBus = commandBus;
        this.queryBus = queryBus;
    }
    async list(organizationId, projectId) {
        return this.queryBus.execute(new list_environments_1.ListEnvironmentsQuery(organizationId, projectId));
    }
    async create(organizationId, projectId, body) {
        return this.commandBus.execute(new manage_environment_1.CreateEnvironmentCommand(organizationId, projectId, body));
    }
    async update(organizationId, projectId, environmentId, body) {
        await this.commandBus.execute(new manage_environment_1.UpdateEnvironmentCommand(organizationId, projectId, environmentId, body));
    }
    async remove(organizationId, projectId, environmentId) {
        await this.commandBus.execute(new manage_environment_1.DeleteEnvironmentCommand(organizationId, projectId, environmentId));
    }
    // Storing somebody's staging token is one of the two acts in this product that can affect a
    // system outside it. An editor cannot do it.
    async upsertCredential(organizationId, projectId, environmentId, body) {
        return this.commandBus.execute(new manage_credential_1.UpsertCredentialCommand(organizationId, projectId, environmentId, body));
    }
    async deleteCredential(organizationId, projectId, environmentId, role) {
        await this.commandBus.execute(new manage_credential_1.DeleteCredentialCommand(organizationId, projectId, environmentId, role));
    }
    async config(organizationId, projectId) {
        return this.queryBus.execute(new get_project_config_1.GetProjectConfigQuery(organizationId, projectId));
    }
    async putConfig(organizationId, projectId, section, body, principal) {
        await this.commandBus.execute(new upsert_config_section_1.UpsertConfigSectionCommand(organizationId, projectId, section, body, actorId(principal)));
    }
    /** Removes the section so the project falls back to the engine's defaults. Writing the
     * defaults into it instead would look like somebody chose them. */
    async resetConfig(organizationId, projectId, section) {
        await this.commandBus.execute(new upsert_config_section_1.ResetConfigSectionCommand(organizationId, projectId, section));
    }
    async scenarios(organizationId, projectId, environmentId, order) {
        const mode = order === "contract" || order === "custom" ? order : "safe";
        return this.queryBus.execute(new get_scenarios_1.GetScenariosQuery(organizationId, projectId, environmentId, mode));
    }
};
exports.EnvironmentsController = EnvironmentsController;
__decorate([
    (0, common_1.Get)("environments"),
    (0, auth_guard_1.RequireRole)("viewer"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], EnvironmentsController.prototype, "list", null);
__decorate([
    (0, common_1.Post)("environments"),
    (0, auth_guard_1.RequireRole)("editor"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, environments_dto_1.EnvironmentDto]),
    __metadata("design:returntype", Promise)
], EnvironmentsController.prototype, "create", null);
__decorate([
    (0, common_1.Patch)("environments/:environmentId"),
    (0, auth_guard_1.RequireRole)("editor"),
    (0, common_1.HttpCode)(204),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Param)("environmentId")),
    __param(3, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, environments_dto_1.EnvironmentDto]),
    __metadata("design:returntype", Promise)
], EnvironmentsController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)("environments/:environmentId"),
    (0, auth_guard_1.RequireRole)("admin"),
    (0, common_1.HttpCode)(204),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Param)("environmentId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], EnvironmentsController.prototype, "remove", null);
__decorate([
    (0, common_1.Put)("environments/:environmentId/credentials"),
    (0, auth_guard_1.RequireRole)("admin"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Param)("environmentId")),
    __param(3, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, environments_dto_1.CredentialDto]),
    __metadata("design:returntype", Promise)
], EnvironmentsController.prototype, "upsertCredential", null);
__decorate([
    (0, common_1.Delete)("environments/:environmentId/credentials/:role"),
    (0, auth_guard_1.RequireRole)("admin"),
    (0, common_1.HttpCode)(204),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Param)("environmentId")),
    __param(3, (0, common_1.Param)("role")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", Promise)
], EnvironmentsController.prototype, "deleteCredential", null);
__decorate([
    (0, common_1.Get)("config"),
    (0, auth_guard_1.RequireRole)("viewer"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], EnvironmentsController.prototype, "config", null);
__decorate([
    (0, common_1.Put)("config/:section"),
    (0, auth_guard_1.RequireRole)("editor"),
    (0, common_1.HttpCode)(204),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Param)("section")),
    __param(3, (0, common_1.Body)()),
    __param(4, (0, auth_guard_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], EnvironmentsController.prototype, "putConfig", null);
__decorate([
    (0, common_1.Delete)("config/:section"),
    (0, auth_guard_1.RequireRole)("editor"),
    (0, common_1.HttpCode)(204),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Param)("section")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], EnvironmentsController.prototype, "resetConfig", null);
__decorate([
    (0, common_1.Get)("scenarios"),
    (0, auth_guard_1.RequireRole)("viewer"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Query)("environmentId")),
    __param(3, (0, common_1.Query)("order")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", Promise)
], EnvironmentsController.prototype, "scenarios", null);
exports.EnvironmentsController = EnvironmentsController = __decorate([
    (0, common_1.Controller)("orgs/:organizationId/projects/:projectId"),
    (0, common_1.UseGuards)(auth_guard_1.OrgRoleGuard),
    __metadata("design:paramtypes", [cqrs_1.CommandBus, cqrs_1.QueryBus])
], EnvironmentsController);
//# sourceMappingURL=environments.controller.js.map