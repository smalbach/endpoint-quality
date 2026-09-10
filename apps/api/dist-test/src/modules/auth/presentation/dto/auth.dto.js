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
exports.CreateApiTokenDto = exports.ChangePasswordDto = exports.LogoutDto = exports.RefreshDto = exports.LoginDto = exports.RegisterDto = void 0;
const class_validator_1 = require("class-validator");
/**
 * The request bodies, validated before a handler sees them.
 *
 * `MaxLength` on the password is not a strength rule — it is a denial-of-service guard. The KDF
 * is memory-hard by design, so an unbounded password is an unbounded amount of work per login
 * attempt, and the attempt does not need to succeed to cost it.
 */
class RegisterDto {
    email;
    password;
    name;
    organizationName;
}
exports.RegisterDto = RegisterDto;
__decorate([
    (0, class_validator_1.IsEmail)({}, { message: "email debe ser una dirección válida" }),
    (0, class_validator_1.MaxLength)(320),
    __metadata("design:type", String)
], RegisterDto.prototype, "email", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(12, { message: "password debe tener al menos 12 caracteres" }),
    (0, class_validator_1.MaxLength)(200, { message: "password no puede superar los 200 caracteres" }),
    __metadata("design:type", String)
], RegisterDto.prototype, "password", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(200),
    __metadata("design:type", String)
], RegisterDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(200),
    __metadata("design:type", String)
], RegisterDto.prototype, "organizationName", void 0);
class LoginDto {
    email;
    password;
}
exports.LoginDto = LoginDto;
__decorate([
    (0, class_validator_1.IsEmail)({}, { message: "email debe ser una dirección válida" }),
    (0, class_validator_1.MaxLength)(320),
    __metadata("design:type", String)
], LoginDto.prototype, "email", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(200),
    __metadata("design:type", String)
], LoginDto.prototype, "password", void 0);
class RefreshDto {
    /** Optional in the body because the browser sends it as an httpOnly cookie; a CLI or a test
     * has no cookie jar and sends it here. */
    refreshToken;
}
exports.RefreshDto = RefreshDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(200),
    __metadata("design:type", String)
], RefreshDto.prototype, "refreshToken", void 0);
class LogoutDto {
    refreshToken;
    everywhere;
}
exports.LogoutDto = LogoutDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(200),
    __metadata("design:type", String)
], LogoutDto.prototype, "refreshToken", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], LogoutDto.prototype, "everywhere", void 0);
class ChangePasswordDto {
    currentPassword;
    newPassword;
}
exports.ChangePasswordDto = ChangePasswordDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(200),
    __metadata("design:type", String)
], ChangePasswordDto.prototype, "currentPassword", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(12, { message: "newPassword debe tener al menos 12 caracteres" }),
    (0, class_validator_1.MaxLength)(200),
    __metadata("design:type", String)
], ChangePasswordDto.prototype, "newPassword", void 0);
class CreateApiTokenDto {
    name;
}
exports.CreateApiTokenDto = CreateApiTokenDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(120),
    __metadata("design:type", String)
], CreateApiTokenDto.prototype, "name", void 0);
//# sourceMappingURL=auth.dto.js.map