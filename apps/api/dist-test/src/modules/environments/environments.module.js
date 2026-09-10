"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnvironmentsModule = exports.ENVIRONMENT_ADAPTERS = exports.ENVIRONMENT_QUERY_HANDLERS = exports.ENVIRONMENT_COMMAND_HANDLERS = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const typeorm_1 = require("@nestjs/typeorm");
const entities_1 = require("../../shared/database/entities");
const secret_cipher_1 = require("../../shared/crypto/secret-cipher");
const secret_cipher_provider_1 = require("../../shared/crypto/secret-cipher.provider");
const projects_module_1 = require("../projects/projects.module");
const specs_module_1 = require("../specs/specs.module");
const ports_1 = require("./domain/ports");
const typeorm_environment_repository_1 = require("./infrastructure/persistence/typeorm-environment.repository");
const manage_environment_1 = require("./application/commands/manage-environment");
const manage_credential_1 = require("./application/commands/manage-credential");
const list_environments_1 = require("./application/queries/list-environments");
const ports_2 = require("../config/domain/ports");
const typeorm_config_repository_1 = require("../config/infrastructure/persistence/typeorm-config.repository");
const upsert_config_section_1 = require("../config/application/commands/upsert-config-section");
const get_project_config_1 = require("../config/application/queries/get-project-config");
const get_scenarios_1 = require("../config/application/queries/get-scenarios");
const environments_controller_1 = require("./presentation/environments.controller");
exports.ENVIRONMENT_COMMAND_HANDLERS = [
    manage_environment_1.CreateEnvironmentHandler, manage_environment_1.UpdateEnvironmentHandler, manage_environment_1.DeleteEnvironmentHandler,
    manage_credential_1.UpsertCredentialHandler, manage_credential_1.DeleteCredentialHandler,
    upsert_config_section_1.UpsertConfigSectionHandler, upsert_config_section_1.ResetConfigSectionHandler,
];
exports.ENVIRONMENT_QUERY_HANDLERS = [list_environments_1.ListEnvironmentsHandler, get_project_config_1.GetProjectConfigHandler, get_scenarios_1.GetScenariosHandler];
exports.ENVIRONMENT_ADAPTERS = [
    { provide: ports_1.ENVIRONMENT_REPOSITORY, useClass: typeorm_environment_repository_1.TypeOrmEnvironmentRepository },
    { provide: ports_2.CONFIG_REPOSITORY, useClass: typeorm_config_repository_1.TypeOrmConfigRepository },
    { provide: secret_cipher_1.SECRET_CIPHER, useClass: secret_cipher_provider_1.SecretCipherProvider },
];
/**
 * Environments and configuration ship together because the matrix needs both: the contract says
 * what could be tested, the configuration says with which values, and the environment says which
 * of it may actually run tonight. Splitting them would put `GET /scenarios` in a module that
 * knows only one of the three.
 */
let EnvironmentsModule = class EnvironmentsModule {
};
exports.EnvironmentsModule = EnvironmentsModule;
exports.EnvironmentsModule = EnvironmentsModule = __decorate([
    (0, common_1.Module)({
        imports: [
            cqrs_1.CqrsModule,
            typeorm_1.TypeOrmModule.forFeature([entities_1.EnvironmentEntity, entities_1.EnvironmentCredentialEntity, entities_1.ProjectConfigEntity]),
            (0, common_1.forwardRef)(() => projects_module_1.ProjectsModule),
            (0, common_1.forwardRef)(() => specs_module_1.SpecsModule),
        ],
        controllers: [environments_controller_1.EnvironmentsController],
        providers: [...exports.ENVIRONMENT_ADAPTERS, ...exports.ENVIRONMENT_COMMAND_HANDLERS, ...exports.ENVIRONMENT_QUERY_HANDLERS],
        exports: [ports_1.ENVIRONMENT_REPOSITORY, ports_2.CONFIG_REPOSITORY, secret_cipher_1.SECRET_CIPHER],
    })
], EnvironmentsModule);
//# sourceMappingURL=environments.module.js.map