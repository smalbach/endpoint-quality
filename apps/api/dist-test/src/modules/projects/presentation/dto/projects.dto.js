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
exports.ImportSpecDto = exports.SpecSourceDto = exports.ArchiveProjectDto = exports.UpdateProjectDto = exports.CreateProjectDto = void 0;
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const body_limits_1 = require("../../../../shared/http/body-limits");
class CreateProjectDto {
    name;
    description;
}
exports.CreateProjectDto = CreateProjectDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(200),
    __metadata("design:type", String)
], CreateProjectDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], CreateProjectDto.prototype, "description", void 0);
class UpdateProjectDto {
    name;
    description;
}
exports.UpdateProjectDto = UpdateProjectDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(200),
    __metadata("design:type", String)
], UpdateProjectDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], UpdateProjectDto.prototype, "description", void 0);
class ArchiveProjectDto {
    archived;
}
exports.ArchiveProjectDto = ArchiveProjectDto;
__decorate([
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], ArchiveProjectDto.prototype, "archived", void 0);
/**
 * Where a contract comes from.
 *
 * The size cap on `raw` is a real limit and not a formality: the document is stored, parsed and
 * held in memory, and an unbounded upload is a denial of service that needs no cleverness.
 * 8 MB is roughly seventy times Digital Catalog's 118 KB contract.
 */
class SpecSourceDto {
    kind;
    url;
    raw;
    filename;
    /** Headers for a contract behind authentication. Sent, never stored — P3 adds the encrypted
     * store for them alongside the target credentials. */
    headers;
}
exports.SpecSourceDto = SpecSourceDto;
__decorate([
    (0, class_validator_1.IsIn)(["url", "inline", "upload"]),
    __metadata("design:type", String)
], SpecSourceDto.prototype, "kind", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsUrl)({ require_tld: false, protocols: ["http", "https"] }, { message: "url debe ser una dirección http o https" }),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], SpecSourceDto.prototype, "url", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(body_limits_1.MAX_SPEC_BYTES, { message: "el documento supera los 8 MB" }),
    __metadata("design:type", String)
], SpecSourceDto.prototype, "raw", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(300),
    __metadata("design:type", String)
], SpecSourceDto.prototype, "filename", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], SpecSourceDto.prototype, "headers", void 0);
class ImportSpecDto {
    source;
    /** Absent means activate, which is what importing usually means. A drift check passes false. */
    activate;
}
exports.ImportSpecDto = ImportSpecDto;
__decorate([
    (0, class_validator_1.ValidateNested)(),
    (0, class_transformer_1.Type)(() => SpecSourceDto),
    __metadata("design:type", SpecSourceDto)
], ImportSpecDto.prototype, "source", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], ImportSpecDto.prototype, "activate", void 0);
//# sourceMappingURL=projects.dto.js.map