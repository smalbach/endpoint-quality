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
exports.TypeOrmRunRepository = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const entities_1 = require("../../../../shared/database/entities");
let TypeOrmRunRepository = class TypeOrmRunRepository {
    runs;
    cases;
    steps;
    constructor(runs, cases, steps) {
        this.runs = runs;
        this.cases = cases;
        this.steps = steps;
    }
    async findById(id) {
        return toRun(await this.runs.findOne({ where: { id } }));
    }
    async listForProject(projectId, limit) {
        return (await this.runs.find({ where: { projectId }, order: { startedAt: "DESC" }, take: limit })).map((row) => toRun(row));
    }
    async save(run) {
        await this.runs.save(run);
    }
    async saveCases(cases) {
        // Chunked: a 311-case matrix in one statement is fine, a contract with thousands of
        // operations is not, and the driver's parameter limit is not a number worth discovering in
        // production.
        if (cases.length)
            await this.cases.save(cases, { chunk: 200 });
    }
    async listCases(runId) {
        return (await this.cases.find({ where: { runId }, order: { position: "ASC" } })).map(toCase);
    }
    async findCase(id) {
        const row = await this.cases.findOne({ where: { id } });
        return row ? toCase(row) : null;
    }
    async saveCase(runCase) {
        await this.cases.save(runCase);
    }
    async saveSteps(steps) {
        if (steps.length)
            await this.steps.save(steps, { chunk: 100 });
    }
    async listSteps(runCaseId) {
        return (await this.steps.find({ where: { runCaseId }, order: { index: "ASC" } })).map((row) => ({ ...row }));
    }
    /**
     * Counted in SQL, from the case rows.
     *
     * Not incremented in memory: a worker that restarts mid-run would lose the count, and two
     * workers would each add one. The rows are the truth and this reads them.
     */
    async recomputeTotals(runId) {
        const rows = await this.cases
            .createQueryBuilder("c")
            .select("c.status", "status")
            .addSelect("COUNT(*)", "count")
            .where("c.runId = :runId", { runId })
            .groupBy("c.status")
            .getRawMany();
        const by = (status) => Number(rows.find((row) => row.status === status)?.count ?? 0);
        const totals = {
            cases: rows.reduce((sum, row) => sum + Number(row.count), 0),
            passed: by("passed"),
            failed: by("failed"),
            skipped: by("skipped"),
            completed: by("passed") + by("failed") + by("skipped"),
        };
        await this.runs.update({ id: runId }, { totals });
        return totals;
    }
    async updateStatus(runId, status, at, error) {
        const finished = ["passed", "failed", "cancelled", "error"].includes(status);
        await this.runs.update({ id: runId }, { status, ...(finished ? { finishedAt: at } : {}), ...(error ? { error } : {}) });
    }
};
exports.TypeOrmRunRepository = TypeOrmRunRepository;
exports.TypeOrmRunRepository = TypeOrmRunRepository = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(entities_1.RunEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(entities_1.RunCaseEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(entities_1.RunStepEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository])
], TypeOrmRunRepository);
function toRun(row) {
    return row
        ? { ...row, status: row.status, plan: row.plan, totals: row.totals, triggeredByKind: row.triggeredByKind }
        : null;
}
const toCase = (row) => ({ ...row, status: row.status });
//# sourceMappingURL=typeorm-run.repository.js.map