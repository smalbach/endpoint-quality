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
exports.DeleteEnvironmentHandler = exports.UpdateEnvironmentHandler = exports.CreateEnvironmentHandler = exports.DeleteEnvironmentCommand = exports.UpdateEnvironmentCommand = exports.CreateEnvironmentCommand = void 0;
exports.ownedEnvironment = ownedEnvironment;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const clock_port_1 = require("../../../../shared/clock/clock.port");
const ports_1 = require("../../../projects/domain/ports");
const update_project_1 = require("../../../projects/application/commands/update-project");
const ports_2 = require("../../domain/ports");
class CreateEnvironmentCommand {
    organizationId;
    projectId;
    input;
    constructor(organizationId, projectId, input) {
        this.organizationId = organizationId;
        this.projectId = projectId;
        this.input = input;
    }
}
exports.CreateEnvironmentCommand = CreateEnvironmentCommand;
class UpdateEnvironmentCommand {
    organizationId;
    projectId;
    environmentId;
    input;
    constructor(organizationId, projectId, environmentId, input) {
        this.organizationId = organizationId;
        this.projectId = projectId;
        this.environmentId = environmentId;
        this.input = input;
    }
}
exports.UpdateEnvironmentCommand = UpdateEnvironmentCommand;
class DeleteEnvironmentCommand {
    organizationId;
    projectId;
    environmentId;
    constructor(organizationId, projectId, environmentId) {
        this.organizationId = organizationId;
        this.projectId = projectId;
        this.environmentId = environmentId;
    }
}
exports.DeleteEnvironmentCommand = DeleteEnvironmentCommand;
/** Loads an environment and refuses to admit it exists outside its project. Folded into the 404
 * for the same reason as everywhere else: a 403 would confirm the id is real. */
async function ownedEnvironment(projects, environments, organizationId, projectId, environmentId) {
    await (0, update_project_1.ownedProject)(projects, organizationId, projectId);
    const environment = await environments.findById(environmentId);
    if (!environment || environment.projectId !== projectId)
        throw new domain_error_1.NotFoundError("El entorno no existe", "environment-not-found");
    return environment;
}
/** A base URL has to be absolute and http(s). The SSRF guard checks the address at request time;
 * this rejects the shape at write time so the mistake surfaces where it was made. */
function normalizeBaseUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new domain_error_1.InvalidInputError("La URL base no es válida", [{ field: "baseUrl", detail: "Debe ser una URL absoluta" }]);
    }
    if (!["http:", "https:"].includes(url.protocol)) {
        throw new domain_error_1.InvalidInputError("La URL base no es válida", [{ field: "baseUrl", detail: "Solo se admiten http y https" }]);
    }
    // Trailing slash removed once, here, so every path join downstream is `${baseUrl}${path}` and
    // nothing has to guess whether it will produce a double slash.
    return url.toString().replace(/\/+$/, "");
}
let CreateEnvironmentHandler = class CreateEnvironmentHandler {
    projects;
    environments;
    clock;
    constructor(projects, environments, clock) {
        this.projects = projects;
        this.environments = environments;
        this.clock = clock;
    }
    async execute(command) {
        const project = await (0, update_project_1.ownedProject)(this.projects, command.organizationId, command.projectId);
        const name = (command.input.name ?? "").trim();
        if (!name)
            throw new domain_error_1.InvalidInputError("El entorno necesita un nombre", [{ field: "name", detail: "Requerido" }]);
        if (await this.environments.findByName(project.id, name))
            throw new domain_error_1.ConflictError("Ya hay un entorno con ese nombre", "environment-name-taken");
        const environment = {
            id: (0, node_crypto_1.randomUUID)(),
            projectId: project.id,
            name,
            baseUrl: normalizeBaseUrl(command.input.baseUrl ?? ""),
            specUrl: command.input.specUrl ?? null,
            variables: command.input.variables ?? {},
            // Both default to off. A run that writes to a target, and a matrix of 401 cases against a
            // backend that grants everything, are each a decision — not something inherited by
            // creating an environment.
            writesAllowed: command.input.writesAllowed ?? false,
            authEnforced: command.input.authEnforced ?? false,
            createdAt: this.clock.now(),
        };
        await this.environments.save(environment);
        return { environmentId: environment.id };
    }
};
exports.CreateEnvironmentHandler = CreateEnvironmentHandler;
exports.CreateEnvironmentHandler = CreateEnvironmentHandler = __decorate([
    (0, cqrs_1.CommandHandler)(CreateEnvironmentCommand),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.ENVIRONMENT_REPOSITORY)),
    __param(2, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __metadata("design:paramtypes", [Object, Object, Object])
], CreateEnvironmentHandler);
let UpdateEnvironmentHandler = class UpdateEnvironmentHandler {
    projects;
    environments;
    constructor(projects, environments) {
        this.projects = projects;
        this.environments = environments;
    }
    async execute(command) {
        const environment = await ownedEnvironment(this.projects, this.environments, command.organizationId, command.projectId, command.environmentId);
        const name = command.input.name?.trim();
        if (name && name !== environment.name && (await this.environments.findByName(environment.projectId, name))) {
            throw new domain_error_1.ConflictError("Ya hay un entorno con ese nombre", "environment-name-taken");
        }
        await this.environments.save({
            ...environment,
            name: name || environment.name,
            baseUrl: command.input.baseUrl ? normalizeBaseUrl(command.input.baseUrl) : environment.baseUrl,
            specUrl: command.input.specUrl === undefined ? environment.specUrl : command.input.specUrl,
            variables: command.input.variables ?? environment.variables,
            writesAllowed: command.input.writesAllowed ?? environment.writesAllowed,
            authEnforced: command.input.authEnforced ?? environment.authEnforced,
        });
    }
};
exports.UpdateEnvironmentHandler = UpdateEnvironmentHandler;
exports.UpdateEnvironmentHandler = UpdateEnvironmentHandler = __decorate([
    (0, cqrs_1.CommandHandler)(UpdateEnvironmentCommand),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.ENVIRONMENT_REPOSITORY)),
    __metadata("design:paramtypes", [Object, Object])
], UpdateEnvironmentHandler);
let DeleteEnvironmentHandler = class DeleteEnvironmentHandler {
    projects;
    environments;
    constructor(projects, environments) {
        this.projects = projects;
        this.environments = environments;
    }
    async execute(command) {
        const environment = await ownedEnvironment(this.projects, this.environments, command.organizationId, command.projectId, command.environmentId);
        // The credentials go with it, by the cascade in the migration. Deleting an environment and
        // leaving its stored secrets behind would be a set of credentials nothing can reach to
        // revoke.
        await this.environments.remove(environment.id);
    }
};
exports.DeleteEnvironmentHandler = DeleteEnvironmentHandler;
exports.DeleteEnvironmentHandler = DeleteEnvironmentHandler = __decorate([
    (0, cqrs_1.CommandHandler)(DeleteEnvironmentCommand),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.ENVIRONMENT_REPOSITORY)),
    __metadata("design:paramtypes", [Object, Object])
], DeleteEnvironmentHandler);
//# sourceMappingURL=manage-environment.js.map