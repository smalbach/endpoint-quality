"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectsModule = exports.PROJECT_ADAPTERS = exports.PROJECT_QUERY_HANDLERS = exports.PROJECT_COMMAND_HANDLERS = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const typeorm_1 = require("@nestjs/typeorm");
const entities_1 = require("../../shared/database/entities");
const auth_module_1 = require("../auth/auth.module");
const iam_module_1 = require("../iam/iam.module");
const specs_module_1 = require("../specs/specs.module");
const ports_1 = require("./domain/ports");
const typeorm_project_repository_1 = require("./infrastructure/persistence/typeorm-project.repository");
const create_project_1 = require("./application/commands/create-project");
const update_project_1 = require("./application/commands/update-project");
const list_projects_1 = require("./application/queries/list-projects");
const projects_controller_1 = require("./presentation/projects.controller");
exports.PROJECT_COMMAND_HANDLERS = [create_project_1.CreateProjectHandler, update_project_1.UpdateProjectHandler, update_project_1.SetProjectArchivedHandler];
exports.PROJECT_QUERY_HANDLERS = [list_projects_1.ListProjectsHandler, list_projects_1.GetProjectHandler];
exports.PROJECT_ADAPTERS = [{ provide: ports_1.PROJECT_REPOSITORY, useClass: typeorm_project_repository_1.TypeOrmProjectRepository }];
/**
 * The controller lives here and serves both modules' routes, because a contract is not a
 * resource of its own: it is always "the contract *of* this project", and splitting the routes
 * would put `/projects/:id/spec-versions` in a module that knows nothing about projects.
 */
let ProjectsModule = class ProjectsModule {
};
exports.ProjectsModule = ProjectsModule;
exports.ProjectsModule = ProjectsModule = __decorate([
    (0, common_1.Module)({
        imports: [cqrs_1.CqrsModule, typeorm_1.TypeOrmModule.forFeature([entities_1.ProjectEntity]), (0, common_1.forwardRef)(() => specs_module_1.SpecsModule), auth_module_1.AuthModule, iam_module_1.IamModule],
        controllers: [projects_controller_1.ProjectsController],
        providers: [...exports.PROJECT_ADAPTERS, ...exports.PROJECT_COMMAND_HANDLERS, ...exports.PROJECT_QUERY_HANDLERS],
        exports: [ports_1.PROJECT_REPOSITORY],
    })
], ProjectsModule);
//# sourceMappingURL=projects.module.js.map