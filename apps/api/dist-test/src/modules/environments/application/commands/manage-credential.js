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
exports.DeleteCredentialHandler = exports.UpsertCredentialHandler = exports.DeleteCredentialCommand = exports.UpsertCredentialCommand = void 0;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const clock_port_1 = require("../../../../shared/clock/clock.port");
const secret_cipher_1 = require("../../../../shared/crypto/secret-cipher");
const ports_1 = require("../../../projects/domain/ports");
const ports_2 = require("../../domain/ports");
const manage_environment_1 = require("./manage-environment");
class UpsertCredentialCommand {
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
exports.UpsertCredentialCommand = UpsertCredentialCommand;
class DeleteCredentialCommand {
    organizationId;
    projectId;
    environmentId;
    role;
    constructor(organizationId, projectId, environmentId, role) {
        this.organizationId = organizationId;
        this.projectId = projectId;
        this.environmentId = environmentId;
        this.role = role;
    }
}
exports.DeleteCredentialCommand = DeleteCredentialCommand;
/**
 * Stores a credential for a target, encrypted.
 *
 * Encrypted and not hashed, because unlike a password this has to be replayed on every request
 * the runner makes. AES-256-GCM so a tampered ciphertext fails to decrypt rather than decrypting
 * to garbage that then goes out as an `Authorization` header.
 *
 * One credential per role per environment, upserted: the generator asks for "the insufficient
 * one", and two rows answering to that would make which token a 403 case sends depend on row
 * order.
 */
let UpsertCredentialHandler = class UpsertCredentialHandler {
    projects;
    environments;
    cipher;
    clock;
    constructor(projects, environments, cipher, clock) {
        this.projects = projects;
        this.environments = environments;
        this.cipher = cipher;
        this.clock = clock;
    }
    async execute(command) {
        const environment = await (0, manage_environment_1.ownedEnvironment)(this.projects, this.environments, command.organizationId, command.projectId, command.environmentId);
        if (!command.input.secret)
            throw new domain_error_1.InvalidInputError("Falta el secreto", [{ field: "secret", detail: "Requerido" }]);
        if (command.input.kind === "api_key" && !command.input.headerName) {
            // Bearer and Basic imply `Authorization`; an API key is whatever the target calls it, and
            // guessing `X-API-Key` for a target that expects something else produces a 401 that looks
            // like a finding about the endpoint.
            throw new domain_error_1.InvalidInputError("Una API key necesita el nombre de su cabecera", [{ field: "headerName", detail: "Requerido para kind api_key" }]);
        }
        const now = this.clock.now();
        const existing = await this.environments.findCredential(environment.id, command.input.role);
        const credential = {
            id: existing?.id ?? (0, node_crypto_1.randomUUID)(),
            environmentId: environment.id,
            name: command.input.name.trim() || command.input.role,
            role: command.input.role,
            kind: command.input.kind,
            headerName: command.input.headerName ?? null,
            secretCiphertext: this.cipher.encrypt(command.input.secret),
            scopes: command.input.scopes ?? [],
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        await this.environments.saveCredential(credential);
        return { credentialId: credential.id };
    }
};
exports.UpsertCredentialHandler = UpsertCredentialHandler;
exports.UpsertCredentialHandler = UpsertCredentialHandler = __decorate([
    (0, cqrs_1.CommandHandler)(UpsertCredentialCommand),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.ENVIRONMENT_REPOSITORY)),
    __param(2, (0, common_1.Inject)(secret_cipher_1.SECRET_CIPHER)),
    __param(3, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __metadata("design:paramtypes", [Object, Object, Object, Object])
], UpsertCredentialHandler);
let DeleteCredentialHandler = class DeleteCredentialHandler {
    projects;
    environments;
    constructor(projects, environments) {
        this.projects = projects;
        this.environments = environments;
    }
    async execute(command) {
        const environment = await (0, manage_environment_1.ownedEnvironment)(this.projects, this.environments, command.organizationId, command.projectId, command.environmentId);
        // Idempotent: deleting a credential that is already gone is the same outcome the caller
        // wanted, and reporting 404 for it only invites a retry loop.
        await this.environments.removeCredential(environment.id, command.role);
    }
};
exports.DeleteCredentialHandler = DeleteCredentialHandler;
exports.DeleteCredentialHandler = DeleteCredentialHandler = __decorate([
    (0, cqrs_1.CommandHandler)(DeleteCredentialCommand),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.ENVIRONMENT_REPOSITORY)),
    __metadata("design:paramtypes", [Object, Object])
], DeleteCredentialHandler);
//# sourceMappingURL=manage-credential.js.map