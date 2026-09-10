"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpecsModule = exports.SPEC_ADAPTERS = exports.SPEC_QUERY_HANDLERS = exports.SPEC_COMMAND_HANDLERS = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const typeorm_1 = require("@nestjs/typeorm");
const entities_1 = require("../../shared/database/entities");
const safe_fetch_1 = require("../../shared/http/safe-fetch");
const safe_fetch_provider_1 = require("../../shared/http/safe-fetch.provider");
const projects_module_1 = require("../projects/projects.module");
const ports_1 = require("./domain/ports");
const typeorm_spec_repository_1 = require("./infrastructure/persistence/typeorm-spec.repository");
const import_spec_version_1 = require("./application/commands/import-spec-version");
const activate_spec_version_1 = require("./application/commands/activate-spec-version");
const check_spec_drift_1 = require("./application/commands/check-spec-drift");
const get_operations_1 = require("./application/queries/get-operations");
exports.SPEC_COMMAND_HANDLERS = [import_spec_version_1.ImportSpecVersionHandler, activate_spec_version_1.ActivateSpecVersionHandler, check_spec_drift_1.CheckSpecDriftHandler];
exports.SPEC_QUERY_HANDLERS = [get_operations_1.GetOperationsHandler, get_operations_1.ListSpecVersionsHandler];
exports.SPEC_ADAPTERS = [
    { provide: ports_1.SPEC_REPOSITORY, useClass: typeorm_spec_repository_1.TypeOrmSpecRepository },
    // The one place the SSRF policy is read. A second call site building its own policy object
    // would be a second chance to leave `allowPrivateTargets` on.
    { provide: safe_fetch_1.SAFE_FETCH, useClass: safe_fetch_provider_1.ConfiguredSafeFetch },
];
let SpecsModule = class SpecsModule {
};
exports.SpecsModule = SpecsModule;
exports.SpecsModule = SpecsModule = __decorate([
    (0, common_1.Module)({
        imports: [cqrs_1.CqrsModule, typeorm_1.TypeOrmModule.forFeature([entities_1.SpecVersionEntity, entities_1.SpecOperationEntity, entities_1.SpecSourceEntity]), (0, common_1.forwardRef)(() => projects_module_1.ProjectsModule)],
        providers: [...exports.SPEC_ADAPTERS, ...exports.SPEC_COMMAND_HANDLERS, ...exports.SPEC_QUERY_HANDLERS],
        exports: [ports_1.SPEC_REPOSITORY, safe_fetch_1.SAFE_FETCH],
    })
], SpecsModule);
//# sourceMappingURL=specs.module.js.map