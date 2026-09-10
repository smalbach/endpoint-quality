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
exports.HealthController = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const auth_guard_1 = require("../modules/auth/infrastructure/guards/auth.guard");
/**
 * The probe, shaped like the ones this product asserts against.
 *
 * It answers 200 while it can serve traffic and 503 when it cannot, and it actually **queries
 * the database** rather than reporting that the process is running. A health check that always
 * says `ok` is the same hardcoded `pass: true` this whole product was built to replace.
 */
let HealthController = class HealthController {
    dataSource;
    constructor(dataSource) {
        this.dataSource = dataSource;
    }
    async check() {
        const started = Date.now();
        let database;
        try {
            await this.dataSource.query("SELECT 1");
            database = { status: "up", latencyMs: Date.now() - started };
        }
        catch (error) {
            database = { status: "down", error: error instanceof Error ? error.message : "sin detalle" };
        }
        const status = database.status === "up" ? "ok" : "down";
        return { status, checks: { database } };
    }
};
exports.HealthController = HealthController;
__decorate([
    (0, auth_guard_1.Public)(),
    (0, common_1.Get)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], HealthController.prototype, "check", null);
exports.HealthController = HealthController = __decorate([
    (0, common_1.Controller)("health"),
    __param(0, (0, typeorm_1.InjectDataSource)()),
    __metadata("design:paramtypes", [typeorm_2.DataSource])
], HealthController);
//# sourceMappingURL=health.controller.js.map