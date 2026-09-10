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
exports.AcceptInvitationDto = exports.ChangeRoleDto = exports.InviteMemberDto = exports.CreateOrganizationDto = void 0;
const class_validator_1 = require("class-validator");
const model_1 = require("../../domain/model");
class CreateOrganizationDto {
    name;
}
exports.CreateOrganizationDto = CreateOrganizationDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(200),
    __metadata("design:type", String)
], CreateOrganizationDto.prototype, "name", void 0);
class InviteMemberDto {
    email;
    role;
}
exports.InviteMemberDto = InviteMemberDto;
__decorate([
    (0, class_validator_1.IsEmail)({}, { message: "email debe ser una dirección válida" }),
    (0, class_validator_1.MaxLength)(320),
    __metadata("design:type", String)
], InviteMemberDto.prototype, "email", void 0);
__decorate([
    (0, class_validator_1.IsIn)(model_1.ROLES, { message: `role debe ser uno de: ${model_1.ROLES.join(", ")}` }),
    __metadata("design:type", String)
], InviteMemberDto.prototype, "role", void 0);
class ChangeRoleDto {
    role;
}
exports.ChangeRoleDto = ChangeRoleDto;
__decorate([
    (0, class_validator_1.IsIn)(model_1.ROLES, { message: `role debe ser uno de: ${model_1.ROLES.join(", ")}` }),
    __metadata("design:type", String)
], ChangeRoleDto.prototype, "role", void 0);
class AcceptInvitationDto {
    token;
}
exports.AcceptInvitationDto = AcceptInvitationDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(200),
    __metadata("design:type", String)
], AcceptInvitationDto.prototype, "token", void 0);
//# sourceMappingURL=iam.dto.js.map