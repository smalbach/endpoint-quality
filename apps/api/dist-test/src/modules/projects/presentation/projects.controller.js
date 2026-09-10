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
exports.UnauthenticatedError = exports.ProjectsController = void 0;
/**
 * Projects and their contracts, over HTTP.
 *
 * Every route is nested under `/orgs/:organizationId/` so the tenant boundary is enforced by the
 * same guard as everywhere else, on a value that is in the URL rather than inferred from the
 * body. A project id in the path is then checked a second time, in the handler, against that
 * organization — belt and braces, because the guard proves you belong to the *organization* and
 * only the handler can prove the *project* belongs to it too.
 *
 * The role split follows the plan: `viewer` reads, `editor` creates projects and imports
 * contracts, `admin` archives. Importing is `editor` because it is the ordinary daily act of
 * keeping the matrix current; archiving is `admin` because it takes a project out of everyone's
 * list.
 */
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../shared/errors/domain-error");
Object.defineProperty(exports, "UnauthenticatedError", { enumerable: true, get: function () { return domain_error_1.UnauthenticatedError; } });
const auth_guard_1 = require("../../auth/infrastructure/guards/auth.guard");
const create_project_1 = require("../application/commands/create-project");
const update_project_1 = require("../application/commands/update-project");
const list_projects_1 = require("../application/queries/list-projects");
const import_spec_version_1 = require("../../specs/application/commands/import-spec-version");
const activate_spec_version_1 = require("../../specs/application/commands/activate-spec-version");
const check_spec_drift_1 = require("../../specs/application/commands/check-spec-drift");
const get_operations_1 = require("../../specs/application/queries/get-operations");
const projects_dto_1 = require("./dto/projects.dto");
/** The acting identity. A CI token is a legitimate importer — that is how a pipeline keeps the
 * contract fresh — so unlike member management this does not demand a human session. */
function actorId(principal) {
    return principal.kind === "user" ? principal.userId : principal.tokenId;
}
/**
 * Turns the request body into the command's input, and rejects the combinations the DTO cannot
 * express on its own — `kind: "url"` with no `url` is valid against every field rule and
 * meaningless as a whole.
 */
function toSource(dto) {
    if (dto.kind === "url") {
        if (!dto.url)
            throw new domain_error_1.InvalidInputError("Falta la URL del contrato", [{ field: "source.url", detail: "Requerida cuando kind es url" }]);
        return { kind: "url", url: dto.url, ...(dto.headers ? { headers: dto.headers } : {}) };
    }
    if (!dto.raw)
        throw new domain_error_1.InvalidInputError("Falta el contenido del contrato", [{ field: "source.raw", detail: `Requerido cuando kind es ${dto.kind}` }]);
    return dto.kind === "upload" ? { kind: "upload", filename: dto.filename ?? "openapi", raw: dto.raw } : { kind: "inline", raw: dto.raw };
}
let ProjectsController = class ProjectsController {
    commandBus;
    queryBus;
    constructor(commandBus, queryBus) {
        this.commandBus = commandBus;
        this.queryBus = queryBus;
    }
    async list(organizationId, includeArchived) {
        return this.queryBus.execute(new list_projects_1.ListProjectsQuery(organizationId, includeArchived === "true"));
    }
    async create(organizationId, body, principal) {
        return this.commandBus.execute(new create_project_1.CreateProjectCommand(organizationId, body.name, body.description ?? "", actorId(principal)));
    }
    async get(organizationId, projectId) {
        return this.queryBus.execute(new list_projects_1.GetProjectQuery(organizationId, projectId));
    }
    async update(organizationId, projectId, body) {
        await this.commandBus.execute(new update_project_1.UpdateProjectCommand(organizationId, projectId, body));
    }
    // Archiving takes a project out of everybody's list, so it sits a rung above editing it.
    async setArchived(organizationId, projectId, body) {
        await this.commandBus.execute(new update_project_1.SetProjectArchivedCommand(organizationId, projectId, body.archived));
    }
    async importSpec(organizationId, projectId, body, principal) {
        return this.commandBus.execute(new import_spec_version_1.ImportSpecVersionCommand(organizationId, projectId, toSource(body.source), actorId(principal), body.activate ?? true));
    }
    async listVersions(organizationId, projectId) {
        return this.queryBus.execute(new get_operations_1.ListSpecVersionsQuery(organizationId, projectId));
    }
    async activate(organizationId, projectId, specVersionId) {
        await this.commandBus.execute(new activate_spec_version_1.ActivateSpecVersionCommand(organizationId, projectId, specVersionId));
    }
    /**
     * Fetches the contract again and reports what moved, without changing what runs use.
     *
     * POST rather than GET because it makes a request to a third party and writes a version row.
     * A GET that does either is a GET somebody's proxy or crawler will eventually repeat.
     */
    async driftCheck(organizationId, projectId, body, principal) {
        return this.commandBus.execute(new check_spec_drift_1.CheckSpecDriftCommand(organizationId, projectId, toSource(body.source), actorId(principal)));
    }
    async operations(organizationId, projectId, specVersionId) {
        return this.queryBus.execute(new get_operations_1.GetOperationsQuery(organizationId, projectId, specVersionId));
    }
};
exports.ProjectsController = ProjectsController;
__decorate([
    (0, common_1.Get)(),
    (0, auth_guard_1.RequireRole)("viewer"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Query)("includeArchived")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], ProjectsController.prototype, "list", null);
__decorate([
    (0, common_1.Post)(),
    (0, auth_guard_1.RequireRole)("editor"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, auth_guard_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, projects_dto_1.CreateProjectDto, Object]),
    __metadata("design:returntype", Promise)
], ProjectsController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(":projectId"),
    (0, auth_guard_1.RequireRole)("viewer"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], ProjectsController.prototype, "get", null);
__decorate([
    (0, common_1.Patch)(":projectId"),
    (0, auth_guard_1.RequireRole)("editor"),
    (0, common_1.HttpCode)(204),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, projects_dto_1.UpdateProjectDto]),
    __metadata("design:returntype", Promise)
], ProjectsController.prototype, "update", null);
__decorate([
    (0, common_1.Patch)(":projectId/archived"),
    (0, auth_guard_1.RequireRole)("admin"),
    (0, common_1.HttpCode)(204),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, projects_dto_1.ArchiveProjectDto]),
    __metadata("design:returntype", Promise)
], ProjectsController.prototype, "setArchived", null);
__decorate([
    (0, common_1.Post)(":projectId/spec-versions"),
    (0, auth_guard_1.RequireRole)("editor"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, auth_guard_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, projects_dto_1.ImportSpecDto, Object]),
    __metadata("design:returntype", Promise)
], ProjectsController.prototype, "importSpec", null);
__decorate([
    (0, common_1.Get)(":projectId/spec-versions"),
    (0, auth_guard_1.RequireRole)("viewer"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], ProjectsController.prototype, "listVersions", null);
__decorate([
    (0, common_1.Post)(":projectId/spec-versions/:specVersionId/activate"),
    (0, auth_guard_1.RequireRole)("editor"),
    (0, common_1.HttpCode)(204),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Param)("specVersionId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], ProjectsController.prototype, "activate", null);
__decorate([
    (0, common_1.Post)(":projectId/spec-drift-check"),
    (0, common_1.HttpCode)(200),
    (0, auth_guard_1.RequireRole)("editor"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, auth_guard_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, projects_dto_1.ImportSpecDto, Object]),
    __metadata("design:returntype", Promise)
], ProjectsController.prototype, "driftCheck", null);
__decorate([
    (0, common_1.Get)(":projectId/operations"),
    (0, auth_guard_1.RequireRole)("viewer"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Query)("specVersionId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], ProjectsController.prototype, "operations", null);
exports.ProjectsController = ProjectsController = __decorate([
    (0, common_1.Controller)("orgs/:organizationId/projects"),
    (0, common_1.UseGuards)(auth_guard_1.OrgRoleGuard),
    __metadata("design:paramtypes", [cqrs_1.CommandBus, cqrs_1.QueryBus])
], ProjectsController);
//# sourceMappingURL=projects.controller.js.map