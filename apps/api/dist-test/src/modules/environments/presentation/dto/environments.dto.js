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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CredentialDto = exports.EnvironmentDto = void 0;
const class_validator_1 = require("class-validator");
const model_1 = require("../../domain/model");
class EnvironmentDto {
    name;
    baseUrl;
    specUrl;
    variables;
    writesAllowed;
    authEnforced;
}
exports.EnvironmentDto = EnvironmentDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(80),
    __metadata("design:type", String)
], EnvironmentDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], EnvironmentDto.prototype, "baseUrl", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", Object)
], EnvironmentDto.prototype, "specUrl", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], EnvironmentDto.prototype, "variables", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], EnvironmentDto.prototype, "writesAllowed", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], EnvironmentDto.prototype, "authEnforced", void 0);
class CredentialDto {
    name;
    role;
    kind;
    headerName;
    /** Write-only. It is encrypted on arrival and no query ever returns it, in any form. */
    secret;
    scopes;
}
exports.CredentialDto = CredentialDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(80),
    __metadata("design:type", String)
], CredentialDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsIn)(model_1.CREDENTIAL_ROLES, { message: `role debe ser uno de: ${model_1.CREDENTIAL_ROLES.join(", ")}` }),
    __metadata("design:type", String)
], CredentialDto.prototype, "role", void 0);
__decorate([
    (0, class_validator_1.IsIn)(model_1.CREDENTIAL_KINDS, { message: `kind debe ser uno de: ${model_1.CREDENTIAL_KINDS.join(", ")}` }),
    __metadata("design:type", String)
], CredentialDto.prototype, "kind", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(80),
    __metadata("design:type", Object)
], CredentialDto.prototype, "headerName", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(4000),
    __metadata("design:type", String)
], CredentialDto.prototype, "secret", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Array)
], CredentialDto.prototype, "scopes", void 0);
//# sourceMappingURL=environments.dto.js.map