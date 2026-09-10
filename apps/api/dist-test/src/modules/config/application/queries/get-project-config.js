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
exports.GetProjectConfigHandler = exports.GetProjectConfigQuery = void 0;
exports.assembleProjectConfig = assembleProjectConfig;
exports.defaultsFor = defaultsFor;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const runner_core_1 = require("@eq/runner-core");
const ports_1 = require("../../../projects/domain/ports");
const update_project_1 = require("../../../projects/application/commands/update-project");
const ports_2 = require("../../domain/ports");
class GetProjectConfigQuery {
    organizationId;
    projectId;
    constructor(organizationId, projectId) {
        this.organizationId = organizationId;
        this.projectId = projectId;
    }
}
exports.GetProjectConfigQuery = GetProjectConfigQuery;
/**
 * Assembles the stored sections into the object the engine consumes.
 *
 * **A missing section is not an error and not an empty matrix**: it falls back to
 * `DEFAULT_CONFIG`, which is almost empty on purpose. A brand-new project generates the cases
 * that follow from the contract alone — the 401/403 matrix from declared statuses, the 404 of a
 * detail GET, the create-and-read-back of a POST — and nothing that depends on knowing the
 * domain. It gets richer as somebody fills in the fixtures, and never pretends to know an EAN
 * nobody told it about.
 *
 * Exported as a function rather than living inside the handler because the scenarios query and
 * the run engine both need it, and two assemblies of the same rows would eventually disagree
 * about a default.
 */
async function assembleProjectConfig(config, projectId) {
    const stored = await config.listSections(projectId);
    const merged = stored.reduce((accumulator, row) => ({ ...accumulator, ...row.data }), {});
    // `defineProjectConfig` fills the gaps and merges the text bundle key by key, so a project that
    // reworded one case does not have to restate the other thirty.
    return (0, runner_core_1.defineProjectConfig)(merged);
}
/**
 * The configuration as an editor sees it: every section, with whether anybody has set it.
 *
 * `configured` matters more than it looks. Without it the UI cannot tell "this project uses the
 * default samples" from "somebody deliberately set the samples to the same thing as the
 * default", and the first is a prompt to fill something in while the second is a decision.
 */
let GetProjectConfigHandler = class GetProjectConfigHandler {
    projects;
    config;
    constructor(projects, config) {
        this.projects = projects;
        this.config = config;
    }
    async execute(query) {
        const project = await (0, update_project_1.ownedProject)(this.projects, query.organizationId, query.projectId);
        const stored = new Map((await this.config.listSections(project.id)).map((row) => [row.section, row]));
        const sections = Object.fromEntries(runner_core_1.CONFIG_SECTIONS.map((section) => {
            const row = stored.get(section);
            return [section, { data: row?.data ?? defaultsFor(section), configured: Boolean(row), updatedAt: row?.updatedAt ?? null }];
        }));
        return { sections };
    }
};
exports.GetProjectConfigHandler = GetProjectConfigHandler;
exports.GetProjectConfigHandler = GetProjectConfigHandler = __decorate([
    (0, cqrs_1.QueryHandler)(GetProjectConfigQuery),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.CONFIG_REPOSITORY)),
    __metadata("design:paramtypes", [Object, Object])
], GetProjectConfigHandler);
/** The slice of `DEFAULT_CONFIG` a section covers, so an unset section renders as what the
 * engine will actually use rather than as a blank form. */
function defaultsFor(section) {
    const defaults = runner_core_1.DEFAULT_CONFIG;
    switch (section) {
        case "parameters":
            return {
                parameterSamples: defaults.parameterSamples,
                fallbackSamples: defaults.fallbackSamples,
                excludeFromSoloScenarios: defaults.excludeFromSoloScenarios,
                pathDefaults: defaults.pathDefaults,
                fallbackPathValue: defaults.fallbackPathValue,
                missingIdValue: defaults.missingIdValue,
            };
        case "scenarios":
            return {
                conditionalScenarios: defaults.conditionalScenarios,
                operationOverrides: defaults.operationOverrides,
                listOperations: defaults.listOperations,
                bulkOperationIdPrefix: defaults.bulkOperationIdPrefix,
            };
        case "bodies":
            return { bodyTemplates: defaults.bodyTemplates };
        case "authorization":
            return { authRules: defaults.authRules, authExcludedOperationIds: defaults.authExcludedOperationIds, scopes: defaults.scopes };
        case "budgets":
            return { budgets: defaults.budgets };
        case "envelope":
            return { envelope: defaults.envelope };
        case "implemented":
            return { implemented: defaults.implemented };
        case "text":
            // The bundle is returned whole rather than as the empty override object that is actually
            // stored: an editor needs to see the strings to change one of them.
            return { locale: defaults.locale, text: runner_core_1.bundles[defaults.locale] };
    }
}
//# sourceMappingURL=get-project-config.js.map