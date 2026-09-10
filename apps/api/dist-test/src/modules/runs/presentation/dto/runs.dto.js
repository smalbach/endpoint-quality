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
exports.StartRunDto = void 0;
const class_validator_1 = require("class-validator");
class StartRunDto {
    environmentId;
    order;
    customOrder;
    /** Empty or absent means the whole contract. A subset button that silently means everything is
     * how a 46-operation write run gets started by accident. */
    operationIds;
    caseSelection;
    /** One sample is a measurement, not a percentile — the latency assertion says so. Capped at 50
     * so a matrix cannot turn into a load test by accident. */
    samples;
    /** Some targets rate-limit, and 311 cases fired flat out are indistinguishable from an attack. */
    delayMs;
}
exports.StartRunDto = StartRunDto;
__decorate([
    (0, class_validator_1.IsUUID)(),
    __metadata("design:type", String)
], StartRunDto.prototype, "environmentId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(["safe", "contract", "custom"]),
    __metadata("design:type", String)
], StartRunDto.prototype, "order", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    __metadata("design:type", Array)
], StartRunDto.prototype, "customOrder", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    __metadata("design:type", Array)
], StartRunDto.prototype, "operationIds", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], StartRunDto.prototype, "caseSelection", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(50),
    __metadata("design:type", Number)
], StartRunDto.prototype, "samples", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(0),
    (0, class_validator_1.Max)(30_000),
    __metadata("design:type", Number)
], StartRunDto.prototype, "delayMs", void 0);
//# sourceMappingURL=runs.dto.js.map